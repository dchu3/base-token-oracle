import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { McpStdioClient, type ChildProcessLike } from '../../src/mcp/client.js';
import { BlockscoutService } from '../../src/mcp/blockscout.js';

class MockChild extends EventEmitter implements ChildProcessLike {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 1;
  written = '';
  constructor() {
    super();
    this.stdin.on('data', (c: Buffer) => {
      this.written += c.toString('utf8');
    });
  }
  kill(): boolean {
    return true;
  }
  lastJsonMatching(method: string): { id: number | string; method: string; params: unknown } {
    const lines = this.written
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { id: number; method: string; params: unknown });
    const m = [...lines].reverse().find((x) => x.method === method);
    if (!m) throw new Error(`no line with method ${method}`);
    return m;
  }
}

async function initAndRespond(
  mock: MockChild,
  client: McpStdioClient,
  toolResultPayload: unknown,
): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  // Wait for init
  while (!mock.written.includes('"initialize"')) {
    await new Promise((r) => setTimeout(r, 1));
  }
  const initMsg = mock.lastJsonMatching('initialize');
  mock.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: initMsg.id, result: {} })}\n`);

  // Wait for tool call
  while (!mock.written.includes('"tools/call"')) {
    await new Promise((r) => setTimeout(r, 1));
  }
  const callMsg = mock.lastJsonMatching('tools/call');
  mock.stdout.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: callMsg.id,
      result: {
        content: [{ type: 'text', text: JSON.stringify(toolResultPayload) }],
      },
    })}\n`,
  );
  // Keep reference to client for type-checker
  void client;
}

describe('BlockscoutService', () => {
  it('calls get_token with default chain=base', async () => {
    const mock = new MockChild();
    const client = new McpStdioClient({
      name: 'bs',
      command: 'dummy',
      spawnImpl: (() => mock) as never,
    });
    const svc = new BlockscoutService(client);

    const promise = svc.getToken('0xabc');
    await initAndRespond(mock, client, { address: '0xabc', name: 'T', symbol: 'T' });
    const tok = await promise;
    expect(tok.symbol).toBe('T');

    const call = mock.lastJsonMatching('tools/call') as {
      params: { name: string; arguments: Record<string, unknown> };
    };
    expect(call.params.name).toBe('get_token');
    expect(call.params.arguments).toEqual({ address_hash: '0xabc', chain: 'base' });
    await svc.close();
  });

  it('passes chain override for get_token_holders', async () => {
    const mock = new MockChild();
    const client = new McpStdioClient({
      name: 'bs',
      command: 'dummy',
      spawnImpl: (() => mock) as never,
    });
    const svc = new BlockscoutService(client);

    const promise = svc.getTokenHolders('0xdef', 'ethereum');
    await initAndRespond(mock, client, { items: [] });
    await promise;

    const call = mock.lastJsonMatching('tools/call') as {
      params: { arguments: Record<string, unknown> };
    };
    expect(call.params.arguments).toEqual({ address_hash: '0xdef', chain: 'ethereum' });
    await svc.close();
  });

  it('rejects when response fails schema validation', async () => {
    const mock = new MockChild();
    const client = new McpStdioClient({
      name: 'bs',
      command: 'dummy',
      spawnImpl: (() => mock) as never,
    });
    const svc = new BlockscoutService(client);

    const promise = svc.getAddress('0xabc');
    // Respond with a total non-object to force validation failure
    const init = vi.fn();
    init();
    // Manually drive init + call with a non-conforming payload.
    while (!mock.written.includes('"initialize"')) {
      await new Promise((r) => setTimeout(r, 1));
    }
    const initMsg = mock.lastJsonMatching('initialize');
    mock.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: initMsg.id, result: {} })}\n`);
    while (!mock.written.includes('"tools/call"')) {
      await new Promise((r) => setTimeout(r, 1));
    }
    const callMsg = mock.lastJsonMatching('tools/call');
    mock.stdout.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: callMsg.id,
        result: { content: [{ type: 'text', text: '"not-an-object"' }] },
      })}\n`,
    );
    await expect(promise).rejects.toThrow(/schema validation/);
    await svc.close();
  });

  it('accepts get_token responses with null decimals and total_supply', async () => {
    // Regression: Blockscout returns explicit null for decimals/total_supply on
    // some sparsely-indexed Base tokens (e.g. 0x65021a79AeEF22b17cdc1B768f5e79a8618bEbA3).
    // The upstream TokenInfoSchema previously declared these as optional() but
    // not nullable(), causing the whole report to 500 with upstream_error.
    const mock = new MockChild();
    const client = new McpStdioClient({
      name: 'bs',
      command: 'dummy',
      spawnImpl: (() => mock) as never,
    });
    const svc = new BlockscoutService(client);

    const promise = svc.getToken('0x65021a79aeef22b17cdc1b768f5e79a8618beba3');
    await initAndRespond(mock, client, {
      address: '0x65021a79aeef22b17cdc1b768f5e79a8618beba3',
      name: null,
      symbol: null,
      decimals: null,
      total_supply: null,
      type: null,
      holders: null,
      holders_count: null,
      circulating_market_cap: null,
      exchange_rate: null,
    });
    const tok = await promise;
    expect(tok.decimals).toBeNull();
    expect(tok.total_supply).toBeNull();
    expect(tok.name).toBeNull();
    expect(tok.symbol).toBeNull();
    await svc.close();
  });
});
