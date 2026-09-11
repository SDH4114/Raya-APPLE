import type { ToolExecutionPolicy } from "../types/tool.js";

type TelegramUpdate = {
  update_id: number;
  message?: { chat: { id: number }; from?: { id: number }; text?: string };
  callback_query?: { id: string; from: { id: number }; data?: string; message?: { chat: { id: number } } };
};

type TelegramResponse<T> = { ok: boolean; result: T };

type PendingApproval = { chatId: number; userId: number; resolve: (approved: boolean) => void; timer: NodeJS.Timeout };

export type TelegramService = { stop(): Promise<void>; sendMessage(chatId: string | number, text: string): Promise<void> };

export function splitTelegramMessage(text: string, maxChars = 4_000): string[] {
  if (!text) return [""];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    const newline = remaining.lastIndexOf("\n", maxChars);
    const cut = newline >= Math.floor(maxChars / 2) ? newline : maxChars;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n/, "");
  }
  chunks.push(remaining);
  return chunks;
}

export function startTelegramService(input: {
  token: string;
  allowedChatId?: string;
  onPrompt: (text: string, policy: ToolExecutionPolicy, signal: AbortSignal) => Promise<string>;
  onError?: (error: Error) => void;
  onStatus?: (status: "connected" | "disconnected", error?: Error) => void;
}): TelegramService {
  if (!input.token.trim()) throw new Error("Telegram bot token is required.");
  if (!input.allowedChatId) throw new Error("Telegram allowed chat ID is required. Run raya gateway --setup.");
  if (!/^-?\d+$/.test(input.allowedChatId)) throw new Error("Telegram allowed chat ID must be an integer.");
  let running = true;
  let offset = 0;
  let work = Promise.resolve();
  let retryDelayMs = 1_000;
  let connectionStatus: "connected" | "disconnected" = "connected";
  let pollAbort: AbortController | undefined;
  let retryWake: (() => void) | undefined;
  const serviceAbort = new AbortController();
  const pending = new Map<string, PendingApproval>();
  const api = `https://api.telegram.org/bot${input.token}`;

  async function call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const requestSignal = AbortSignal.any([serviceAbort.signal, ...(signal ? [signal] : []), AbortSignal.timeout(35_000)]);
    let response: Response;
    try {
      response = await fetch(`${api}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: requestSignal });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(message.replaceAll(input.token, "[REDACTED]"), { cause: error });
    }
    const json = await response.json().catch(() => undefined) as (TelegramResponse<T> & { description?: string }) | undefined;
    if (!response.ok) throw new Error(`Telegram ${method}: HTTP ${response.status}${json?.description ? ` ${json.description}` : ""}`);
    if (!json) throw new Error(`Telegram ${method}: invalid JSON response`);
    if (!json.ok) throw new Error(`Telegram ${method}: ${json.description ?? "request failed"}`);
    return json.result;
  }

  async function send(chatId: number, text: string, keyboard?: unknown): Promise<void> {
    const chunks = splitTelegramMessage(text);
    for (const [index, chunk] of chunks.entries()) {
      const isLast = index === chunks.length - 1;
      await call("sendMessage", { chat_id: chatId, text: chunk, ...(keyboard && isLast ? { reply_markup: keyboard } : {}) });
    }
  }

  function startTyping(chatId: number): () => void {
    let stopped = false;
    const update = async (): Promise<void> => {
      if (stopped) return;
      try { await call("sendChatAction", { chat_id: chatId, action: "typing" }); } catch { /* normal polling reports connectivity */ }
    };
    void update();
    const timer = setInterval(() => void update(), 4_000);
    return () => { stopped = true; clearInterval(timer); };
  }

  function approvalPolicy(chatId: number, userId: number): ToolExecutionPolicy {
    return {
      confirmDangerousAction: async (action, details) => new Promise<void>((resolve, reject) => {
        const id = crypto.randomUUID().slice(0, 12);
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Remote action approval timed out."));
        }, 5 * 60_000);
        pending.set(id, { chatId, userId, timer, resolve: (approved) => approved ? resolve() : reject(new Error("Remote action denied by user.")) });
        void send(chatId, `Approval required\nAction: ${action}\nDetails: ${details}`, { inline_keyboard: [[{ text: "Approve", callback_data: `raya:approve:${id}` }, { text: "Deny", callback_data: `raya:deny:${id}` }]] }).catch((error) => {
          if (pending.delete(id)) clearTimeout(timer);
          reject(error);
        });
      })
    };
  }

  async function handle(update: TelegramUpdate): Promise<void> {
    offset = update.update_id + 1;
    const callback = update.callback_query;
    if (callback?.data?.startsWith("raya:")) {
      const [, decision, id] = callback.data.split(":");
      const item = pending.get(id);
      if (item
        && callback.message?.chat.id === item.chatId
        && callback.from.id === item.userId
        && (decision === "approve" || decision === "deny")) {
        clearTimeout(item.timer); pending.delete(id); item.resolve(decision === "approve");
        await call("answerCallbackQuery", { callback_query_id: callback.id, text: decision === "approve" ? "Approved" : "Denied" });
      } else {
        await call("answerCallbackQuery", { callback_query_id: callback.id, text: "This approval is no longer valid." });
      }
      return;
    }
    const message = update.message;
    if (!message?.text) return;
    if (input.allowedChatId !== String(message.chat.id)) return;
    if (!message.from || !Number.isSafeInteger(message.from.id)) return;
    work = work.then(async () => {
      if (serviceAbort.signal.aborted) return;
      const stopTyping = startTyping(message.chat.id);
      try {
        const answer = await input.onPrompt(message.text!, approvalPolicy(message.chat.id, message.from!.id), serviceAbort.signal);
        if (serviceAbort.signal.aborted) return;
        await send(message.chat.id, answer || "Completed.");
      } finally {
        stopTyping();
      }
    }).catch(async (error: unknown) => {
      if (!running || serviceAbort.signal.aborted) return;
      const messageText = error instanceof Error ? error.message : String(error);
      input.onError?.(error instanceof Error ? error : new Error(messageText));
      try { await send(message!.chat.id, `Raya error: ${messageText}`); } catch { /* network error is reported by polling loop */ }
    });
  }

  const loop = (async () => {
    while (running) {
      try {
        pollAbort = new AbortController();
        const updates = await call<TelegramUpdate[]>("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] }, pollAbort.signal);
        retryDelayMs = 1_000;
        if (connectionStatus === "disconnected") {
          connectionStatus = "connected";
          input.onStatus?.("connected");
        }
        for (const update of updates) void handle(update);
      } catch (error) {
        if (!running) break;
        const normalized = error instanceof Error ? error : new Error(String(error));
        if (connectionStatus === "connected") {
          connectionStatus = "disconnected";
          input.onStatus?.("disconnected", normalized);
          input.onError?.(normalized);
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, retryDelayMs);
          retryWake = () => { clearTimeout(timer); resolve(); };
        });
        retryWake = undefined;
        retryDelayMs = Math.min(retryDelayMs * 2, 30_000);
      }
    }
  })();

  return {
    async stop() {
      if (!running) return;
      running = false;
      serviceAbort.abort();
      pollAbort?.abort();
      retryWake?.();
      for (const item of pending.values()) { clearTimeout(item.timer); item.resolve(false); }
      pending.clear();
      await loop;
      await work;
    },
    async sendMessage(chatId, text) {
      const numericChatId = Number(chatId);
      if (!Number.isSafeInteger(numericChatId)) throw new Error(`Invalid Telegram chat ID: ${chatId}`);
      await send(numericChatId, text);
    }
  };
}
