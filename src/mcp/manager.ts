import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/**
 * Declarative description of an MCP server. Servers are launched lazily by the
 * connection manager and reused across a run.
 */
export type McpServerSpec =
  | {
      name: string;
      transport: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      name: string;
      transport: 'http';
      url: string;
      headers?: Record<string, string>;
    };

export interface McpToolDescriptor {
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Manages a pool of MCP clients. Handles lazy connection, tool discovery, and
 * shutdown of all servers at process exit.
 */
export class McpManager {
  private clients = new Map<string, Client>();
  private specs = new Map<string, McpServerSpec>();

  register(spec: McpServerSpec): void {
    this.specs.set(spec.name, spec);
  }

  async connect(name: string): Promise<Client> {
    const existing = this.clients.get(name);
    if (existing) return existing;
    const spec = this.specs.get(name);
    if (!spec) throw new Error(`Unknown MCP server: ${name}`);

    const client = new Client({ name: 'd365fo-agentic', version: '0.1.0' });
    if (spec.transport === 'stdio') {
      const transport = new StdioClientTransport({
        command: spec.command,
        args: spec.args ?? [],
        env: { ...process.env, ...(spec.env ?? {}) } as Record<string, string>,
      });
      await client.connect(transport);
    } else {
      const transport = new StreamableHTTPClientTransport(new URL(spec.url), {
        requestInit: { headers: spec.headers },
      });
      await client.connect(transport);
    }

    this.clients.set(name, client);
    return client;
  }

  async listTools(name: string): Promise<McpToolDescriptor[]> {
    const client = await this.connect(name);
    const { tools } = await client.listTools();
    return tools.map((t) => ({
      server: name,
      name: t.name,
      description: t.description ?? '',
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object' },
    }));
  }

  async callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ content: unknown; isError: boolean }> {
    const client = await this.connect(server);
    const res = await client.callTool({ name: tool, arguments: args });
    return {
      content: res.content,
      isError: Boolean(res.isError),
    };
  }

  async closeAll(): Promise<void> {
    for (const [name, client] of this.clients) {
      try {
        await client.close();
      } catch {
        // best-effort cleanup
      }
      this.clients.delete(name);
    }
  }
}
