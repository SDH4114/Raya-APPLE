import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Type } from "@earendil-works/pi-ai";
import type { McpServerConfig, RayaConfig } from "../config/config.js";
import { commandInvocation } from "../platform.js";
import { requireToolApproval, type RayaTool, type ToolExecutionPolicy } from "../types/tool.js";

type McpToolDefinition = Awaited<ReturnType<Client["listTools"]>>["tools"][number];

type ConnectedServer = {
  name: string;
  config: McpServerConfig;
  client: Client;
  tools: McpToolDefinition[];
  instructions?: string;
  serverName?: string;
  serverVersion?: string;
};

export type McpServerStatus = {
  name: string;
  enabled: boolean;
  connected: boolean;
  transport: McpServerConfig["transport"];
  tools: number;
  error?: string;
};

export function formatMcpStatusLines(statuses: readonly McpServerStatus[]): string[] {
  if (!statuses.length) return ["No MCP servers configured. Use: raya mcp add <name> ..."];
  const width = Math.max(...statuses.map((status) => status.name.length));
  return [
    "MCP servers:",
    ...statuses.map((status) => {
      if (!status.enabled) return `○ ${status.name.padEnd(width)}  Disabled · ${status.transport}`;
      if (status.connected) return `● ${status.name.padEnd(width)}  Enabled · Connected · ${status.transport} · ${status.tools} tools`;
      return `! ${status.name.padEnd(width)}  Enabled · Unavailable · ${status.transport}${status.error ? ` · ${status.error}` : ""}`;
    })
  ];
}

export type McpConnectOptions = {
  clientVersion: string;
  only?: string;
  strict?: boolean;
  root?: string;
  onStatus?: (status: McpServerStatus) => void;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function expandMcpValue(value: string, environment: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/gi, (_match, name: string) => {
    const replacement = environment[name];
    if (replacement === undefined) throw new Error(`MCP environment variable is not set: ${name}`);
    return replacement;
  });
}

function resolveRecord(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, expandMcpValue(value)]));
}

function mergeHeaders(base: HeadersInit | undefined, extra: Record<string, string>): Headers {
  const headers = new Headers(base);
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return headers;
}

function namespacedToolName(server: string, tool: string): string {
  const base = `mcp_${server}_${tool}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (base.length <= 56) return base;
  const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 7);
  return `${base.slice(0, 48)}_${hash}`;
}

function textContent(value: unknown): Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
  if (!value || typeof value !== "object" || !("content" in value) || !Array.isArray(value.content)) {
    return [{ type: "text", text: JSON.stringify(value, null, 2) }];
  }
  const result: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
  for (const item of value.content as Array<Record<string, unknown>>) {
    if (item.type === "text" && typeof item.text === "string") {
      result.push({ type: "text", text: item.text });
    } else if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
      result.push({ type: "image", data: item.data, mimeType: item.mimeType });
    } else {
      result.push({ type: "text", text: JSON.stringify(item, null, 2) });
    }
  }
  if ("structuredContent" in value && value.structuredContent !== undefined) {
    result.push({ type: "text", text: `Structured result:\n${JSON.stringify(value.structuredContent, null, 2)}` });
  }
  return result.length ? result : [{ type: "text", text: "MCP tool completed without content." }];
}

async function listAllTools(client: Client, timeout: number): Promise<McpToolDefinition[]> {
  const tools: McpToolDefinition[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined, { timeout });
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

async function connectServer(name: string, config: McpServerConfig, clientVersion: string, root: string): Promise<ConnectedServer> {
  const resolvedRoot = resolve(root);
  const client = new Client({ name: "raya", version: clientVersion }, { capabilities: { roots: { listChanged: false } } });
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: pathToFileURL(resolvedRoot).href, name: basename(resolvedRoot) || resolvedRoot }]
  }));
  try {
    if (config.transport === "stdio") {
      const invocation = commandInvocation(
        expandMcpValue(config.command),
        config.args.map((arg) => expandMcpValue(arg))
      );
      const transport = new StdioClientTransport({
        command: invocation.command,
        args: invocation.args,
        ...(config.cwd ? { cwd: expandMcpValue(config.cwd) } : {}),
        env: { ...getDefaultEnvironment(), ...resolveRecord(config.env) },
        stderr: "pipe"
      });
      // Drain server diagnostics so a noisy child cannot block, while keeping the TUI clean.
      transport.stderr?.on("data", () => undefined);
      await client.connect(transport, { timeout: config.timeoutMs });
    } else if (config.transport === "http") {
      const headers = resolveRecord(config.headers);
      const transport = new StreamableHTTPClientTransport(new URL(expandMcpValue(config.url)), {
        requestInit: { headers }
      });
      await client.connect(transport, { timeout: config.timeoutMs });
    } else {
      const headers = resolveRecord(config.headers);
      const transport = new SSEClientTransport(new URL(expandMcpValue(config.url)), {
        requestInit: { headers },
        eventSourceInit: {
          fetch: (url, init) => fetch(url, { ...init, headers: mergeHeaders(init?.headers, headers) })
        }
      });
      await client.connect(transport, { timeout: config.timeoutMs });
    }
    const tools = await listAllTools(client, config.timeoutMs);
    const server = client.getServerVersion();
    return {
      name,
      config,
      client,
      tools,
      instructions: client.getInstructions(),
      serverName: server?.name,
      serverVersion: server?.version
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

export class McpRuntime {
  readonly statuses: McpServerStatus[];
  private readonly servers: Map<string, ConnectedServer>;

  private constructor(servers: Map<string, ConnectedServer>, statuses: McpServerStatus[]) {
    this.servers = servers;
    this.statuses = statuses;
  }

  static async connect(config: RayaConfig, options: McpConnectOptions): Promise<McpRuntime> {
    const entries = Object.entries(config.mcpServers).filter(([name, server]) =>
      (!options.only || name === options.only) && (server.enabled || options.only === name)
    );
    if (options.only && !config.mcpServers[options.only]) throw new Error(`Unknown MCP server: ${options.only}`);
    const servers = new Map<string, ConnectedServer>();
    const statuses = await Promise.all(entries.map(async ([name, server]): Promise<McpServerStatus> => {
      try {
        const connected = await connectServer(name, server, options.clientVersion, options.root ?? process.cwd());
        servers.set(name, connected);
        const status = { name, enabled: server.enabled, connected: true, transport: server.transport, tools: connected.tools.length } as const;
        options.onStatus?.(status);
        return status;
      } catch (error) {
        const status = { name, enabled: server.enabled, connected: false, transport: server.transport, tools: 0, error: errorMessage(error) } as const;
        options.onStatus?.(status);
        return status;
      }
    }));
    for (const [name, server] of Object.entries(config.mcpServers)) {
      if (!server.enabled && (!options.only || name !== options.only)) {
        statuses.push({ name, enabled: false, connected: false, transport: server.transport, tools: 0 });
      }
    }
    const runtime = new McpRuntime(servers, statuses.sort((a, b) => a.name.localeCompare(b.name)));
    const failed = runtime.statuses.find((status) => !status.connected && (options.only ? status.name === options.only : status.enabled));
    if (options.strict && failed) {
      await runtime.close();
      throw new Error(`MCP ${failed.name}: ${failed.error}`);
    }
    return runtime;
  }

  get connectedCount(): number {
    return this.servers.size;
  }

  get instructions(): string {
    const sections = [...this.servers.values()]
      .filter((server) => server.instructions)
      .map((server) => `## MCP server: ${server.name}\n${server.instructions}`);
    return sections.length ? `# MCP server instructions\n\n${sections.join("\n\n")}` : "";
  }

  createTools(config: RayaConfig, policy: ToolExecutionPolicy = {}): RayaTool[] {
    const tools: RayaTool[] = [];
    const usedNames = new Set<string>();
    for (const server of this.servers.values()) {
      for (const definition of server.tools) {
        let exposedName = namespacedToolName(server.name, definition.name);
        let suffix = 2;
        while (usedNames.has(exposedName)) exposedName = `${namespacedToolName(server.name, definition.name).slice(0, 60)}_${suffix++}`;
        usedNames.add(exposedName);
        const parameters = Type.Unsafe<Record<string, unknown>>(definition.inputSchema);
        tools.push({
          name: exposedName,
          label: definition.title ?? `MCP · ${server.name} · ${definition.name}`,
          description: `${definition.description ?? `MCP tool ${definition.name}`} (server: ${server.name})`,
          parameters,
          executionMode: "sequential",
          async execute(_toolCallId, params, signal) {
            const readOnly = server.config.trustReadOnlyAnnotations
              && definition.annotations?.readOnlyHint === true;
            if (config.mode !== "build" && !readOnly) {
              throw new Error(`MCP tool ${server.name}/${definition.name} is not explicitly trusted as read-only. Switch to Build mode or enable trustReadOnlyAnnotations for this server.`);
            }
            const needsApproval = server.config.approval === "always" || (server.config.approval === "writes" && !readOnly);
            if (needsApproval) {
              await requireToolApproval(policy, "run MCP tool", `${server.name}/${definition.name}\n${JSON.stringify(params, null, 2)}`);
            }
            const response = await server.client.callTool(
              { name: definition.name, arguments: params as Record<string, unknown> },
              undefined,
              { signal, timeout: server.config.toolTimeoutMs, resetTimeoutOnProgress: true, maxTotalTimeout: server.config.toolTimeoutMs }
            );
            if ("isError" in response && response.isError) {
              throw new Error(textContent(response).map((item) => item.type === "text" ? item.text : "[image]").join("\n"));
            }
            return { content: textContent(response), details: { server: server.name, tool: definition.name, response } };
          }
        });
      }
    }
    tools.push(...this.createResourceTools(), ...this.createPromptTools());
    return tools;
  }

  private createResourceTools(): RayaTool[] {
    const capable = [...this.servers.values()].filter((server) => server.client.getServerCapabilities()?.resources);
    if (!capable.length) return [];
    const listParameters = Type.Object({ server: Type.Optional(Type.String({ description: "Optional MCP server name." })) });
    const readParameters = Type.Object({ server: Type.String(), uri: Type.String() });
    const listTool: RayaTool<typeof listParameters> = {
      name: "mcp_list_resources",
      label: "MCP · List resources",
      description: "List resources exposed by connected MCP servers.",
      parameters: listParameters,
      async execute(_id, params, signal) {
        const selected = params.server ? capable.filter((server) => server.name === params.server) : capable;
        if (!selected.length) throw new Error(`Unknown or resource-incompatible MCP server: ${params.server}`);
        const resources = [] as unknown[];
        for (const server of selected) {
          let cursor: string | undefined;
          do {
            const page = await server.client.listResources(cursor ? { cursor } : undefined, { signal, timeout: server.config.timeoutMs });
            resources.push(...page.resources.map((resource) => ({ server: server.name, ...resource })));
            cursor = page.nextCursor;
          } while (cursor);
        }
        return { content: [{ type: "text", text: JSON.stringify(resources, null, 2) }], details: resources };
      }
    };
    const readTool: RayaTool<typeof readParameters> = {
      name: "mcp_read_resource",
      label: "MCP · Read resource",
      description: "Read a resource from a connected MCP server.",
      parameters: readParameters,
      async execute(_id, params, signal) {
        const server = capable.find((item) => item.name === params.server);
        if (!server) throw new Error(`Unknown or resource-incompatible MCP server: ${params.server}`);
        const response = await server.client.readResource({ uri: params.uri }, { signal, timeout: server.config.toolTimeoutMs });
        return { content: [{ type: "text", text: JSON.stringify(response.contents, null, 2) }], details: response };
      }
    };
    return [listTool, readTool];
  }

  private createPromptTools(): RayaTool[] {
    const capable = [...this.servers.values()].filter((server) => server.client.getServerCapabilities()?.prompts);
    if (!capable.length) return [];
    const listParameters = Type.Object({ server: Type.Optional(Type.String({ description: "Optional MCP server name." })) });
    const getParameters = Type.Object({
      server: Type.String(),
      name: Type.String(),
      arguments: Type.Optional(Type.Record(Type.String(), Type.String()))
    });
    const listTool: RayaTool<typeof listParameters> = {
      name: "mcp_list_prompts",
      label: "MCP · List prompts",
      description: "List reusable prompts exposed by connected MCP servers.",
      parameters: listParameters,
      async execute(_id, params, signal) {
        const selected = params.server ? capable.filter((server) => server.name === params.server) : capable;
        if (!selected.length) throw new Error(`Unknown or prompt-incompatible MCP server: ${params.server}`);
        const prompts = [] as unknown[];
        for (const server of selected) {
          let cursor: string | undefined;
          do {
            const page = await server.client.listPrompts(cursor ? { cursor } : undefined, { signal, timeout: server.config.timeoutMs });
            prompts.push(...page.prompts.map((prompt) => ({ server: server.name, ...prompt })));
            cursor = page.nextCursor;
          } while (cursor);
        }
        return { content: [{ type: "text", text: JSON.stringify(prompts, null, 2) }], details: prompts };
      }
    };
    const getTool: RayaTool<typeof getParameters> = {
      name: "mcp_get_prompt",
      label: "MCP · Get prompt",
      description: "Load a reusable prompt from a connected MCP server.",
      parameters: getParameters,
      async execute(_id, params, signal) {
        const server = capable.find((item) => item.name === params.server);
        if (!server) throw new Error(`Unknown or prompt-incompatible MCP server: ${params.server}`);
        const response = await server.client.getPrompt({ name: params.name, arguments: params.arguments }, { signal, timeout: server.config.toolTimeoutMs });
        return { content: [{ type: "text", text: JSON.stringify(response, null, 2) }], details: response };
      }
    };
    return [listTool, getTool];
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.servers.values()].map((server) => server.client.close()));
    this.servers.clear();
  }
}
