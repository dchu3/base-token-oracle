import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import {
  CdpFacilitatorClient,
  parseExtensionResponses,
} from '../../src/payments/cdp-facilitator-client';
import type {
  PaymentPayload,
  PaymentRequirements,
} from '@x402/core/types';

const { privateKey } = generateKeyPairSync('ed25519');
const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

const baseConfig = {
  facilitatorUrl: 'https://facilitator.example.com',
  cdpKeyId: 'test-key-id',
  cdpPrivateKey: pem,
};

const mockPayload = {
  x402Version: 2,
  kind: 'erc20',
} as unknown as PaymentPayload;

const mockRequirements = {
  kind: 'erc20',
} as unknown as PaymentRequirements;

function jsonResponseWithHeaders(
  status: number,
  body: unknown,
  headers: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('parseExtensionResponses', () => {
  it('parses a JSON object of name→status', () => {
    expect(parseExtensionResponses('{"bazaar":"processing"}')).toBe(
      'bazaar=processing',
    );
  });

  it('parses a JSON object with nested {status} records', () => {
    expect(
      parseExtensionResponses(
        '{"bazaar":{"status":"rejected","detail":"input invalid"}}',
      ),
    ).toBe('bazaar=rejected');
  });

  it('parses a JSON array of {name,status} records', () => {
    expect(
      parseExtensionResponses(
        '[{"name":"bazaar","status":"processing"},{"name":"foo","status":"rejected"}]',
      ),
    ).toBe('bazaar=processing, foo=rejected');
  });

  it('parses a comma-separated key=value form', () => {
    expect(parseExtensionResponses('bazaar=processing, foo=rejected')).toBe(
      'bazaar=processing, foo=rejected',
    );
  });

  it('returns (empty) for an empty header value', () => {
    expect(parseExtensionResponses('   ')).toBe('(empty)');
  });
});

describe('CdpFacilitatorClient extension-responses logging', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('logs the EXTENSION-RESPONSES header on settle when present', async () => {
    const messages: string[] = [];
    const client = new CdpFacilitatorClient({
      ...baseConfig,
      logger: (m) => messages.push(m),
    });
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponseWithHeaders(
        200,
        { success: true, transaction: '0xabc', network: 'eip155:8453' },
        { 'extension-responses': '{"bazaar":"processing"}' },
      ),
    );

    await client.settle(mockPayload, mockRequirements);

    expect(messages).toContain(
      '[bazaar] settle extension-responses: bazaar=processing',
    );
  });

  it('logs the EXTENSION-RESPONSES header on verify when present (rejected)', async () => {
    const messages: string[] = [];
    const client = new CdpFacilitatorClient({
      ...baseConfig,
      logger: (m) => messages.push(m),
    });
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponseWithHeaders(
        200,
        { isValid: true },
        { 'extension-responses': 'bazaar=rejected' },
      ),
    );

    await client.verify(mockPayload, mockRequirements);

    expect(messages).toContain(
      '[bazaar] verify extension-responses: bazaar=rejected',
    );
  });

  it('warns when EXTENSION-RESPONSES is absent from a CDP response', async () => {
    const messages: string[] = [];
    const client = new CdpFacilitatorClient({
      ...baseConfig,
      logger: (m) => messages.push(m),
    });
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponseWithHeaders(200, { isValid: true }, {}),
    );

    await client.verify(mockPayload, mockRequirements);

    expect(
      messages.some((m) =>
        m.includes('verify response has no extension-responses header'),
      ),
    ).toBe(true);
  });

  it('does not log extension-responses for getSupported (only verify/settle)', async () => {
    const messages: string[] = [];
    const client = new CdpFacilitatorClient({
      ...baseConfig,
      logger: (m) => messages.push(m),
    });
    (fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      jsonResponseWithHeaders(
        200,
        { kinds: [], extensions: [] },
        { 'extension-responses': '{"bazaar":"processing"}' },
      ),
    );

    await client.getSupported();

    expect(messages).toEqual([]);
  });
});
