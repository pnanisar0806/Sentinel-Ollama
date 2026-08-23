const PROTOCOL_VERSION = '2025-06-18';

interface RpcResponse<T> {
  id?: number;
  result?: T;
  error?: { code: number; message: string };
}

interface ToolResult {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

/**
 * Minimal MCP client over Streamable HTTP — enough for authenticated tools/call.
 *
 * `allowedTools` is REQUIRED and enforced before any request leaves the process. This
 * is the one component that can invoke a named remote tool, so without it a URL change
 * is enough to reach `place_order` on a broker's MCP server. CLAUDE.md: trading paths
 * are absent code paths, not disabled features — a client that *could* name an order
 * tool is a trading path.
 */
export class McpClient {
  private nextId = 1;
  private sessionId: string | undefined;
  private initialized = false;
  private readonly allowedTools: ReadonlySet<string>;

  constructor(
    private readonly opts: {
      url: string;
      getToken: () => Promise<string>;
      fetchImpl?: typeof fetch;
      /** Exhaustive list of tools this client may invoke. Must be non-empty. */
      allowedTools: readonly string[];
    },
  ) {
    if (!opts.allowedTools?.length) {
      throw new Error(
        'McpClient requires a non-empty allowedTools: name every tool this client may ' +
        'invoke. An empty list reads as "deny all" and gets widened rather than fixed.',
      );
    }
    this.allowedTools = new Set(opts.allowedTools);
  }

  private async rpc<T>(method: string, params: unknown, notify = false): Promise<T> {
    const impl = this.opts.fetchImpl ?? fetch;
    const id = notify ? undefined : this.nextId++;
    const res = await impl(this.opts.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await this.opts.getToken()}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(notify ? {} : { id }) }),
    });

    this.sessionId ??= res.headers.get('Mcp-Session-Id') ?? undefined;
    if (notify) return undefined as T;

    if (!res.ok) throw new Error(`MCP ${method} failed: HTTP ${res.status}`);

    const raw = await res.text();
    const payload = res.headers.get('Content-Type')?.includes('text/event-stream')
      ? parseSse(raw)
      : (JSON.parse(raw) as RpcResponse<T>);

    if (payload.error) throw new Error(`MCP ${method} error: ${payload.error.message}`);
    return payload.result as T;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await this.rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'sentinel', version: '0.1.0' },
    });
    await this.rpc('notifications/initialized', {}, true);
    this.initialized = true;
  }

  async callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
    // Before ensureInitialized, so a refused tool never opens a session either.
    if (!this.allowedTools.has(name)) {
      throw new Error(
        `MCP tool '${name}' is not on the allowlist for ${this.opts.url}. ` +
        `Permitted: ${[...this.allowedTools].join(', ')}.`,
      );
    }
    await this.ensureInitialized();
    const result = await this.rpc<ToolResult>('tools/call', { name, arguments: args });
    if (result.isError) {
      throw new Error(`MCP tool ${name} returned an error: ${textOf(result)}`);
    }
    if (result.structuredContent !== undefined) return result.structuredContent as T;
    return JSON.parse(textOf(result)) as T;
  }
}

const textOf = (result: ToolResult): string =>
  (result.content ?? []).map((c) => c.text ?? '').join('') || '{}';

function parseSse<T>(raw: string): RpcResponse<T> {
  for (const line of raw.split('\n')) {
    if (line.startsWith('data:')) return JSON.parse(line.slice(5).trim()) as RpcResponse<T>;
  }
  throw new Error('no data frame in SSE response');
}