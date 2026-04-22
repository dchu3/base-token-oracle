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

const DiscoverPairsSchema = z
  .object({
    pairs: z
      .array(
        z
          .object({
            address: z.string().optional(),
            chainId: z.union([z.string(), z.number()]).optional(),
            reserves: z.unknown().optional(),
            liquidity: z.unknown().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

export type HoneypotDiscoverPairs = z.infer<typeof DiscoverPairsSchema>;

export interface HoneypotInput {
  address: string;
  chainId?: number | string;
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
    if (input.chainId !== undefined) args.chainId = input.chainId;
    return callAndParse(this.client, 'check_token', args, HoneypotCheckSchema);
  }

  async discoverPairs(input: HoneypotInput): Promise<HoneypotDiscoverPairs> {
    const args: Record<string, unknown> = { address: input.address };
    if (input.chainId !== undefined) args.chainId = input.chainId;
    return callAndParse(this.client, 'discover_pairs', args, DiscoverPairsSchema);
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  getClient(): McpStdioClient {
    return this.client;
  }
}
