import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';

const JSONRPC_VERSION = '2.0';
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_CALL_TIMEOUT_MS = 30_000;

export interface McpClientOptions {
  name: string;
  command: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  callTimeoutMs?: number;
  clientInfo?: { name: string; version: string };
  spawnImpl?: SpawnImpl;
}

export type SpawnImpl = (
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; cwd?: string },
) => ChildProcessLike;

export interface ChildProcessLike extends EventEmitter {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
}

interface JsonRpcRequest {
  jsonrpc: typeof JSONRPC_VERSION;
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: typeof JSONRPC_VERSION;
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpToolCallResult {
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
  [k: string]: unknown;
}

export class McpError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = 'McpError';
  }
}

export class McpTimeoutError extends Error {
  constructor(method: string, timeoutMs: number) {
    super(`MCP call ${method} timed out after ${timeoutMs}ms`);
    this.name = 'McpTimeoutError';
  }
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
};

/**
 * Minimal stdio MCP JSON-RPC 2.0 client.
 *
 * - Spawns a child process on `start()`, performs `initialize` handshake.
 * - Line-buffered JSON on stdout, id-based response routing.
 * - Per-call timeout, graceful `close()`.
 */
export class McpStdioClient {
  private readonly opts: Required<Omit<McpClientOptions, 'env' | 'cwd' | 'args' | 'spawnImpl'>> & {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    args: string[];
    spawnImpl: SpawnImpl;
  };
  private child: ChildProcessLike | null = null;
  private nextId = 1;
  private readonly pending = new Map<number | string, Pending>();
  private stdoutBuffer = '';
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private closed = false;

  constructor(options: McpClientOptions) {
    this.opts = {
      name: options.name,
      command: options.command,
      args: options.args ?? [],
      env: options.env,
      cwd: options.cwd,
      callTimeoutMs: options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
      clientInfo: options.clientInfo ?? { name: 'base-token-oracle', version: '0.1.0' },
      spawnImpl: options.spawnImpl ?? defaultSpawn,
    };
  }

  get isRunning(): boolean {
    return this.child !== null && !this.closed;
  }

  async start(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doStart();
    try {
      await this.initPromise;
    } catch (err) {
      this.initPromise = null;
      throw err;
    }
  }

  private async doStart(): Promise<void> {
    if (this.closed) {
      throw new McpError(`MCP client ${this.opts.name} is closed`);
    }

    const child = this.opts.spawnImpl(this.opts.command, this.opts.args, {
      env: this.opts.env,
      cwd: this.opts.cwd,
    });
    this.child = child;

    child.stdout.setEncoding?.('utf8');
    child.stdout.on('data', (chunk: string | Buffer) => {
      this.onStdout(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    });
    child.stderr.setEncoding?.('utf8');
    child.stderr.on('data', (chunk: string | Buffer) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (text.trim().length > 0) {
        console.error(`[mcp:${this.opts.name}] ${text.trimEnd()}`);
      }
    });
    child.on('exit', (code, signal) => {
      const err = new McpError(
        `MCP process ${this.opts.name} exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
      );
      this.failAllPending(err);
      this.child = null;
      this.initialized = false;
    });
    child.on('error', (err: Error) => {
      this.failAllPending(new McpError(`MCP process ${this.opts.name} error: ${err.message}`));
    });

    await this.request('initialize', {
      protocolVersion: DEFAULT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: this.opts.clientInfo,
    });
    this.sendNotification('notifications/initialized', {});
    this.initialized = true;
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolCallResult> {
    await this.start();
    const result = await this.request('tools/call', { name, arguments: args });
    return result as McpToolCallResult;
  }

  async listTools(): Promise<unknown> {
    await this.start();
    return this.request('tools/list', {});
  }

  async close(): Promise<void> {
    this.closed = true;
    this.initialized = false;
    this.initPromise = null;
    this.failAllPending(new McpError(`MCP client ${this.opts.name} closed`));
    const child = this.child;
    this.child = null;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      // ignore
    }
    try {
      child.kill('SIGTERM');
    } catch {
      // ignore
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (!this.child) {
        reject(new McpError(`MCP client ${this.opts.name} not started`));
        return;
      }
      const id = this.nextId++;
      const payload: JsonRpcRequest = { jsonrpc: JSONRPC_VERSION, id, method, params };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpTimeoutError(method, this.opts.callTimeoutMs));
      }, this.opts.callTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.child.stdin.write(`${JSON.stringify(payload)}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new McpError(String(err)));
      }
    });
  }

  private sendNotification(method: string, params: unknown): void {
    if (!this.child) return;
    const payload = { jsonrpc: JSONRPC_VERSION, method, params };
    try {
      this.child.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch {
      // ignore
    }
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIdx: number;
    while ((newlineIdx = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIdx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1);
      if (line.length === 0) continue;
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(line) as JsonRpcResponse;
    } catch {
      console.error(`[mcp:${this.opts.name}] non-JSON stdout line: ${line}`);
      return;
    }
    if (msg.id === undefined || msg.id === null) {
      // Server -> client notification; ignored for now.
      return;
    }
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) {
      pending.reject(new McpError(msg.error.message, msg.error.code, msg.error.data));
      return;
    }
    pending.resolve(msg.result);
  }

  private failAllPending(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }
}

const defaultSpawn: SpawnImpl = (command, args, options) => {
  const child: ChildProcessWithoutNullStreams = spawn(command, args, {
    env: options.env ?? process.env,
    cwd: options.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return child;
};

/**
 * Parse a shell-style command string into argv (command + args).
 * Handles simple quoting (single or double) — good enough for env-configured
 * commands like `node /abs/path/dist/index.js --flag`.
 */
export function parseCommand(command: string): { command: string; args: string[] } {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  if (tokens.length === 0) {
    throw new Error('Empty command string');
  }
  const [cmd, ...args] = tokens;
  return { command: cmd as string, args };
}
