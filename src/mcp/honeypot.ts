import { z } from 'zod';
import { McpStdioClient, parseCommand } from './client.js';
import { callAndParse } from './shared.js';

const HoneypotCheckSchema = z
  .object({
    token: z
      .object({
        address: z.string().optional(),
        name: z.string().optional(),
        symbol: z.string().optional(),
      })
      .partial()
      .passthrough()
      .optional(),
    honeypotResult: z
      .object({
        isHoneypot: z.boolean().optional(),
        honeypotReason: z.string().optional(),
      })
      .partial()
      .passthrough()
      .optional(),
    simulationResult: z
      .object({
        buyTax: z.number().optional(),
        sellTax: z.number().optional(),
        transferTax: z.number().optional(),
        buyGas: z.union([z.string(), z.number()]).optional(),
        sellGas: z.union([z.string(), z.number()]).optional(),
      })
      .partial()
      .passthrough()
      .optional(),
    simulationSuccess: z.boolean().optional(),
    flags: z.array(z.string()).optional(),
    summary: z
      .object({
        risk: z.string().optional(),
        riskLevel: z.number().optional(),
      })
      .partial()
      .passthrough()
      .optional(),
    chain: z.unknown().optional(),
    pair: z.unknown().optional(),
  })
  .passthrough();

export type HoneypotCheck = z.infer<typeof HoneypotCheckSchema>;

/**
 * Chains understood by `dex-honeypot-mcp`'s `check_honeypot` tool.
 * See https://github.com/dchu3/dex-honeypot-mcp
 */
export type HoneypotChain = 'ethereum' | 'bsc' | 'base';

export interface HoneypotInput {
  address: string;
  /** Optional; omit to let the server auto-detect. */
  chain?: HoneypotChain;
}

export interface HoneypotServiceOptions {
  command: string;
  callTimeoutMs?: number;
}

export class HoneypotService {
  private readonly client: McpStdioClient;

  constructor(options: HoneypotServiceOptions | McpStdioClient) {
    if (options instanceof McpStdioClient) {
      this.client = options;
      return;
    }
    const { command, args } = parseCommand(options.command);
    this.client = new McpStdioClient({
      name: 'honeypot',
      command,
      args,
      callTimeoutMs: options.callTimeoutMs,
    });
  }

  async checkToken(input: HoneypotInput): Promise<HoneypotCheck> {
    const args: Record<string, unknown> = { address: input.address };
    if (input.chain !== undefined) args.chain = input.chain;
    return callAndParse(this.client, 'check_honeypot', args, HoneypotCheckSchema);
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  getClient(): McpStdioClient {
    return this.client;
  }
}
