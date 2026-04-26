import express, { type Express } from 'express';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { createMcpManagerFromEnv, type McpManager } from './mcp/index.js';
import { createReportRouter } from './routes/report.js';
import { createCacheFromEnv, type TtlLruCache } from './cache.js';
import { applyX402, paymentConfigFromEnv, type PaymentConfig } from './payments.js';

export interface CreateAppOptions {
  mcp?: McpManager;
  cache?: TtlLruCache<unknown> | null;
  payments?: PaymentConfig;
  /**
   * Optional directory served as static files at the app root. Used to
   * expose `/llms.txt`, `/openapi.yaml`, and similar discovery artifacts
   * without touching the paywall.
   */
  publicDir?: string;
  /**
   * Express `trust proxy` setting. When the oracle runs behind a reverse
   * proxy that terminates TLS (e.g. Caddy, nginx), this MUST be set so
   * `req.protocol` reflects the original `X-Forwarded-Proto` header.
   * Otherwise `@x402/express` will build the resource URL with `http://`,
   * which causes the CDP Bazaar to index/reject our resources under the
   * wrong origin.
   *
   * Accepts any value Express's `trust proxy` accepts: a boolean, a
   * subnet/list string, an integer hop count, or a custom function.
   * Defaults to `'loopback, linklocal, uniquelocal'` so docker-compose
   * deployments behind a sibling Caddy container Just Work without
   * trusting external proxies.
   */
  trustProxy?: boolean | string | number | ((ip: string, hop: number) => boolean);
}

export const DEFAULT_TRUST_PROXY = 'loopback, linklocal, uniquelocal';

export function createApp(options: CreateAppOptions = {}): Express {
  const app = express();
  // Configure trust proxy BEFORE any middleware so req.protocol /
  // req.secure / req.ip honor X-Forwarded-* throughout the request
  // lifecycle (including the x402 paywall).
  app.set('trust proxy', options.trustProxy ?? DEFAULT_TRUST_PROXY);
  app.use(express.json());

  const paymentsActive = options.payments !== undefined;
  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, x402: paymentsActive });
  });

  if (options.publicDir) {
    app.use(express.static(options.publicDir));
  }

  if (options.payments) {
    applyX402(app, options.payments);
  }

  const mcp = options.mcp ?? createMcpManagerFromEnv();
  const cache = options.cache === undefined ? createCacheFromEnv() : options.cache;
  const basePath = '/api/v1/x402/base';

  app.use(basePath, createReportRouter({ blockscout: mcp.blockscout, cache }));

  return app;
}

function main(): void {
  const port = Number(process.env.PORT ?? 8080);
  const payments = paymentConfigFromEnv();
  if (!payments) {
    console.warn(
      '[base-token-oracle] RECEIVING_ADDRESS and/or FACILITATOR_URL not set — x402 paywall disabled. Running in free mode.',
    );
  }
  const publicDir =
    process.env.PUBLIC_DIR ?? fileURLToPath(new URL('../public', import.meta.url));
  const trustProxy = parseTrustProxyEnv(process.env.TRUST_PROXY);
  const app = createApp({
    publicDir,
    ...(trustProxy !== undefined && { trustProxy }),
    ...(payments ? { payments } : {}),
  });
  app.listen(port, () => {
    console.log(
      `[base-token-oracle] listening on :${port} (x402=${payments ? 'on' : 'off'})`,
    );
  });
}

/**
 * Parse the `TRUST_PROXY` env var into the value Express accepts. We support:
 * - unset → fall back to the createApp default
 * - `"true"` / `"false"` → boolean
 * - integer string → hop count
 * - any other string → passed through as a subnet list
 */
function parseTrustProxyEnv(
  raw: string | undefined,
): boolean | string | number | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  if (trimmed.toLowerCase() === 'true') return true;
  if (trimmed.toLowerCase() === 'false') return false;
  const n = Number(trimmed);
  if (Number.isInteger(n) && n >= 0 && /^\d+$/.test(trimmed)) return n;
  return trimmed;
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  main();
}
