import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'crypto';
import { CdpFacilitatorClient } from '../../src/payments/cdp-facilitator-client';
import type {
  PaymentPayload,
  PaymentRequirements,
  VerifyResponse,
  SettleResponse,
  SupportedResponse,
} from '@x402/core/types';

describe('CdpFacilitatorClient', () => {
  const mockConfig = {
    facilitatorUrl: 'https://facilitator.example.com',
    cdpKeyId: 'test-key-id',
    cdpPrivateKey: 'test-private-key-secret',
  };

  const mockPaymentPayload: PaymentPayload = {
    kind: 'erc20',
    paymentReference: 'ref123',
    amount: BigInt('1000000000000000000'),
    chainId: 8453,
    tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    from: '0x1234567890123456789012345678901234567890',
    to: '0x0987654321098765432109876543210987654321',
  };

  const mockPaymentRequirements: PaymentRequirements = {
    kind: 'erc20',
    chainId: 8453,
    tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    minimumAmount: BigInt('1000000000000000000'),
  };

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('Constructor Validation', () => {
    it('should throw error if facilitatorUrl is missing', () => {
      expect(() => {
        new CdpFacilitatorClient({
          facilitatorUrl: '',
          cdpKeyId: 'key-id',
          cdpPrivateKey: 'private-key',
        });
      }).toThrow('CdpFacilitatorClient: facilitatorUrl is required');
    });

    it('should throw error if cdpKeyId is missing', () => {
      expect(() => {
        new CdpFacilitatorClient({
          facilitatorUrl: 'https://example.com',
          cdpKeyId: '',
          cdpPrivateKey: 'private-key',
        });
      }).toThrow('CdpFacilitatorClient: cdpKeyId is required');
    });

    it('should throw error if cdpPrivateKey is missing', () => {
      expect(() => {
        new CdpFacilitatorClient({
          facilitatorUrl: 'https://example.com',
          cdpKeyId: 'key-id',
          cdpPrivateKey: '',
        });
      }).toThrow('CdpFacilitatorClient: cdpPrivateKey is required');
    });

    it('should successfully construct with valid configuration', () => {
      expect(() => {
        new CdpFacilitatorClient(mockConfig);
      }).not.toThrow();
    });
  });

  describe('Signature Generation', () => {
    it('should generate HMAC-SHA256 signature', () => {
      const _client = new CdpFacilitatorClient(mockConfig);
      const timestamp = 1234567890000;
      const method = 'POST';
      const path = '/verify';
      const body = '{"test":"data"}';

      const expectedMessage = `${timestamp}${method}${path}${body}`;
      const expectedSignature = createHmac('sha256', mockConfig.cdpPrivateKey)
        .update(expectedMessage)
        .digest('base64');

      expect(expectedSignature).toMatch(/^[A-Za-z0-9+/=]+$/);
      expect(expectedSignature.length).toBeGreaterThan(0);
    });

    it('should produce base64-encoded signature', () => {
      const privateKey = 'test-key';
      const message = '1234567890POSTpath{"data":"value"}';
      const signature = createHmac('sha256', privateKey)
        .update(message)
        .digest('base64');

      expect(signature).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
    });

    it('should include timestamp, method, path, and body in signature calculation', () => {
      const timestamp = 1000;
      const method = 'GET';
      const path = '/supported';
      const body = '';

      const message1 = `${timestamp}${method}${path}${body}`;
      const message2 = `${timestamp + 1}${method}${path}${body}`;

      const sig1 = createHmac('sha256', mockConfig.cdpPrivateKey)
        .update(message1)
        .digest('base64');
      const sig2 = createHmac('sha256', mockConfig.cdpPrivateKey)
        .update(message2)
        .digest('base64');

      expect(sig1).not.toBe(sig2);
    });

    it('should generate different signatures for different methods', () => {
      const timestamp = 1000;
      const path = '/verify';
      const body = '{}';

      const message1 = `${timestamp}POST${path}${body}`;
      const message2 = `${timestamp}GET${path}${body}`;

      const sig1 = createHmac('sha256', mockConfig.cdpPrivateKey)
        .update(message1)
        .digest('base64');
      const sig2 = createHmac('sha256', mockConfig.cdpPrivateKey)
        .update(message2)
        .digest('base64');

      expect(sig1).not.toBe(sig2);
    });
  });

  describe('Authenticated Requests', () => {
    it('should include correct headers in request', async () => {
      const client = new CdpFacilitatorClient(mockConfig);
      const mockResponse = { valid: true } as VerifyResponse;

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      vi.setSystemTime(1000);
      await client.verify(mockPaymentPayload, mockPaymentRequirements);

      expect(mockFetch).toHaveBeenCalledOnce();
      const [_url, options] = mockFetch.mock.calls[0];

      expect(options?.headers).toHaveProperty('X-CDP-API-Key', mockConfig.cdpKeyId);
      expect(options?.headers).toHaveProperty('X-CDP-Timestamp', '1000');
      expect(options?.headers).toHaveProperty('X-CDP-Signature');
      expect(options?.headers).toHaveProperty('Content-Type', 'application/json');
    });

    it('should construct correct URL', async () => {
      const client = new CdpFacilitatorClient(mockConfig);
      const mockResponse = { valid: true } as VerifyResponse;

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      await client.verify(mockPaymentPayload, mockPaymentRequirements);

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://facilitator.example.com/verify');
    });

    it('should send correct Content-Type header', async () => {
      const client = new CdpFacilitatorClient(mockConfig);
      const mockResponse = { valid: true } as VerifyResponse;

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      await client.verify(mockPaymentPayload, mockPaymentRequirements);

      const [, options] = mockFetch.mock.calls[0];
      expect(options?.headers).toHaveProperty('Content-Type', 'application/json');
    });

    it('should generate valid X-CDP-Timestamp header', async () => {
      const client = new CdpFacilitatorClient(mockConfig);
      const mockResponse = { valid: true } as VerifyResponse;

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      vi.setSystemTime(1609459200000);
      await client.verify(mockPaymentPayload, mockPaymentRequirements);

      const [, options] = mockFetch.mock.calls[0];
      const timestamp = options?.headers?.['X-CDP-Timestamp'];
      expect(timestamp).toBe('1609459200000');
      expect(Number(timestamp)).toEqual(expect.any(Number));
    });
  });

  describe('verify() Method', () => {
    it('should send POST request to /verify endpoint', async () => {
      const client = new CdpFacilitatorClient(mockConfig);
      const mockResponse = { valid: true } as VerifyResponse;

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      const result = await client.verify(mockPaymentPayload, mockPaymentRequirements);

      expect(result).toEqual(mockResponse);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('https://facilitator.example.com/verify');
      expect(options?.method).toBe('POST');
    });

    it('should include paymentPayload and paymentRequirements in request body', async () => {
      const client = new CdpFacilitatorClient(mockConfig);
      const mockResponse = { valid: true } as VerifyResponse;

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      await client.verify(mockPaymentPayload, mockPaymentRequirements);

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options?.body as string);

      expect(body).toHaveProperty('paymentPayload');
      expect(body).toHaveProperty('paymentRequirements');
      // BigInt values are converted to strings in JSON serialization, so compare the stringified amount
      expect(body.paymentPayload.amount).toBe('1000000000000000000');
      expect(body.paymentPayload.kind).toBe('erc20');
      expect(body.paymentRequirements.minimumAmount).toBe('1000000000000000000');
      expect(body.paymentRequirements.kind).toBe('erc20');
    });

    it('should parse successful response', async () => {
      const client = new CdpFacilitatorClient(mockConfig);
      const mockResponse: VerifyResponse = { valid: true };

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      const result = await client.verify(mockPaymentPayload, mockPaymentRequirements);
      expect(result).toEqual(mockResponse);
    });
  });

  describe('settle() Method', () => {
    it('should send POST request to /settle endpoint', async () => {
      const client = new CdpFacilitatorClient(mockConfig);
      const mockResponse: SettleResponse = {
        txHash: '0x123456789abcdef',
        blockNumber: 12345,
      };

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      const result = await client.settle(mockPaymentPayload, mockPaymentRequirements);

      expect(result).toEqual(mockResponse);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('https://facilitator.example.com/settle');
      expect(options?.method).toBe('POST');
    });

    it('should include paymentPayload and paymentRequirements in request body', async () => {
      const client = new CdpFacilitatorClient(mockConfig);
      const mockResponse: SettleResponse = {
        txHash: '0xabc',
        blockNumber: 100,
      };

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      await client.settle(mockPaymentPayload, mockPaymentRequirements);

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options?.body as string);

      expect(body).toHaveProperty('paymentPayload');
      expect(body).toHaveProperty('paymentRequirements');
    });

    it('should parse successful response', async () => {
      const client = new CdpFacilitatorClient(mockConfig);
      const mockResponse: SettleResponse = {
        txHash: '0x789abc',
        blockNumber: 54321,
      };

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      const result = await client.settle(mockPaymentPayload, mockPaymentRequirements);
      expect(result).toEqual(mockResponse);
    });
  });

  describe('getSupported() Method', () => {
    it('should send GET request to /supported endpoint', async () => {
      const client = new CdpFacilitatorClient(mockConfig);
      const mockResponse: SupportedResponse = {
        kinds: ['erc20', 'native'],
      };

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      const result = await client.getSupported();

      expect(result).toEqual(mockResponse);
      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe('https://facilitator.example.com/supported');
      expect(options?.method).toBe('GET');
    });

    it('should not include body in GET request', async () => {
      const client = new CdpFacilitatorClient(mockConfig);
      const mockResponse: SupportedResponse = {
        kinds: ['erc20'],
      };

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      await client.getSupported();

      const [, options] = mockFetch.mock.calls[0];
      expect(options?.body).toBeUndefined();
    });

    it('should parse successful response', async () => {
      const client = new CdpFacilitatorClient(mockConfig);
      const mockResponse: SupportedResponse = {
        kinds: ['erc20', 'native', 'usdc'],
      };

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      const result = await client.getSupported();
      expect(result).toEqual(mockResponse);
    });
  });

  describe('Error Handling', () => {
    it('should throw error for non-2xx response with JSON body', async () => {
      const client = new CdpFacilitatorClient(mockConfig);
      const errorBody = { error: 'Invalid payment' };

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(errorBody), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
      );

      await expect(client.verify(mockPaymentPayload, mockPaymentRequirements)).rejects.toThrow(
        /CDP facilitator error \(400\)/,
      );
    });

    it('should throw error for non-2xx response with text body', async () => {
      const client = new CdpFacilitatorClient(mockConfig);
      const errorMessage = 'Bad Request';

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(errorMessage, {
          status: 400,
          headers: { 'content-type': 'text/plain' },
        }),
      );

      await expect(client.verify(mockPaymentPayload, mockPaymentRequirements)).rejects.toThrow(
        /CDP facilitator error \(400\)/,
      );
    });

    it('should throw error for 500 server error', async () => {
      const client = new CdpFacilitatorClient(mockConfig);

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response('Internal Server Error', {
          status: 500,
          headers: { 'content-type': 'text/plain' },
        }),
      );

      await expect(client.getSupported()).rejects.toThrow('CDP facilitator error (500)');
    });

    it('should include original fetch error in error message', async () => {
      const client = new CdpFacilitatorClient(mockConfig);

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockRejectedValueOnce(new Error('Network timeout'));

      await expect(client.verify(mockPaymentPayload, mockPaymentRequirements)).rejects.toThrow(
        /CDP facilitator request failed/,
      );
    });

    it('should wrap network errors with context', async () => {
      const client = new CdpFacilitatorClient(mockConfig);

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const error = await client.getSupported().catch((e) => e);
      expect(error.message).toContain('CDP facilitator request failed');
      expect(error.message).toContain('ECONNREFUSED');
    });

    it('should not expose private key in error messages', async () => {
      const client = new CdpFacilitatorClient(mockConfig);

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockRejectedValueOnce(new Error('Authentication failed'));

      const error = await client.verify(mockPaymentPayload, mockPaymentRequirements).catch(
        (e) => e,
      );

      expect(error.message).not.toContain(mockConfig.cdpPrivateKey);
    });

    it('should handle error response without content-type header', async () => {
      const client = new CdpFacilitatorClient(mockConfig);

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response('Error occurred', {
          status: 500,
        }),
      );

      await expect(client.getSupported()).rejects.toThrow('CDP facilitator error (500)');
    });
  });

  describe('BigInt Handling', () => {
    it('should convert BigInt to string in payload', async () => {
      const client = new CdpFacilitatorClient(mockConfig);
      const mockResponse = { valid: true } as VerifyResponse;

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      await client.verify(mockPaymentPayload, mockPaymentRequirements);

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options?.body as string);

      expect(body.paymentPayload.amount).toBe('1000000000000000000');
      expect(typeof body.paymentPayload.amount).toBe('string');

      expect(body.paymentRequirements.minimumAmount).toBe('1000000000000000000');
      expect(typeof body.paymentRequirements.minimumAmount).toBe('string');
    });

    it('should handle nested BigInt values', async () => {
      const client = new CdpFacilitatorClient(mockConfig);
      const mockResponse = { valid: true } as VerifyResponse;

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      const payloadWithNestedBigInt = {
        kind: 'erc20',
        paymentReference: 'ref123',
        amount: BigInt('999999999'),
        chainId: 8453,
        tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        from: '0x1234567890123456789012345678901234567890',
        to: '0x0987654321098765432109876543210987654321',
      };

      await client.verify(payloadWithNestedBigInt, mockPaymentRequirements);

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options?.body as string);

      expect(body.paymentPayload.amount).toBe('999999999');
      expect(typeof body.paymentPayload.amount).toBe('string');
    });

    it('should handle arrays with BigInt values', async () => {
      const client = new CdpFacilitatorClient(mockConfig);
      const mockResponse = { valid: true } as VerifyResponse;

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      const payloadWithBigIntArray = {
        kind: 'erc20',
        paymentReference: 'ref123',
        amount: BigInt('1000000000000000000'),
        chainId: 8453,
        tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        from: '0x1234567890123456789012345678901234567890',
        to: '0x0987654321098765432109876543210987654321',
      };

      const requirementsWithBigIntArray = {
        kind: 'erc20',
        chainId: 8453,
        tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        minimumAmount: BigInt('500000000000000000'),
      };

      await client.verify(payloadWithBigIntArray, requirementsWithBigIntArray);

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options?.body as string);

      expect(typeof body.paymentPayload.amount).toBe('string');
      expect(typeof body.paymentRequirements.minimumAmount).toBe('string');
    });

    it('should maintain JSON serializability with BigInt conversion', async () => {
      const client = new CdpFacilitatorClient(mockConfig);
      const mockResponse = { valid: true } as VerifyResponse;

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      await client.verify(mockPaymentPayload, mockPaymentRequirements);

      const [, options] = mockFetch.mock.calls[0];
      const body = options?.body as string;

      expect(() => JSON.parse(body)).not.toThrow();

      const parsed = JSON.parse(body);
      expect(JSON.stringify(parsed)).toBeDefined();
    });
  });

  describe('Multiple Requests', () => {
    it('should handle multiple sequential requests', async () => {
      const client = new CdpFacilitatorClient(mockConfig);

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ valid: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ kinds: ['erc20'] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      const result1 = await client.verify(mockPaymentPayload, mockPaymentRequirements);
      const result2 = await client.getSupported();

      expect(result1).toEqual({ valid: true });
      expect(result2).toEqual({ kinds: ['erc20'] });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should use different timestamps for different requests', async () => {
      const client = new CdpFacilitatorClient(mockConfig);

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ valid: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ kinds: ['erc20'] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      vi.setSystemTime(1000);
      await client.verify(mockPaymentPayload, mockPaymentRequirements);

      vi.setSystemTime(2000);
      await client.getSupported();

      const [, options1] = mockFetch.mock.calls[0];
      const [, options2] = mockFetch.mock.calls[1];

      expect(options1?.headers?.['X-CDP-Timestamp']).toBe('1000');
      expect(options2?.headers?.['X-CDP-Timestamp']).toBe('2000');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty object payload', async () => {
      const client = new CdpFacilitatorClient(mockConfig);
      const mockResponse = { valid: true } as VerifyResponse;

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      const minimalPayload = {
        kind: 'erc20',
        paymentReference: 'ref',
        amount: BigInt('0'),
        chainId: 8453,
        tokenAddress: '0x0000000000000000000000000000000000000000',
        from: '0x0000000000000000000000000000000000000000',
        to: '0x0000000000000000000000000000000000000000',
      };

      const minimalRequirements = {
        kind: 'erc20',
        chainId: 8453,
        tokenAddress: '0x0000000000000000000000000000000000000000',
        minimumAmount: BigInt('0'),
      };

      await client.verify(minimalPayload, minimalRequirements);

      const [, options] = mockFetch.mock.calls[0];
      expect(options?.body).toBeDefined();
      expect(() => JSON.parse(options?.body as string)).not.toThrow();
    });

    it('should handle very large BigInt values', async () => {
      const client = new CdpFacilitatorClient(mockConfig);
      const mockResponse = { valid: true } as VerifyResponse;

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify(mockResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      const largePayload = {
        kind: 'erc20',
        paymentReference: 'ref',
        amount: BigInt('999999999999999999999999999999999999999'),
        chainId: 8453,
        tokenAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        from: '0x1234567890123456789012345678901234567890',
        to: '0x0987654321098765432109876543210987654321',
      };

      await client.verify(largePayload, mockPaymentRequirements);

      const [, options] = mockFetch.mock.calls[0];
      const body = JSON.parse(options?.body as string);

      expect(body.paymentPayload.amount).toBe('999999999999999999999999999999999999999');
    });

    it('should handle facilitatorUrl with trailing slash', async () => {
      const clientWithTrailingSlash = new CdpFacilitatorClient({
        ...mockConfig,
        facilitatorUrl: 'https://facilitator.example.com/',
      });

      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ kinds: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

      await clientWithTrailingSlash.getSupported();

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('facilitator.example.com');
    });

    it('should handle different HTTP status codes', async () => {
      const client = new CdpFacilitatorClient(mockConfig);

      const testCases = [
        { status: 200, shouldFail: false },
        { status: 201, shouldFail: false },
        { status: 299, shouldFail: false },
        { status: 300, shouldFail: true },
        { status: 400, shouldFail: true },
        { status: 403, shouldFail: true },
        { status: 404, shouldFail: true },
        { status: 500, shouldFail: true },
      ];

      for (const testCase of testCases) {
        const mockFetch = vi.mocked(fetch);
        if (testCase.shouldFail) {
          mockFetch.mockResolvedValueOnce(
            new Response('Error', {
              status: testCase.status,
              headers: { 'content-type': 'text/plain' },
            }),
          );
          await expect(client.getSupported()).rejects.toThrow();
        } else {
          // 204 No Content should not have a body
          const body = testCase.status === 204 ? '' : JSON.stringify({ kinds: [] });
          mockFetch.mockResolvedValueOnce(
            new Response(body, {
              status: testCase.status,
              headers: { 'content-type': 'application/json' },
            }),
          );
          await expect(client.getSupported()).resolves.toBeDefined();
        }
      }
    });
  });
});
