import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { McpStdioClient, parseCommand, type ChildProcessLike } from '../../src/mcp/client.js';

class MockChild extends EventEmitter implements ChildProcessLike {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 12345;
  written: string[] = [];
  killed = false;

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      this.written.push(chunk.toString('utf8'));
    });
  }

  kill(_signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    return true;
  }

  /** Convenience — push a JSON-RPC response line on stdout. */
  pushResponse(obj: unknown): void {
    this.stdout.write(`${JSON.stringify(obj)}\n`);
  }

  /** Return the most recent JSON-RPC message written by the client. */
  lastWrittenJson(): { id?: number | string; method?: string; params?: unknown } {
    const joined = this.written.join('');
    const lines = joined.split('\n').filter((l) => l.trim().length > 0);
    const last = lines[lines.length - 1];
    return last ? JSON.parse(last) : {};
  }
}

function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 5);
    };
    tick();
  });
}

describe('parseCommand', () => {
  it('splits simple commands', () => {
    expect(parseCommand('node dist/index.js')).toEqual({
      command: 'node',
      args: ['dist/index.js'],
    });
  });

  it('handles quoted args', () => {
    expect(parseCommand('node "dist/index.js" --flag="hello world"')).toEqual({
      command: 'node',
      args: ['dist/index.js', '--flag=hello world'],
    });
  });

  it('throws on empty command', () => {
    expect(() => parseCommand('   ')).toThrow();
  });
});

describe('McpStdioClient', () => {
  it('performs initialize handshake and calls tools', async () => {
    const mock = new MockChild();
    const spawnImpl = vi.fn(() => mock);

    const client = new McpStdioClient({
      name: 'test',
      command: 'dummy',
      spawnImpl,
    });

    const startPromise = client.start();

    // Wait for the init request to be written, then respond.
    await waitFor(() => mock.written.join('').includes('"initialize"'));
    const initMsg = mock.lastWrittenJson();
    expect(initMsg.method).toBe('initialize');
    mock.pushResponse({
      jsonrpc: '2.0',
      id: initMsg.id,
      result: { protocolVersion: '2024-11-05', capabilities: {} },
    });

    await startPromise;
    expect(client.isRunning).toBe(true);

    // Subsequent tools/call request
    const callPromise = client.callTool('check_token', { address: '0xabc' });
    await waitFor(() => mock.written.join('').includes('"tools/call"'));
    const callMsg = mock.lastWrittenJson();
    expect(callMsg.method).toBe('tools/call');
    expect(callMsg.params).toEqual({ name: 'check_token', arguments: { address: '0xabc' } });

    mock.pushResponse({
      jsonrpc: '2.0',
      id: callMsg.id,
      result: {
        content: [{ type: 'text', text: JSON.stringify({ ok: true }) }],
      },
    });

    const result = await callPromise;
    expect(result.content?.[0]?.text).toContain('ok');

    await client.close();
    expect(mock.killed).toBe(true);
  });

  it('rejects on JSON-RPC error response', async () => {
    const mock = new MockChild();
    const client = new McpStdioClient({
      name: 'test',
      command: 'dummy',
      spawnImpl: () => mock,
    });

    const startPromise = client.start();
    await waitFor(() => mock.written.join('').includes('"initialize"'));
    const initMsg = mock.lastWrittenJson();
    mock.pushResponse({ jsonrpc: '2.0', id: initMsg.id, result: {} });
    await startPromise;

    const callPromise = client.callTool('broken', {});
    await waitFor(() => mock.written.join('').includes('"tools/call"'));
    const callMsg = mock.lastWrittenJson();
    mock.pushResponse({
      jsonrpc: '2.0',
      id: callMsg.id,
      error: { code: -32000, message: 'tool blew up' },
    });

    await expect(callPromise).rejects.toThrow(/tool blew up/);
    await client.close();
  });

  it('times out a call that gets no response', async () => {
    const mock = new MockChild();
    const client = new McpStdioClient({
      name: 'test',
      command: 'dummy',
      spawnImpl: () => mock,
      callTimeoutMs: 50,
    });

    const startPromise = client.start();
    await waitFor(() => mock.written.join('').includes('"initialize"'));
    const initMsg = mock.lastWrittenJson();
    mock.pushResponse({ jsonrpc: '2.0', id: initMsg.id, result: {} });
    await startPromise;

    const callPromise = client.callTool('slow', {});
    await expect(callPromise).rejects.toThrow(/timed out/);
    await client.close();
  });

  it('handles line-buffered multi-message stdout chunks', async () => {
    const mock = new MockChild();
    const client = new McpStdioClient({
      name: 'test',
      command: 'dummy',
      spawnImpl: () => mock,
    });

    const startPromise = client.start();
    await waitFor(() => mock.written.join('').includes('"initialize"'));
    const initMsg = mock.lastWrittenJson();
    // Send init response split across two chunks.
    const responseStr = `${JSON.stringify({ jsonrpc: '2.0', id: initMsg.id, result: {} })}\n`;
    mock.stdout.write(responseStr.slice(0, 10));
    mock.stdout.write(responseStr.slice(10));
    await startPromise;

    // Two concurrent calls, responses delivered in one chunk.
    const p1 = client.callTool('a', {});
    const p2 = client.callTool('b', {});
    await waitFor(() => {
      const joined = mock.written.join('');
      return (joined.match(/"tools\/call"/g)?.length ?? 0) >= 2;
    });
    const allMsgs = mock.written
      .join('')
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as { id: number; method: string });
    const callIds = allMsgs.filter((m) => m.method === 'tools/call').map((m) => m.id);

    const batched =
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: callIds[1],
        result: { content: [{ type: 'text', text: '"B"' }] },
      })}\n` +
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: callIds[0],
        result: { content: [{ type: 'text', text: '"A"' }] },
      })}\n`;
    mock.stdout.write(batched);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.content?.[0]?.text).toBe('"A"');
    expect(r2.content?.[0]?.text).toBe('"B"');

    await client.close();
  });
});
