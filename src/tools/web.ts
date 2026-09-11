import { Type } from "@earendil-works/pi-ai";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { RayaConfig } from "../config/config.js";
import type { RayaTool } from "../types/tool.js";

const WebParameters = Type.Object({
  query: Type.Optional(Type.String({ description: "Search query. Use either query or url." })),
  url: Type.Optional(Type.String({ description: "URL to fetch. Use either query or url." }))
});

type WebResult = {
  title?: string;
  url: string;
  snippet?: string;
  content?: string;
};

type WebDetails = {
  mode: "search" | "fetch";
  results: WebResult[];
};

const MAX_HTTP_BODY_CHARS = 1_000_000;
const MAX_REDIRECTS = 5;

export function isPrivateIpAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a! >= 224
      || (a === 100 && b! >= 64 && b! <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b! >= 16 && b! <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19));
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) return isPrivateIpAddress(normalized.slice(7));
    return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd")
      || /^fe[89ab]/.test(normalized) || normalized.startsWith("ff");
  }
  return true;
}

type PublicAddress = { address: string; family: 4 | 6 };

async function resolvePublicUrl(url: URL): Promise<PublicAddress[]> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https URLs are supported.");
  if (url.username || url.password) throw new Error("URLs containing credentials are not supported.");
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")
    || hostname.endsWith(".internal") || hostname.endsWith(".lan") || (!hostname.includes(".") && isIP(hostname) === 0)) {
    throw new Error("Web requests to local or private hosts are not allowed.");
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) as 4 | 6 }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((item) => isPrivateIpAddress(item.address))) {
    throw new Error("Web requests to local or private addresses are not allowed.");
  }
  return addresses.map((item) => ({ address: item.address, family: item.family as 4 | 6 }));
}

async function readResponseBody(response: IncomingMessage, maxChars: number): Promise<string> {
  const decoder = new TextDecoder();
  let value = "";
  for await (const chunk of response) {
    value += decoder.decode(Buffer.from(chunk), { stream: true });
    if (value.length >= maxChars) {
      response.destroy();
      break;
    }
  }
  value += decoder.decode();
  return value.slice(0, maxChars);
}

function pinnedRequest(url: URL, addresses: PublicAddress[], signal: AbortSignal): Promise<IncomingMessage> {
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const outgoing = request(url, {
      method: "GET",
      signal,
      headers: {
        "accept-encoding": "identity",
        "user-agent": "Raya/0.2 (+https://github.com/SDH4114/Raya-APPLE)"
      },
      lookup: (_hostname, _options, callback) => {
        const selected = addresses[0]!;
        callback(null, selected.address, selected.family);
      }
    }, resolve);
    outgoing.once("error", reject);
    outgoing.end();
  });
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeDuckDuckGoUrl(raw: string): string {
  try {
    const parsed = new URL(raw, "https://duckduckgo.com");
    const uddg = parsed.searchParams.get("uddg");
    return uddg ?? raw;
  } catch {
    return raw;
  }
}

function parseSearchResults(html: string): WebResult[] {
  const results: WebResult[] = [];
  const linkRegex = /<a[^>]+class="[^"]*(?:result__a|result-link)[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(html)) !== null && results.length < 5) {
    const url = decodeDuckDuckGoUrl(match[1] ?? "");
    const title = stripHtml(match[2] ?? "");
    if (url.startsWith("http") && title && !results.some((item) => item.url === url)) {
      const remainder = html.slice(match.index + match[0].length, match.index + match[0].length + 1600);
      const snippetMatch = remainder.match(/<(?:a|div)[^>]+class="[^"]*(?:result__snippet|result-snippet)[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/i);
      results.push({ title, url, snippet: snippetMatch ? stripHtml(snippetMatch[1] ?? "") : undefined });
    }
  }

  return results;
}

function parseBingResults(html: string): WebResult[] {
  const results: WebResult[] = [];
  const regex = /<li[^>]+class="[^"]*b_algo[^"]*"[\s\S]*?<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) && results.length < 5) {
    const url = stripHtml(match[1] ?? "");
    if (url.startsWith("http")) results.push({ url, title: stripHtml(match[2] ?? ""), snippet: stripHtml(match[3] ?? "") });
  }
  return results;
}

async function searchWeb(query: string, timeoutMs: number, signal?: AbortSignal): Promise<WebResult[]> {
  const attempts = [
    { url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, parse: parseSearchResults },
    { url: `https://www.bing.com/search?q=${encodeURIComponent(query)}`, parse: parseBingResults }
  ];
  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      const results = attempt.parse(await fetchText(attempt.url, timeoutMs, signal));
      if (results.length) return results;
      errors.push(`${new URL(attempt.url).hostname}: no results parsed`);
    } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }
  throw new Error(`Web search failed: ${errors.join("; ")}`);
}

async function fetchText(url: string, timeoutMs: number, signal?: AbortSignal, maxChars = MAX_HTTP_BODY_CHARS): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });

  try {
    let current = new URL(url);
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      const addresses = await resolvePublicUrl(current);
      const response = await pinnedRequest(current, addresses, controller.signal);
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        const location = response.headers.location;
        response.resume();
        if (!location) throw new Error(`HTTP ${status} redirect without location`);
        current = new URL(location, current);
        continue;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        throw new Error(`HTTP ${status} ${response.statusMessage ?? ""}`.trim());
      }
      return readResponseBody(response, maxChars);
    }
    throw new Error(`Too many redirects (maximum ${MAX_REDIRECTS}).`);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

export function createWebTool(config: RayaConfig): RayaTool<typeof WebParameters, WebDetails> {
  return {
    name: "web",
    label: "Web",
    description:
      "Search the web with a query or fetch a URL. Returns short text excerpts and source URLs.",
    parameters: WebParameters,
    async execute(_toolCallId, params, signal) {
      if (Boolean(params.query) === Boolean(params.url)) {
        throw new Error("Provide exactly one of query or url.");
      }

      if (params.url) {
        const url = new URL(params.url);
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https URLs are supported.");
        if (url.username || url.password) throw new Error("URLs containing credentials are not supported.");
        const html = await fetchText(url.toString(), config.webTimeoutMs, signal, Math.min(MAX_HTTP_BODY_CHARS, config.webMaxChars * 8));
        const content = stripHtml(html).slice(0, config.webMaxChars);
        const details: WebDetails = {
          mode: "fetch",
          results: [{ url: url.toString(), content }]
        };

        return {
          content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
          details
        };
      }

      const results = await searchWeb(params.query ?? "", config.webTimeoutMs, signal);
      const perPage = Math.floor(config.webMaxChars / Math.max(results.length, 1));
      const enriched = await Promise.all(results.map(async (result) => {
        try { return { ...result, content: stripHtml(await fetchText(result.url, config.webTimeoutMs, signal)).slice(0, perPage) }; }
        catch { return result; }
      }));

      const details: WebDetails = {
        mode: "search",
        results: enriched
      };

      return {
        content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
        details
      };
    }
  };
}
