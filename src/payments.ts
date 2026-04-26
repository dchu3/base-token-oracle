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
  reportDescription,
} from './discovery.js';

/**
 * Base mainnet network identifier in CAIP-2 form used by x402.
 */
export const BASE_NETWORK: Network = 'eip155:8453';

/**
 * Canonical Base-mainnet USDC ERC-20 address (Coinbase-native).
 */
export const BASE_USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

export const BASE_PATH = '/api/v1/x402/base';

export interface PaymentConfig {
  /** Address that receives settled USDC. */
  receivingAddress: string;
  /** Facilitator endpoint. */
  facilitatorUrl: string;
  /** Per-route USDC prices in dollars (e.g. "0.01"). */
  prices: {
    report: string;
  };
  syncFacilitatorOnStart?: boolean;
  facilitatorClient?: FacilitatorClient;
  schemes?: SchemeRegistration[];
  paywallConfig?: PaywallConfig;
  protectedRequestHook?: ProtectedRequestHook;
  cdpKeyId?: string;
  cdpPrivateKey?: string;
}

export const CDP_FACILITATOR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402';

function isCdpFacilitator(url: string): boolean {
  const normalized = url.trim().replace(/\/+$/, '');
  return normalized.toLowerCase() === CDP_FACILITATOR_URL.toLowerCase();
}

export function warnIfBazaarIndexingDisabled(
  config: PaymentConfig,
  log: (msg: string) => void = (m) => console.warn(m),
): void {
  const usingCdp = isCdpFacilitator(config.facilitatorUrl);
  if (!usingCdp) {
    log(
      `[base-token-oracle] FACILITATOR_URL=${config.facilitatorUrl} is not the CDP facilitator (${CDP_FACILITATOR_URL}). Bazaar discovery indexing is performed by CDP only.`,
    );
    return;
  }
  if (!config.cdpKeyId || !config.cdpPrivateKey) {
    log(
      '[base-token-oracle] FACILITATOR_URL points at the CDP facilitator but CDP_API_KEY_ID and/or CDP_API_KEY_PRIVATE_KEY are not set.',
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
      report: env.PRICE_REPORT ?? '0.01',
    },
    ...(cdpKeyId && { cdpKeyId }),
    ...(cdpPrivateKey && { cdpPrivateKey }),
  };
}

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
    routes[`HEAD ${d.path}`] = baseEntry;
  }
  return routes;
}

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
