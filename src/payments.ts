import type { Express } from 'express';
import {
  paymentMiddlewareFromHTTPServer,
  type SchemeRegistration,
} from '@x402/express';
import type {
  FacilitatorClient,
  PaywallConfig,
  ProtectedRequestHook,
  RoutesConfig,
} from '@x402/core/server';
import type { Network } from '@x402/core/types';
import {
  HTTPFacilitatorClient,
  x402HTTPResourceServer,
  x402ResourceServer,
} from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { bazaarResourceServerExtension } from '@x402/extensions';
import { CdpFacilitatorClient } from './payments/cdp-facilitator-client.js';
import {
  buildDiscoveryExtensions,
  marketDescription,
  honeypotDescription,
  forensicsDescription,
  reportDescription,
} from './discovery.js';

/**
 * Base mainnet network identifier in CAIP-2 form used by x402.
 */
export const BASE_NETWORK: Network = 'eip155:8453';

/**
 * Canonical Base-mainnet USDC ERC-20 address (Coinbase-native).
 * Source: https://developers.coinbase.com/stablecoins
 */
export const BASE_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

export const BASE_PATH = '/api/v1/x402/base';

export interface PaymentConfig {
  /** Address that receives settled USDC. */
  receivingAddress: string;
  /** Facilitator endpoint (no sensible public default for mainnet). */
  facilitatorUrl: string;
  /** Per-route USDC prices in dollars (e.g. "0.01"). */
  prices: {
    market: string;
    honeypot: string;
    forensics: string;
    report: string;
  };
  /**
   * When true, skip the startup call to the facilitator's `/supported` endpoint.
   * Primarily useful for tests that mock the facilitator; production should
   * leave this false so mis-configured networks fail loudly at boot.
   */
  syncFacilitatorOnStart?: boolean;
  /** Optional custom FacilitatorClient; when omitted an HTTP client is built. */
  facilitatorClient?: FacilitatorClient;
  /** Optional scheme override; defaults to ExactEvmScheme on Base mainnet. */
  schemes?: SchemeRegistration[];
  /** Optional paywall configuration passed through to the middleware. */
  paywallConfig?: PaywallConfig;
  /**
   * Optional hook that runs before payment processing on every protected
   * request. Primarily a test seam for granting access without a real
   * payment payload. Production use-cases (rate limits, auth) can also
   * hook here.
   */
  protectedRequestHook?: ProtectedRequestHook;
  /**
   * CDP API key ID. When provided along with cdpPrivateKey, enables
   * CdpFacilitatorClient usage instead of HTTPFacilitatorClient.
   */
  cdpKeyId?: string;
  /**
   * CDP API private key. When provided along with cdpKeyId, enables
   * CdpFacilitatorClient usage instead of HTTPFacilitatorClient.
   */
  cdpPrivateKey?: string;
}

/**
 * Canonical CDP facilitator URL. Bazaar discovery indexing only happens
 * when verify+settle traffic flows through the CDP facilitator — generic
 * HTTP facilitators do NOT index the catalog.
 */
export const CDP_FACILITATOR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402';

function isCdpFacilitator(url: string): boolean {
  // Tolerate trailing slashes and casing in the host.
  const normalized = url.trim().replace(/\/+$/, '');
  return normalized.toLowerCase() === CDP_FACILITATOR_URL.toLowerCase();
}

/**
 * Emit human-readable warnings when the payment configuration cannot
 * possibly result in Bazaar indexing. Each branch is non-fatal — we still
 * boot — but the warnings make misconfig visible from the first log line.
 *
 * Exported so tests can drive it directly.
 */
export function warnIfBazaarIndexingDisabled(
  config: PaymentConfig,
  log: (msg: string) => void = (m) => console.warn(m),
): void {
  const usingCdp = isCdpFacilitator(config.facilitatorUrl);
  if (!usingCdp) {
    log(
      `[base-token-oracle] FACILITATOR_URL=${config.facilitatorUrl} is not the CDP facilitator (${CDP_FACILITATOR_URL}). Bazaar discovery indexing is performed by CDP only — your resources will NOT appear in https://api.cdp.coinbase.com/platform/v2/x402/discovery/* until you switch.`,
    );
    return;
  }
  if (!config.cdpKeyId || !config.cdpPrivateKey) {
    log(
      '[base-token-oracle] FACILITATOR_URL points at the CDP facilitator but CDP_API_KEY_ID and/or CDP_API_KEY_PRIVATE_KEY are not set. Verify/settle calls will fail authentication and Bazaar indexing will not happen.',
    );
  }
}


function loadConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PaymentConfig | null {
  const receivingAddress = env.RECEIVING_ADDRESS?.trim();
  const facilitatorUrl = env.FACILITATOR_URL?.trim();
  if (!receivingAddress || !facilitatorUrl) {
    return null;
  }
  const cdpKeyId = env.CDP_API_KEY_ID?.trim();
  const cdpPrivateKey =
    env.CDP_API_KEY_PRIVATE_KEY?.trim() ?? env.CDP_API_KEY_SECRET?.trim();
  return {
    receivingAddress,
    facilitatorUrl,
    prices: {
      market: env.PRICE_MARKET ?? '0.005',
      honeypot: env.PRICE_HONEYPOT ?? '0.01',
      forensics: env.PRICE_FORENSICS ?? '0.02',
      report: env.PRICE_REPORT ?? '0.03',
    },
    ...(cdpKeyId && { cdpKeyId }),
    ...(cdpPrivateKey && { cdpPrivateKey }),
  };
}

/**
 * Public env helper used by `createApp` in server.ts. Returns `null` when
 * the two required vars are missing so the server can run in free mode.
 */
export function paymentConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): PaymentConfig | null {
  return loadConfigFromEnv(env);
}

function buildRoutes(config: PaymentConfig): RoutesConfig {
  const commonAccept = {
    scheme: 'exact' as const,
    network: BASE_NETWORK,
    payTo: config.receivingAddress,
    asset: BASE_USDC_ADDRESS,
  };
  const defs: Array<{ path: string; price: string; description: string }> = [
    {
      path: `${BASE_PATH}/token/:address/market`,
      price: config.prices.market,
      description: marketDescription,
    },
    {
      path: `${BASE_PATH}/token/:address/honeypot`,
      price: config.prices.honeypot,
      description: honeypotDescription,
    },
    {
      path: `${BASE_PATH}/token/:address/forensics`,
      price: config.prices.forensics,
      description: forensicsDescription,
    },
    {
      path: `${BASE_PATH}/token/:address/report`,
      price: config.prices.report,
      description: reportDescription,
    },
  ];
  const routes: RoutesConfig = {};
  const discoveries = buildDiscoveryExtensions();
  for (const d of defs) {
    const accepts = { ...commonAccept, price: `$${d.price}` };
    const getKey = `GET ${d.path}`;
    const baseEntry = {
      accepts,
      description: d.description,
      mimeType: 'application/json',
    };
    const discoveryExt = discoveries[getKey as `GET ${string}`];
    routes[getKey] = discoveryExt ? { ...baseEntry, extensions: discoveryExt } : baseEntry;
    // Register HEAD so Express's implicit HEAD->GET handling cannot bypass
    // the paywall. Without this, a HEAD request skips x402 entirely and
    // still executes the paid GET handler (all backend work, no body).
    // HEAD entries intentionally omit the bazaar discovery extension —
    // discovery indexes the GET resource only.
    routes[`HEAD ${d.path}`] = baseEntry;
  }
  return routes;
}

/**
 * Attach the x402 `paymentMiddleware` to the given Express app. Must be
 * called BEFORE the route routers are mounted so the paywall runs first.
 * Uses CdpFacilitatorClient if CDP credentials are provided, otherwise
 * falls back to HTTPFacilitatorClient.
 */
export function applyX402(app: Express, config: PaymentConfig): void {
  warnIfBazaarIndexingDisabled(config);
  const schemes: SchemeRegistration[] = config.schemes ?? [
    { network: BASE_NETWORK, server: new ExactEvmScheme() },
  ];
  const facilitator: FacilitatorClient =
    config.facilitatorClient ??
    (config.cdpKeyId && config.cdpPrivateKey
      ? (new CdpFacilitatorClient({
          facilitatorUrl: config.facilitatorUrl,
          cdpKeyId: config.cdpKeyId,
          cdpPrivateKey: config.cdpPrivateKey,
        }) as FacilitatorClient)
      : new HTTPFacilitatorClient({ url: config.facilitatorUrl }));
  const routes = buildRoutes(config);

  const resourceServer = new x402ResourceServer(facilitator);
  for (const s of schemes) {
    resourceServer.register(s.network, s.server);
  }
  // Enable Bazaar discovery indexing. The CDP facilitator will pick up
  // `extensions` declared on each route and surface them at
  // /v2/x402/discovery/resources (and on agentic.market) after the first
  // successful settlement per route.
  resourceServer.registerExtension(bazaarResourceServerExtension);
  const httpServer = new x402HTTPResourceServer(resourceServer, routes);
  if (config.protectedRequestHook) {
    httpServer.onProtectedRequest(config.protectedRequestHook);
  }

  app.use(
    paymentMiddlewareFromHTTPServer(
      httpServer,
      config.paywallConfig,
      undefined,
      config.syncFacilitatorOnStart ?? true,
    ),
  );
}
