import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerConfig } from '../types.js';
import type { ToolDefinition } from '../providers/types.js';

const NAMESPACE_SEPARATOR = '__';
const CLIENT_INFO = { name: 'playwright-ai-reporter-plugin', version: '1.0.0' };

function isHttp(config: McpServerConfig): config is { url: string; headers?: Record<string, string> } {
  return 'url' in config;
}

/**
 * Connects to every configured MCP server and exposes their tools as one flat,
 * namespaced list the model can call.
 *
 * Everything here is fail-soft: a server that cannot be reached is reported once
 * and skipped, because an unavailable Jira must never break a test run.
 */
export class McpHub {
  private readonly clients = new Map<string, Client>();
  private tools: ToolDefinition[] = [];

  constructor(
    private readonly servers: Record<string, McpServerConfig>,
    private readonly warn: (message: string) => void,
  ) {}

  /** Names of the servers that actually connected. */
  getConnectedServers(): string[] {
    return [...this.clients.keys()];
  }

  /** Tools aggregated from all connected servers, namespaced as `server__tool`. */
  getTools(): ToolDefinition[] {
    return this.tools;
  }

  /** Connects to every server, ignoring the ones that fail. */
  async connect(): Promise<void> {
    const names = Object.keys(this.servers);
    await Promise.all(names.map((name) => this.connectOne(name, this.servers[name]!)));
    this.tools = await this.collectTools();
  }

  private async connectOne(name: string, config: McpServerConfig): Promise<void> {
    try {
      const client = new Client(CLIENT_INFO);
      const transport = isHttp(config)
        ? new StreamableHTTPClientTransport(new URL(config.url), {
            requestInit: config.headers ? { headers: config.headers } : undefined,
          })
        : new StdioClientTransport({
            command: config.command,
            args: config.args ?? [],
            env: { ...(process.env as Record<string, string>), ...(config.env ?? {}) },
          });
      await client.connect(transport);
      this.clients.set(name, client);
    } catch (error) {
      this.warn(`MCP server "${name}" is unavailable and will be ignored: ${String(error)}`);
    }
  }

  private async collectTools(): Promise<ToolDefinition[]> {
    const collected: ToolDefinition[] = [];
    for (const [name, client] of this.clients) {
      try {
        const { tools } = await client.listTools();
        for (const tool of tools) {
          collected.push({
            name: `${name}${NAMESPACE_SEPARATOR}${tool.name}`,
            description: `[${name}] ${tool.description ?? tool.name}`,
            inputSchema: (tool.inputSchema as Record<string, unknown>) ?? {
              type: 'object',
              properties: {},
            },
          });
        }
      } catch (error) {
        this.warn(`Could not list tools of MCP server "${name}": ${String(error)}`);
      }
    }
    return collected;
  }

  /**
   * Calls a namespaced tool and returns its result as text. Failures are returned
   * as text too, so the model can react to them instead of the run aborting.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const separator = name.indexOf(NAMESPACE_SEPARATOR);
    const server = separator === -1 ? '' : name.slice(0, separator);
    const toolName = separator === -1 ? name : name.slice(separator + NAMESPACE_SEPARATOR.length);
    const client = this.clients.get(server);
    if (!client) return `Error: unknown MCP tool "${name}".`;

    try {
      const result = await client.callTool({ name: toolName, arguments: args });
      const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
      const text = content
        .filter((block) => block.type === 'text' && block.text)
        .map((block) => block.text)
        .join('\n');
      return text || JSON.stringify(result);
    } catch (error) {
      return `Error calling "${name}": ${String(error)}`;
    }
  }

  /** Shuts every connection down; called once the run's analyses are done. */
  async close(): Promise<void> {
    await Promise.all(
      [...this.clients.values()].map((client) => client.close().catch(() => undefined)),
    );
    this.clients.clear();
  }
}
