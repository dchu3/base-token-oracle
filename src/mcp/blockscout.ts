import { z } from 'zod';
import { McpStdioClient, parseCommand } from './client.js';
import { callAndParse } from './shared.js';

export type BlockscoutChain = 'base' | 'ethereum';

const TokenInfoSchema = z
  .object({
    address: z.string().optional(),
    address_hash: z.string().optional(),
    name: z.string().optional(),
    symbol: z.string().optional(),
    decimals: z.union([z.string(), z.number()]).optional(),
    type: z.string().optional(),
    total_supply: z.string().optional(),
    holders: z.union([z.string(), z.number()]).optional(),
    holders_count: z.union([z.string(), z.number()]).optional(),
    circulating_market_cap: z.string().nullable().optional(),
    exchange_rate: z.string().nullable().optional(),
  })
  .passthrough();

export type BlockscoutToken = z.infer<typeof TokenInfoSchema>;

const TokenHolderSchema = z
  .object({
    address: z
      .object({
        hash: z.string().optional(),
      })
      .partial()
      .passthrough()
      .optional(),
    value: z.string().optional(),
    token_id: z.string().nullable().optional(),
  })
  .passthrough();

const TokenHoldersSchema = z
  .object({
    items: z.array(TokenHolderSchema).optional(),
    next_page_params: z.unknown().nullable().optional(),
  })
  .passthrough();

export type BlockscoutHolders = z.infer<typeof TokenHoldersSchema>;

const AddressSchema = z
  .object({
    hash: z.string().optional(),
    is_contract: z.boolean().optional(),
    is_verified: z.boolean().optional(),
    coin_balance: z.string().nullable().optional(),
    creator_address_hash: z.string().nullable().optional(),
    creation_tx_hash: z.string().nullable().optional(),
    token: TokenInfoSchema.optional(),
  })
  .passthrough();

export type BlockscoutAddress = z.infer<typeof AddressSchema>;

const AddressTxSchema = z
  .object({
    hash: z.string().optional(),
    block_number: z.union([z.string(), z.number()]).optional(),
    timestamp: z.string().optional(),
    value: z.string().optional(),
    method: z.string().nullable().optional(),
    from: z
      .object({ hash: z.string().optional() })
      .partial()
      .passthrough()
      .optional(),
    to: z
      .object({ hash: z.string().optional() })
      .partial()
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

const AddressTxsSchema = z
  .object({
    items: z.array(AddressTxSchema).optional(),
    next_page_params: z.unknown().nullable().optional(),
  })
  .passthrough();

export type BlockscoutAddressTxs = z.infer<typeof AddressTxsSchema>;

export interface BlockscoutServiceOptions {
  command: string;
  callTimeoutMs?: number;
}

export class BlockscoutService {
  private readonly client: McpStdioClient;

  constructor(options: BlockscoutServiceOptions | McpStdioClient) {
    if (options instanceof McpStdioClient) {
      this.client = options;
      return;
    }
    const { command, args } = parseCommand(options.command);
    this.client = new McpStdioClient({
      name: 'blockscout',
      command,
      args,
      callTimeoutMs: options.callTimeoutMs,
    });
  }

  async getToken(addressHash: string, chain: BlockscoutChain = 'base'): Promise<BlockscoutToken> {
    return callAndParse(
      this.client,
      'get_token',
      { address_hash: addressHash, chain },
      TokenInfoSchema,
    );
  }

  async getTokenHolders(
    addressHash: string,
    chain: BlockscoutChain = 'base',
  ): Promise<BlockscoutHolders> {
    return callAndParse(
      this.client,
      'get_token_holders',
      { address_hash: addressHash, chain },
      TokenHoldersSchema,
    );
  }

  async getAddress(
    addressHash: string,
    chain: BlockscoutChain = 'base',
  ): Promise<BlockscoutAddress> {
    return callAndParse(
      this.client,
      'get_address',
      { address_hash: addressHash, chain },
      AddressSchema,
    );
  }

  async getAddressTransactions(
    addressHash: string,
    chain: BlockscoutChain = 'base',
  ): Promise<BlockscoutAddressTxs> {
    return callAndParse(
      this.client,
      'get_address_transactions',
      { address_hash: addressHash, chain },
      AddressTxsSchema,
    );
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  getClient(): McpStdioClient {
    return this.client;
  }
}
