import { BlockscoutService } from './blockscout.js';

export { McpStdioClient, McpError, McpTimeoutError, parseCommand } from './client.js';
export type { McpClientOptions, McpToolCallResult } from './client.js';
export { BlockscoutService } from './blockscout.js';
export type {
  BlockscoutAddress,
  BlockscoutAddressTxs,
  BlockscoutChain,
  BlockscoutHolders,
  BlockscoutToken,
} from './blockscout.js';

export interface McpManagerConfig {
  blockscoutCmd?: string;
  callTimeoutMs?: number;
}

/**
 * Owns one long-lived stdio child per MCP. Child processes are launched lazily
 * on first service call (the service classes wrap `McpStdioClient`, which auto-
 * starts on its first `callTool`).
 */
export class McpManager {
  readonly blockscout: BlockscoutService | null;

  constructor(config: McpManagerConfig) {
    const { callTimeoutMs } = config;
    this.blockscout = config.blockscoutCmd
      ? new BlockscoutService({ command: config.blockscoutCmd, callTimeoutMs })
      : null;
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([
      this.blockscout?.close(),
    ]);
  }
}

export function createMcpManagerFromEnv(env: NodeJS.ProcessEnv = process.env): McpManager {
  return new McpManager({
    blockscoutCmd: env.MCP_BLOCKSCOUT_CMD || undefined,
  });
}
