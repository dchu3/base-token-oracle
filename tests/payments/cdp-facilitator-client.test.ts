import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  generateKeyPairSync,
  verify as cryptoVerify,
} from 'crypto';
import { CdpFacilitatorClient } from '../../src/payments/cdp-facilitator-client';
import type {
  PaymentPayload,
  PaymentRequirements,
} from '@x402/core/types';

// Generate one Ed25519 keypair for the whole suite. We use PEM + libsodium
// base64 (seed||pub) to exercise both ingest paths.
const { privateKey: testPrivateKey, publicKey: testPublicKey } =
  generateKeyPairSync('ed25519');
const testPrivateKeyPem = testPrivateKey
  .export({ format: 'pem', type: 'pkcs8' })
  .toString();

// Build the libsodium-style base64 (32-byte seed || 32-byte public key).
const privJwk = testPrivateKey.export({ format: 'jwk' }) as {
  d?: string;
  x?: string;
};
if (!privJwk.d || !privJwk.x) {
  throw new Error('failed to extract Ed25519 seed/pub for tests');
}
const seed = Buffer.from(privJwk.d, 'base64url');
const pub = Buffer.from(privJwk.x, 'base64url');
const testPrivateKeyLibsodium = Buffer.concat([seed, pub]).toString('base64');

function base64UrlDecode(input: string): Buffer {
  const padded = input + '='.repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function decodeJwt(jwt: string): {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: Buffer;
} {
  const [h, p, s] = jwt.split('.');
  return {
    header: JSON.parse(base64UrlDecode(h).toString('utf8')),
    payload: JSON.parse(base64UrlDecode(p).toString('utf8')),
    signingInput: `${h}.${p}`,
    signature: base64UrlDecode(s),
  };
}

const baseConfig = {
  facilitatorUrl: 'https://facilitator.example.com',
  cdpKeyId: 'test-key-id',
  cdpPrivateKey: testPrivateKeyPem,
};

const mockPaymentPayload: PaymentPayload = {
  kind: 'erc20',
  paymentReference: 'ref123',
  amount: BigInt('1000000000000000000'),
  chainId: 8453,
  tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  from: '0x1234567890123456789012345678901234567890',
  to: '0x0987654321098765432109876543210987654321',
} as unknown as PaymentPayload;

const mockPaymentRequirements: PaymentRequirements = {
  kind: 'erc20',
  chainId: 8453,
  tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  minimumAmount: BigInt('1000000000000000000'),
} as unknown as PaymentRequirements;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('CdpFacilitatorClient', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('constructor validation', () => {
    it('throws when facilitatorUrl missing', () => {
      expect(
        () =>
          new CdpFacilitatorClient({
            ...baseConfig,
            facilitatorUrl: '',
          }),
      ).toThrow('facilitatorUrl is required');
    });

    it('throws when cdpKeyId missing', () => {
      expect(
        () => new CdpFacilitatorClient({ ...baseConfig, cdpKeyId: '' }),
      ).toThrow('cdpKeyId is required');
    });

    it('throws when cdpPrivateKey missing', () => {
      expect(
        () => new CdpFacilitatorClient({ ...baseConfig, cdpPrivateKey: '' }),
      ).toThrow('cdpPrivateKey is required');
    });

    it('rejects an invalid private key length', () => {
      expect(
        () =>
          new CdpFacilitatorClient({
            ...baseConfig,
            // 10 random base64 bytes → wrong length
            cdpPrivateKey: Buffer.from('0123456789').toString('base64'),
          }),
      ).toThrow(/Ed25519 key/);
    });

    it('accepts PEM-encoded Ed25519 key', () => {
      expect(
        () => new CdpFacilitatorClient(baseConfig),
      ).not.toThrow();
    });

    it('accepts libsodium (seed||pub) base64 Ed25519 key', () => {
      expect(
        () =>
          new CdpFacilitatorClient({
            ...baseConfig,
            cdpPrivateKey: testPrivateKeyLibsodium,
          }),
      ).not.toThrow();
    });

    it('strips trailing slash from facilitatorUrl', async () => {
      const client = new CdpFacilitatorClient({
        ...baseConfig,
        facilitatorUrl: 'https://facilitator.example.com/',
      });
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        jsonResponse(200, { kinds: [], extensions: [] }),
      );
      await client.getSupported();
      const calledUrl = (fetch as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0][0];
      expect(calledUrl).toBe('https://facilitator.example.com/supported');
    });
  });

  describe('JWT construction', () => {
    it('signs a valid EdDSA JWT with correct claims and headers', async () => {
      const client = new CdpFacilitatorClient(baseConfig);
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        jsonResponse(200, { kinds: [], extensions: [] }),
      );

      await client.getSupported();

      const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0][1];
      const auth = (init.headers as Record<string, string>).Authorization;
      expect(auth).toMatch(/^Bearer /);
      const jwt = auth.replace(/^Bearer /, '');
      const { header, payload, signingInput, signature } = decodeJwt(jwt);

      expect(header).toMatchObject({
        alg: 'EdDSA',
        typ: 'JWT',
        kid: 'test-key-id',
      });
      expect(typeof header.nonce).toBe('string');

      expect(payload).toMatchObject({
        sub: 'test-key-id',
        iss: 'cdp',
        aud: ['cdp_service'],
        uri: 'GET facilitator.example.com/supported',
      });
      expect(typeof payload.nbf).toBe('number');
      expect(typeof payload.exp).toBe('number');
      expect((payload.exp as number) - (payload.nbf as number)).toBe(120);

      // Signature must verify against the corresponding public key.
      const ok = cryptoVerify(
        null,
        Buffer.from(signingInput),
        testPublicKey,
        signature,
      );
      expect(ok).toBe(true);
    });

    it('uses the full pathname in the uri claim', async () => {
      const client = new CdpFacilitatorClient({
        ...baseConfig,
        facilitatorUrl: 'https://api.cdp.coinbase.com/platform/v2/x402',
      });
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        jsonResponse(200, { kinds: [], extensions: [] }),
      );
      await client.getSupported();
      const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0][1];
      const jwt = (init.headers as Record<string, string>).Authorization.slice(
        'Bearer '.length,
      );
      const { payload } = decodeJwt(jwt);
      expect(payload.uri).toBe(
        'GET api.cdp.coinbase.com/platform/v2/x402/supported',
      );
    });

    it('produces a new nonce per request', async () => {
      const client = new CdpFacilitatorClient(baseConfig);
      const mockFetch = fetch as unknown as ReturnType<typeof vi.fn>;
      mockFetch
        .mockResolvedValueOnce(jsonResponse(200, { kinds: [], extensions: [] }))
        .mockResolvedValueOnce(
          jsonResponse(200, { kinds: [], extensions: [] }),
        );
      await client.getSupported();
      await client.getSupported();
      const nonces = mockFetch.mock.calls.map((c) => {
        const auth = (c[1].headers as Record<string, string>).Authorization;
        return decodeJwt(auth.slice('Bearer '.length)).header.nonce;
      });
      expect(nonces[0]).not.toBe(nonces[1]);
    });

    it('respects a custom jwtTtlSeconds', async () => {
      const client = new CdpFacilitatorClient({
        ...baseConfig,
        jwtTtlSeconds: 30,
      });
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        jsonResponse(200, { kinds: [], extensions: [] }),
      );
      await client.getSupported();
      const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0][1];
      const jwt = (init.headers as Record<string, string>).Authorization.slice(
        'Bearer '.length,
      );
      const { payload } = decodeJwt(jwt);
      expect((payload.exp as number) - (payload.nbf as number)).toBe(30);
    });
  });

  describe('HTTP behavior', () => {
    it('verify() POSTs to /verify with JSON body', async () => {
      const client = new CdpFacilitatorClient(baseConfig);
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        jsonResponse(200, { isValid: true }),
      );

      const result = await client.verify(
        mockPaymentPayload,
        mockPaymentRequirements,
      );

      const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(url).toBe('https://facilitator.example.com/verify');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body);
      // BigInt in payload is serialized as a string.
      expect(body.paymentPayload.amount).toBe('1000000000000000000');
      expect(body.paymentRequirements.minimumAmount).toBe(
        '1000000000000000000',
      );
      expect(result).toEqual({ isValid: true });
    });

    it('settle() POSTs to /settle', async () => {
      const client = new CdpFacilitatorClient(baseConfig);
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        jsonResponse(200, { success: true, transactionHash: '0xabc' }),
      );
      const result = await client.settle(
        mockPaymentPayload,
        mockPaymentRequirements,
      );
      const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(url).toBe('https://facilitator.example.com/settle');
      expect(init.method).toBe('POST');
      expect(result).toEqual({ success: true, transactionHash: '0xabc' });
    });

    it('getSupported() GETs /supported with no body', async () => {
      const client = new CdpFacilitatorClient(baseConfig);
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        jsonResponse(200, { kinds: ['erc20'], extensions: [] }),
      );
      await client.getSupported();
      const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock
        .calls[0];
      expect(url).toBe('https://facilitator.example.com/supported');
      expect(init.method).toBe('GET');
      expect(init.body).toBeUndefined();
    });

    it('re-throws "CDP facilitator error" on non-2xx JSON', async () => {
      const client = new CdpFacilitatorClient(baseConfig);
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        jsonResponse(401, { error: 'unauthorized' }),
      );
      await expect(client.getSupported()).rejects.toThrow(
        /CDP facilitator error \(401\)/,
      );
    });

    it('re-throws "CDP facilitator error" on non-2xx text', async () => {
      const client = new CdpFacilitatorClient(baseConfig);
      (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        new Response('nope', {
          status: 500,
          headers: { 'content-type': 'text/plain' },
        }),
      );
      await expect(client.getSupported()).rejects.toThrow(
        /CDP facilitator error \(500\): nope/,
      );
    });

    it('wraps network errors as "CDP facilitator request failed"', async () => {
      const client = new CdpFacilitatorClient(baseConfig);
      (fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('boom'),
      );
      await expect(client.getSupported()).rejects.toThrow(
        /CDP facilitator request failed: boom/,
      );
    });
  });
});
