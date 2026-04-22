import express, { type Express } from 'express';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { createMcpManagerFromEnv, type McpManager } from './mcp/index.js';
import { createMarketRouter } from './routes/market.js';
import { createHoneypotRouter } from './routes/honeypot.js';
import { createForensicsRouter } from './routes/forensics.js';
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
}

export function createApp(options: CreateAppOptions = {}): Express {
  const app = express();
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
  if (mcp.dexScreener) {
    app.use(basePath, createMarketRouter({ dexScreener: mcp.dexScreener, cache }));
  }
  if (mcp.honeypot) {
    app.use(basePath, createHoneypotRouter({ honeypot: mcp.honeypot, cache }));
  }
  if (mcp.blockscout) {
    app.use(basePath, createForensicsRouter({ blockscout: mcp.blockscout, cache }));
  }
  if (mcp.dexScreener || mcp.honeypot || mcp.blockscout) {
    app.use(
      basePath,
      createReportRouter({
        dexScreener: mcp.dexScreener,
        honeypot: mcp.honeypot,
        blockscout: mcp.blockscout,
        cache,
      }),
    );
  }

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
  const app = createApp({ publicDir, ...(payments ? { payments } : {}) });
  app.listen(port, () => {
    console.log(
      `[base-token-oracle] listening on :${port} (x402=${payments ? 'on' : 'off'})`,
    );
  });
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  main();
}
