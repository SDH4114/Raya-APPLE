import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { loadConfig, updateConfig, type RayaConfig } from "../config/config.js";
import { readSecret } from "../config/secrets.js";
import { createRayaAgent } from "../agent/create-agent.js";
import { createProviderRuntime, getConfiguredModel, isProviderConfigured } from "../providers/runtime.js";
import { createSession, getOrCreateActiveSession, listSessions, saveSession, switchSession } from "../session/store.js";
import { cancelScheduled, createScheduled, listScheduled } from "../scheduler/store.js";
import { startScheduler } from "../scheduler/store.js";
import { startTelegramService, type TelegramService } from "../telegram/service.js";
import type { ToolExecutionPolicy } from "../types/tool.js";
import { openUrl } from "../cli/shortcuts.js";
import { renderWebApp } from "./ui.js";
import {
  addWorkspace,
  deleteCalendarEvent,
  deleteNote,
  loadWebData,
  markNotificationsRead,
  pushBrowserNotification,
  removeWorkspace,
  saveCalendarEvent,
  saveNote
} from "./store.js";
import { McpRuntime } from "../mcp/client.js";

type Approval = {
  id: string;
  action: string;
  details: string;
  resolve: (approved: boolean) => void;
};

type WebServerOptions = {
  port?: number;
  open?: boolean;
  version: string;
};

const MAX_BODY_BYTES = 512 * 1024;
const WEB_TOKEN_HEADER = "x-raya-web-token";

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) {
    body += Buffer.from(chunk).toString("utf8");
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error("Request body is too large.");
  }
  if (!body.trim()) return {};
  const value = JSON.parse(body) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("JSON object required.");
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, required = true): string {
  if (typeof value !== "string" || (required && !value.trim())) throw new Error(`${name} is required.`);
  return value.trim();
}

function safeContextFile(value: unknown): "AGENTS.md" | "SOUL.md" {
  if (value !== "AGENTS.md" && value !== "SOUL.md") throw new Error("Context file must be AGENTS.md or SOUL.md.");
  return value;
}

function transcript(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter((message) => message.role === "user" || message.role === "assistant");
}

function tokenMatches(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function listWorkspaceFiles(root: string): Array<{ path: string; type: "file" | "directory"; size?: number }> {
  const realRoot = realpathSync(root);
  const entries: Array<{ path: string; type: "file" | "directory"; size?: number }> = [];
  const visit = (directory: string, depth: number): void => {
    if (depth > 4 || entries.length >= 400) return;
    for (const name of readdirSync(directory).sort((a, b) => a.localeCompare(b))) {
      if ([".git", "node_modules", "dist", ".DS_Store"].includes(name) || entries.length >= 400) continue;
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      const displayPath = relative(realRoot, path);
      if (stat.isDirectory()) {
        entries.push({ path: displayPath, type: "directory" });
        visit(path, depth + 1);
      } else if (stat.isFile()) {
        entries.push({ path: displayPath, type: "file", size: stat.size });
      }
    }
  };
  visit(realRoot, 0);
  return entries;
}

function workspaceContextPath(root: string, file: "AGENTS.md" | "SOUL.md", allowMissing = false): string {
  const realRoot = realpathSync(root);
  const path = join(realRoot, file);
  if (existsSync(path)) {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`${file} cannot be a symbolic link.`);
    const child = relative(realRoot, realpathSync(path));
    if (child.startsWith("..") || isAbsolute(child)) throw new Error(`${file} escapes the workspace.`);
  } else if (!allowMissing) {
    throw Object.assign(new Error(`${file} does not exist.`), { code: "ENOENT" });
  } else {
    const parent = realpathSync(dirname(path));
    const child = relative(realRoot, parent);
    if (child.startsWith("..") || isAbsolute(child)) throw new Error(`${file} escapes the workspace.`);
  }
  return path;
}

export async function runWebServer(options: WebServerOptions): Promise<void> {
  let config = loadConfig();
  const runtime = createProviderRuntime();
  const mcp = await McpRuntime.connect(config, {
    clientVersion: options.version,
    onStatus: (status) => {
      if (status.enabled && !status.connected) console.error(`MCP ${status.name}: unavailable · ${status.error}`);
    }
  });
  let session = getOrCreateActiveSession(config);
  session.config = { ...session.config, mcpServers: config.mcpServers };
  let queue = Promise.resolve();
  let approval: Approval | undefined;
  const webToken = randomBytes(32).toString("base64url");
  let boundPort = options.port ?? 4177;

  const token = readSecret("RAYA_TELEGRAM_BOT_TOKEN");
  const chatId = readSecret("RAYA_TELEGRAM_ALLOWED_CHAT_ID");
  let telegram: TelegramService | undefined;

  const policy = (): ToolExecutionPolicy => config.mode === "build" && config.securityMode === "full"
    ? { allowWithoutApproval: true }
    : config.mode !== "build" ? {} : {
    confirmDangerousAction: (action, details) => new Promise<void>((resolve, reject) => {
      if (approval) return reject(new Error("Another browser approval is already pending."));
      const id = crypto.randomUUID().slice(0, 10);
      const timer = setTimeout(() => {
        if (approval?.id === id) approval = undefined;
        reject(new Error("Browser approval timed out."));
      }, 5 * 60_000);
      approval = {
        id,
        action,
        details,
        resolve: (approved) => {
          clearTimeout(timer);
          approval = undefined;
          approved ? resolve() : reject(new Error("Action refused in Raya Web."));
        }
      };
    })
    };

  const runPrompt = async (prompt: string, workspace?: string, remotePolicy?: ToolExecutionPolicy): Promise<string> => {
    const model = getConfiguredModel(runtime, session.config.provider, session.config.model);
    if (!(await isProviderConfigured(runtime, session.config.provider, model.id))) {
      throw new Error(`Provider ${session.config.provider} is not connected. Run raya login first.`);
    }
    let responseText = "";
    const agent = createRayaAgent({
      config: session.config,
      model,
      models: runtime.models,
      workspace,
      toolPolicy: remotePolicy ?? policy(),
      mcp,
      onEvent: (event) => {
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          responseText += event.assistantMessageEvent.delta;
        }
      }
    });
    agent.state.messages = session.messages;
    await agent.prompt(prompt);
    await agent.waitForIdle();
    session.messages = agent.state.messages;
    saveSession(session);
    return responseText;
  };

  if (token && chatId) {
    telegram = startTelegramService({
      token,
      allowedChatId: chatId,
      onError: (error) => console.error(`Telegram: ${error.message}`),
      onPrompt: (prompt, remotePolicy) => {
        const operation = queue.then(() => runPrompt(prompt, undefined, remotePolicy));
        queue = operation.then(() => undefined, () => undefined);
        return operation;
      }
    });
  }

  const stopScheduler = startScheduler(async (task) => {
    if (!telegram || !chatId) throw new Error("Scheduled delivery requires a Telegram token and allowed chat ID. Run raya gateway --setup.");
    await telegram.sendMessage(chatId, `Reminder: ${task.message}`);
    if (task.webNotification) pushBrowserNotification("Raya reminder", task.message);
  }, (error) => console.error(`Scheduler: ${error.message}`));

  const server = createServer(async (request, response) => {
    try {
      const host = request.headers.host ?? "";
      const allowedHosts = new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`]);
      if (!allowedHosts.has(host.toLowerCase())) {
        sendJson(response, 403, { error: "Invalid Raya Web host." });
        return;
      }
      const url = new URL(request.url ?? "/", `http://${host}`);
      if (request.headers.origin && request.headers.origin !== `http://${host}`) {
        sendJson(response, 403, { error: "Cross-origin requests are not allowed." });
        return;
      }

      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:"
        });
        response.end(renderWebApp(options.version));
        return;
      }

      if (url.pathname.startsWith("/api/")
        && !tokenMatches(request.headers[WEB_TOKEN_HEADER] as string | undefined, webToken)) {
        sendJson(response, 401, { error: "Raya Web access token is missing or invalid." });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/bootstrap") {
        const activeModel = getConfiguredModel(runtime, config.provider, config.model);
        const assistantMessages = session.messages.filter((message) => message.role === "assistant") as Array<{ usage?: { totalTokens?: number } }>;
        const contextTokens = [...assistantMessages].reverse().find((message) => message.usage?.totalTokens)?.usage?.totalTokens ?? 0;
        sendJson(response, 200, {
          web: loadWebData(),
          scheduled: listScheduled(),
          sessions: listSessions(process.cwd(), config.activeProfile).map(({ id, name, updatedAt }) => ({ id, name, updatedAt })),
          messages: transcript(session.messages),
          activeSessionId: session.id,
          contextTokens,
          contextWindow: activeModel.contextWindow,
          config: { mode: config.mode, provider: config.provider, model: config.model },
          telegram: Boolean(token && chatId)
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/chat") {
        const body = await readJson(request);
        const prompt = text(body.prompt, "prompt");
        const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : undefined;
        const workspace = loadWebData().workspaces.find((item) => item.id === workspaceId)?.path;
        const operation = queue.then(() => runPrompt(prompt, workspace));
        queue = operation.then(() => undefined, () => undefined);
        const answer = await operation;
        sendJson(response, 200, { answer, messages: transcript(session.messages) });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/approval") {
        sendJson(response, 200, { approval: approval ? { id: approval.id, action: approval.action, details: approval.details } : null });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/approval") {
        const body = await readJson(request);
        if (!approval || body.id !== approval.id) throw new Error("Approval is no longer active.");
        approval.resolve(body.approved === true);
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "PATCH" && url.pathname === "/api/config") {
        const body = await readJson(request);
        const mode = body.mode;
        if (mode !== "plan" && mode !== "build") throw new Error("mode must be plan or build.");
        updateConfig({ mode });
        config = { ...config, mode };
        session.config = config;
        if (session.messages.length) saveSession(session);
        sendJson(response, 200, { mode: config.mode, provider: config.provider, model: config.model });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/sessions") {
        session = createSession(config);
        sendJson(response, 200, { id: session.id, messages: [] });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/sessions/open") {
        const body = await readJson(request);
        session = switchSession(text(body.id, "id"), process.cwd(), config.activeProfile);
        config = session.config;
        sendJson(response, 200, { id: session.id, messages: transcript(session.messages) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/calendar") {
        const body = await readJson(request);
        const event = saveCalendarEvent({
          id: typeof body.id === "string" ? body.id : undefined,
          title: text(body.title, "title"),
          start: text(body.start, "start"),
          ...(typeof body.end === "string" && body.end ? { end: body.end } : {}),
          notes: typeof body.notes === "string" ? body.notes : "",
          ...(typeof body.workspaceId === "string" ? { workspaceId: body.workspaceId } : {})
        });
        sendJson(response, 200, event);
        return;
      }

      const calendarDelete = url.pathname.match(/^\/api\/calendar\/([^/]+)$/);
      if (request.method === "DELETE" && calendarDelete) {
        deleteCalendarEvent(calendarDelete[1]!);
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/scheduled") {
        const body = await readJson(request);
        if (!token || !chatId) throw new Error("Telegram delivery must be configured first: raya gateway --setup");
        const kind = body.kind === "reminder" ? "reminder" : "scheduled";
        const repeat = body.repeat === "daily" ? "daily" : "none";
        const task = createScheduled(text(body.message, "message"), text(body.runAt, "runAt"), repeat, {
          kind,
          source: "web",
          webNotification: kind === "reminder"
        });
        sendJson(response, 200, task);
        return;
      }

      const scheduledDelete = url.pathname.match(/^\/api\/scheduled\/([^/]+)$/);
      if (request.method === "DELETE" && scheduledDelete) {
        cancelScheduled(scheduledDelete[1]!);
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/workspaces") {
        const body = await readJson(request);
        sendJson(response, 200, addWorkspace(typeof body.name === "string" ? body.name : "", text(body.path, "path")));
        return;
      }

      const workspaceDelete = url.pathname.match(/^\/api\/workspaces\/([^/]+)$/);
      if (request.method === "DELETE" && workspaceDelete) {
        removeWorkspace(workspaceDelete[1]!);
        sendJson(response, 200, { ok: true });
        return;
      }

      const contextMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/context$/);
      if (contextMatch && request.method === "GET") {
        const workspace = loadWebData().workspaces.find((item) => item.id === contextMatch[1]);
        if (!workspace) throw new Error("Workspace not found.");
        const file = safeContextFile(url.searchParams.get("file"));
        let content = "";
        try { content = readFileSync(workspaceContextPath(workspace.path, file), "utf8"); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        sendJson(response, 200, { file, content });
        return;
      }

      const filesMatch = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/files$/);
      if (filesMatch && request.method === "GET") {
        const workspace = loadWebData().workspaces.find((item) => item.id === filesMatch[1]);
        if (!workspace) throw new Error("Workspace not found.");
        sendJson(response, 200, { files: listWorkspaceFiles(workspace.path) });
        return;
      }

      if (contextMatch && request.method === "PUT") {
        const workspace = loadWebData().workspaces.find((item) => item.id === contextMatch[1]);
        if (!workspace) throw new Error("Workspace not found.");
        const body = await readJson(request);
        const file = safeContextFile(body.file);
        const content = typeof body.content === "string" ? body.content : "";
        writeFileSync(workspaceContextPath(workspace.path, file, true), content, "utf8");
        sendJson(response, 200, { file, saved: true });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/notes") {
        const body = await readJson(request);
        sendJson(response, 200, saveNote({
          ...(typeof body.id === "string" ? { id: body.id } : {}),
          title: text(body.title, "title"),
          body: typeof body.body === "string" ? body.body : ""
        }));
        return;
      }

      const noteDelete = url.pathname.match(/^\/api\/notes\/([^/]+)$/);
      if (request.method === "DELETE" && noteDelete) {
        deleteNote(noteDelete[1]!);
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/notifications") {
        sendJson(response, 200, { notifications: loadWebData().notifications.filter((item) => !item.read) });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/notifications/read") {
        const body = await readJson(request);
        const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [];
        markNotificationsRead(ids);
        sendJson(response, 200, { ok: true });
        return;
      }

      sendJson(response, 404, { error: "Not found." });
    } catch (error) {
      sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  const port = options.port ?? 4177;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") boundPort = address.port;
      resolve();
    });
  });
  const url = `http://127.0.0.1:${boundPort}`;
  const authenticatedUrl = `${url}/#token=${encodeURIComponent(webToken)}`;
  console.log(`Raya Web running at ${authenticatedUrl}`);
  console.log("Keep this per-run browser URL private.");
  console.log("Press Ctrl+C to stop.");
  if (options.open !== false) await openUrl(authenticatedUrl);

  await new Promise<void>((resolve) => process.once("SIGINT", resolve));
  stopScheduler();
  approval?.resolve(false);
  await telegram?.stop();
  await mcp.close();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
