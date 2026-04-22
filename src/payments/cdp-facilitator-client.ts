import { createPrivateKey, randomBytes, sign, type KeyObject } from 'crypto';
import type { FacilitatorClient } from '@x402/core/server';
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from '@x402/core/types';

export interface CdpFacilitatorClientConfig {
  facilitatorUrl: string;
  cdpKeyId: string;
  /**
   * CDP API key secret. Either:
   *   - A PEM-encoded Ed25519 private key (starting with `-----BEGIN`), OR
   *   - A base64-encoded 64-byte libsodium-style Ed25519 keypair
   *     (32-byte seed concatenated with 32-byte public key). This is the
   *     default format emitted by the CDP portal.
   */
  cdpPrivateKey: string;
  /**
   * Optional JWT lifetime in seconds. CDP recommends <= 120. Default 120.
   */
  jwtTtlSeconds?: number;
  /**
   * Optional per-request HTTP timeout in milliseconds. Default 10_000.
   * Applied via AbortSignal to prevent the x402 middleware (which awaits
   * verify/settle synchronously) from hanging indefinitely on a stalled
   * CDP response.
   */
  requestTimeoutMs?: number;
  /**
   * Optional number of retry attempts on HTTP 429 for idempotent GETs
   * (currently only `getSupported`). Default 3. Uses exponential backoff
   * (500ms, 1s, 2s...). Set to 0 to disable.
   */
  rateLimitRetries?: number;
}

/**
 * PKCS#8 DER prefix for a raw Ed25519 seed.
 *   SEQUENCE {
 *     INTEGER 0                       -- version
 *     SEQUENCE { OID 1.3.101.112 }    -- Ed25519 algorithm
 *     OCTET STRING { OCTET STRING ... } -- 32-byte seed
 *   }
 */
const PKCS8_ED25519_PREFIX = Buffer.from(
  '302e020100300506032b657004220420',
  'hex',
);

function ed25519KeyFromSecret(secret: string): KeyObject {
  const trimmed = secret.trim();
  if (trimmed.includes('-----BEGIN')) {
    return createPrivateKey(trimmed);
  }

  // Buffer.from(..., 'base64') never throws — it silently discards
  // invalid chars — so there is no point wrapping it in a try/catch.
  // We rely on the subsequent length check to reject bad input.
  const raw = Buffer.from(trimmed, 'base64');
  if (raw.length !== 64 && raw.length !== 32) {
    throw new Error(
      `CdpFacilitatorClient: expected 32- or 64-byte Ed25519 key, got ${raw.length} bytes`,
    );
  }
  const seed = raw.subarray(0, 32);
  const pkcs8 = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
  return createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
}

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * CDP-authenticated x402 facilitator client for Coinbase's CDP platform.
 *
 * Builds a short-lived Ed25519 JWT (EdDSA) per request and sends it as
 * `Authorization: Bearer <jwt>`, per
 * https://docs.cdp.coinbase.com/api-reference/v2/authentication.
 *
 * JWT claims:
 *   header:  { alg: "EdDSA", typ: "JWT", kid: <keyId>, nonce: <random> }
 *   payload: {
 *     sub:   <keyId>,
 *     iss:   "cdp",
 *     aud:   ["cdp_service"],
 *     nbf:   <now>,
 *     exp:   <now + ttl>,
 *     uri:   "<METHOD> <host><path>"
 *   }
 */
export class CdpFacilitatorClient implements FacilitatorClient {
  private readonly facilitatorUrl: string;
  private readonly cdpKeyId: string;
  private readonly privateKey: KeyObject;
  private readonly jwtTtlSeconds: number;
  private readonly requestTimeoutMs: number;
  private readonly rateLimitRetries: number;

  constructor(config: CdpFacilitatorClientConfig) {
    if (!config.facilitatorUrl) {
      throw new Error('CdpFacilitatorClient: facilitatorUrl is required');
    }
    if (!config.cdpKeyId) {
      throw new Error('CdpFacilitatorClient: cdpKeyId is required');
    }
    if (!config.cdpPrivateKey) {
      throw new Error('CdpFacilitatorClient: cdpPrivateKey is required');
    }

    this.facilitatorUrl = config.facilitatorUrl.replace(/\/$/, '');
    this.cdpKeyId = config.cdpKeyId;
    this.privateKey = ed25519KeyFromSecret(config.cdpPrivateKey);
    this.jwtTtlSeconds = Math.max(1, config.jwtTtlSeconds ?? 120);
    this.requestTimeoutMs = Math.max(1, config.requestTimeoutMs ?? 10_000);
    this.rateLimitRetries = Math.max(0, config.rateLimitRetries ?? 3);
  }

  /**
   * Build an Ed25519-signed JWT for the given HTTP request.
   *
   * @param method - HTTP method in upper case (GET, POST, ...)
   * @param url    - Fully-resolved request URL (used to derive host + path)
   */
  private createJwt(method: string, url: URL): string {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const nonce = randomBytes(8).toString('hex');

    const header = {
      alg: 'EdDSA',
      typ: 'JWT',
      kid: this.cdpKeyId,
      nonce,
    };
    const payload = {
      sub: this.cdpKeyId,
      iss: 'cdp',
      aud: ['cdp_service'],
      nbf: nowSeconds,
      exp: nowSeconds + this.jwtTtlSeconds,
      uri: `${method.toUpperCase()} ${url.host}${url.pathname}`,
    };

    const encodedHeader = base64UrlEncode(JSON.stringify(header));
    const encodedPayload = base64UrlEncode(JSON.stringify(payload));
    const signingInput = `${encodedHeader}.${encodedPayload}`;

    const signature = sign(null, Buffer.from(signingInput), this.privateKey);
    return `${signingInput}.${base64UrlEncode(signature)}`;
  }

  /**
   * Perform an authenticated request to a CDP facilitator endpoint.
   *
   * @param path    - Endpoint path (e.g., "verify", "settle", "supported")
   * @param method  - HTTP method
   * @param payload - Optional JSON request body
   * @param opts    - Optional behavior flags
   * @throws Error with a message prefixed `CDP facilitator error` for HTTP
   *         failures, or `CDP facilitator request failed` for network errors.
   */
  private async authenticatedRequest<T>(
    path: string,
    method: string,
    payload?: unknown,
    opts: { retryOn429?: boolean } = {},
  ): Promise<T> {
    const url = new URL(`${this.facilitatorUrl}/${path}`);
    const body = payload ? JSON.stringify(this.toJsonSafe(payload)) : '';

    const maxAttempts =
      opts.retryOn429 && this.rateLimitRetries > 0
        ? this.rateLimitRetries + 1
        : 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Re-sign per attempt — JWT nonce/exp must be fresh.
      const jwt = this.createJwt(method, url);
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${jwt}`,
      };

      try {
        const response = await fetch(url.toString(), {
          method,
          headers,
          body: body || undefined,
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });

        if (response.status === 429 && attempt < maxAttempts) {
          // Drain body to free the socket before retrying.
          await response.text().catch(() => undefined);
          const backoffMs = 500 * 2 ** (attempt - 1);
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }

        if (!response.ok) {
          const contentType = response.headers.get('content-type');
          const errorBody = contentType?.includes('application/json')
            ? await response.json()
            : await response.text();
          throw new Error(
            `CDP facilitator error (${response.status}): ${
              typeof errorBody === 'string'
                ? errorBody
                : JSON.stringify(errorBody)
            }`,
          );
        }

        return (await response.json()) as T;
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.startsWith('CDP facilitator error')
        ) {
          throw error;
        }
        lastError = error;
        // Network/timeout: fall through — do not retry by default; only
        // 429s (handled above) retry.
        break;
      }
    }

    const err = lastError;
    throw new Error(
      `CDP facilitator request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  async verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    return this.authenticatedRequest<VerifyResponse>('verify', 'POST', {
      x402Version: (paymentPayload as { x402Version?: number }).x402Version,
      paymentPayload,
      paymentRequirements,
    });
  }

  async settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    return this.authenticatedRequest<SettleResponse>('settle', 'POST', {
      x402Version: (paymentPayload as { x402Version?: number }).x402Version,
      paymentPayload,
      paymentRequirements,
    });
  }

  async getSupported(): Promise<SupportedResponse> {
    return this.authenticatedRequest<SupportedResponse>(
      'supported',
      'GET',
      undefined,
      { retryOn429: true },
    );
  }

  /**
   * Recursively convert BigInt values to strings so the payload is
   * JSON-serializable. Other primitives and plain objects pass through.
   */
  private toJsonSafe(obj: unknown): unknown {
    if (typeof obj === 'bigint') {
      return obj.toString();
    }
    if (Array.isArray(obj)) {
      return obj.map((item) => this.toJsonSafe(item));
    }
    if (obj !== null && typeof obj === 'object') {
      return Object.fromEntries(
        Object.entries(obj).map(([key, value]) => [
          key,
          this.toJsonSafe(value),
        ]),
      );
    }
    return obj;
  }
}
