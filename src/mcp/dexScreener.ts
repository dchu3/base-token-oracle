import { z } from 'zod';
import { McpStdioClient, parseCommand } from './client.js';
import { callAndParse } from './shared.js';

const PairTokenSchema = z
  .object({
    address: z.string(),
    name: z.string().optional(),
    symbol: z.string().optional(),
  })
  .passthrough();

const PairSchema = z
  .object({
    chainId: z.string().optional(),
    dexId: z.string().optional(),
    url: z.string().optional(),
    pairAddress: z.string().optional(),
    baseToken: PairTokenSchema.optional(),
    quoteToken: PairTokenSchema.optional(),
    priceNative: z.string().optional(),
    priceUsd: z.string().optional(),
    liquidity: z
      .object({
        usd: z.number().optional(),
        base: z.number().optional(),
        quote: z.number().optional(),
      })
      .partial()
      .passthrough()
      .optional(),
    fdv: z.number().optional(),
    marketCap: z.number().optional(),
    pairCreatedAt: z.number().optional(),
    volume: z.record(z.number()).optional(),
    priceChange: z.record(z.number()).optional(),
  })
  .passthrough();

export type DexScreenerPair = z.infer<typeof PairSchema>;

const PairsArraySchema = z.array(PairSchema);

const GetTokenPoolsResponseSchema = z.union([
  PairsArraySchema,
  z.object({ pairs: PairsArraySchema }).passthrough(),
]);

const GetTokensByAddressResponseSchema = z.union([
  PairsArraySchema,
  z.object({ pairs: PairsArraySchema }).passthrough(),
]);

const GetPairsByChainAndPairResponseSchema = z.union([
  PairsArraySchema,
  z.object({ pairs: PairsArraySchema }).passthrough(),
  z.object({ pair: PairSchema }).passthrough(),
]);

function normalizePairs(data: z.infer<typeof GetTokenPoolsResponseSchema>): DexScreenerPair[] {
  if (Array.isArray(data)) return data;
  if ('pairs' in data && Array.isArray(data.pairs)) return data.pairs;
  return [];
}

export interface DexScreenerServiceOptions {
  command: string;
  callTimeoutMs?: number;
}

export class DexScreenerService {
  private readonly client: McpStdioClient;

  constructor(options: DexScreenerServiceOptions | McpStdioClient) {
    if (options instanceof McpStdioClient) {
      this.client = options;
      return;
    }
    const { command, args } = parseCommand(options.command);
    this.client = new McpStdioClient({
      name: 'dex-screener',
      command,
      args,
      callTimeoutMs: options.callTimeoutMs,
    });
  }

  async getTokenPools(chainId: string, tokenAddress: string): Promise<DexScreenerPair[]> {
    const data = await callAndParse(
      this.client,
      'get_token_pools',
      { chainId, tokenAddress },
      GetTokenPoolsResponseSchema,
    );
    return normalizePairs(data);
  }

  async getTokensByAddress(chainId: string, addresses: string[]): Promise<DexScreenerPair[]> {
    const tokenAddresses = addresses.join(',');
    const data = await callAndParse(
      this.client,
      'get_tokens_by_address',
      { chainId, tokenAddresses },
      GetTokensByAddressResponseSchema,
    );
    return normalizePairs(data);
  }

  async getPairsByChainAndPair(chainId: string, pairId: string): Promise<DexScreenerPair[]> {
    const data: unknown = await callAndParse(
      this.client,
      'get_pairs_by_chain_and_pair',
      { chainId, pairId },
      GetPairsByChainAndPairResponseSchema,
    );
    if (Array.isArray(data)) return data as DexScreenerPair[];
    if (data && typeof data === 'object') {
      const maybePairs = (data as { pairs?: unknown }).pairs;
      if (Array.isArray(maybePairs)) return maybePairs as DexScreenerPair[];
      const maybePair = (data as { pair?: unknown }).pair;
      if (maybePair && typeof maybePair === 'object') return [maybePair as DexScreenerPair];
    }
    return [];
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  /** Test hook — not part of the stable public surface. */
  getClient(): McpStdioClient {
    return this.client;
  }
}
