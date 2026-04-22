import { BlockscoutService } from './blockscout.js';
import { DexScreenerService } from './dexScreener.js';
import { HoneypotService } from './honeypot.js';

export { McpStdioClient, McpError, McpTimeoutError, parseCommand } from './client.js';
export type { McpClientOptions, McpToolCallResult } from './client.js';
export { DexScreenerService } from './dexScreener.js';
export type { DexScreenerPair } from './dexScreener.js';
export { HoneypotService } from './honeypot.js';
export type { HoneypotCheck, HoneypotDiscoverPairs, HoneypotInput } from './honeypot.js';
export { BlockscoutService } from './blockscout.js';
export type {
  BlockscoutAddress,
  BlockscoutAddressTxs,
  BlockscoutChain,
  BlockscoutHolders,
  BlockscoutToken,
} from './blockscout.js';

export interface McpManagerConfig {
  dexScreenerCmd?: string;
  honeypotCmd?: string;
  blockscoutCmd?: string;
  callTimeoutMs?: number;
}

/**
 * Owns one long-lived stdio child per MCP. Child processes are launched lazily
 * on first service call (the service classes wrap `McpStdioClient`, which auto-
 * starts on its first `callTool`).
 */
export class McpManager {
  readonly dexScreener: DexScreenerService | null;
  readonly honeypot: HoneypotService | null;
  readonly blockscout: BlockscoutService | null;

  constructor(config: McpManagerConfig) {
    const { callTimeoutMs } = config;
    this.dexScreener = config.dexScreenerCmd
      ? new DexScreenerService({ command: config.dexScreenerCmd, callTimeoutMs })
      : null;
    this.honeypot = config.honeypotCmd
      ? new HoneypotService({ command: config.honeypotCmd, callTimeoutMs })
      : null;
    this.blockscout = config.blockscoutCmd
      ? new BlockscoutService({ command: config.blockscoutCmd, callTimeoutMs })
      : null;
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([
      this.dexScreener?.close(),
      this.honeypot?.close(),
      this.blockscout?.close(),
    ]);
  }
}

export function createMcpManagerFromEnv(env: NodeJS.ProcessEnv = process.env): McpManager {
  return new McpManager({
    dexScreenerCmd: env.MCP_DEXSCREENER_CMD || undefined,
    honeypotCmd: env.MCP_HONEYPOT_CMD || undefined,
    blockscoutCmd: env.MCP_BLOCKSCOUT_CMD || undefined,
  });
}
