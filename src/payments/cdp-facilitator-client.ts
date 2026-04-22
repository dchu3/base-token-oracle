import { createHmac } from 'crypto';
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
  cdpPrivateKey: string;
}

/**
 * CDP-authenticated x402 facilitator client for Coinbase's CDP platform.
 * Implements HMAC-SHA256 signing for authenticated API requests to a
 * Coinbase-hosted x402 facilitator endpoint.
 *
 * Authentication scheme:
 * - Requests include an `X-CDP-API-Key` header with the API key ID
 * - Requests are signed with `X-CDP-Signature` using HMAC-SHA256
 * - Signature includes: timestamp, method, path, and body
 * - Timestamp is included in `X-CDP-Timestamp` header
 */
export class CdpFacilitatorClient implements FacilitatorClient {
  private readonly facilitatorUrl: string;
  private readonly cdpKeyId: string;
  private readonly cdpPrivateKey: string;

  constructor(config: CdpFacilitatorClientConfig) {
    if (!config.facilitatorUrl) {
      throw new Error(
        'CdpFacilitatorClient: facilitatorUrl is required',
      );
    }
    if (!config.cdpKeyId) {
      throw new Error('CdpFacilitatorClient: cdpKeyId is required');
    }
    if (!config.cdpPrivateKey) {
      throw new Error(
        'CdpFacilitatorClient: cdpPrivateKey is required',
      );
    }

    this.facilitatorUrl = config.facilitatorUrl.replace(/\/$/, '');
    this.cdpKeyId = config.cdpKeyId;
    this.cdpPrivateKey = config.cdpPrivateKey;
  }

  /**
   * Create HMAC-SHA256 signature for CDP API requests.
   *
   * Signature message format:
   *   `${timestamp}${method}${path}${body}`
   *
   * @param timestamp - Unix timestamp in milliseconds
   * @param method - HTTP method (GET, POST, etc.)
   * @param path - Request path (e.g., "/verify", "/settle", "/supported")
   * @param body - Request body as JSON string (empty string for GET)
   * @returns Base64-encoded HMAC-SHA256 signature
   */
  private createSignature(
    timestamp: number,
    method: string,
    path: string,
    body: string,
  ): string {
    const message = `${timestamp}${method}${path}${body}`;
    const signature = createHmac('sha256', this.cdpPrivateKey)
      .update(message)
      .digest('base64');
    return signature;
  }

  /**
   * Perform an authenticated request to a CDP facilitator endpoint.
   *
   * @param path - The endpoint path (e.g., "verify", "settle", "supported")
   * @param method - HTTP method (GET or POST)
   * @param payload - Request body (can be undefined for GET requests)
   * @returns Parsed JSON response
   * @throws Error if the request fails or returns a non-2xx status
   */
  private async authenticatedRequest<T>(
    path: string,
    method: string,
    payload?: unknown,
  ): Promise<T> {
    const timestamp = Date.now();
    const url = new URL(`${this.facilitatorUrl}/${path}`);
    const requestPath = url.pathname;
    const body = payload ? JSON.stringify(this.toJsonSafe(payload)) : '';
    const signature = this.createSignature(timestamp, method, requestPath, body);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-CDP-API-Key': this.cdpKeyId,
      'X-CDP-Timestamp': timestamp.toString(),
      'X-CDP-Signature': signature,
    };

    try {
      const response = await fetch(url.toString(), {
        method,
        headers,
        body: body || undefined,
      });

      if (!response.ok) {
        const contentType = response.headers.get('content-type');
        const errorBody =
          contentType?.includes('application/json')
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
      throw new Error(
        `CDP facilitator request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Verify a payment with the CDP facilitator.
   *
   * Sends a POST request to the `/verify` endpoint with the payment
   * payload and requirements.
   *
   * @param paymentPayload - The payment to verify
   * @param paymentRequirements - The requirements to verify against
   * @returns Verification response indicating if the payment is valid
   */
  async verify(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const request = {
      paymentPayload,
      paymentRequirements,
    };
    return this.authenticatedRequest<VerifyResponse>(
      'verify',
      'POST',
      request,
    );
  }

  /**
   * Settle a payment with the CDP facilitator.
   *
   * Sends a POST request to the `/settle` endpoint with the payment
   * payload and requirements.
   *
   * @param paymentPayload - The payment to settle
   * @param paymentRequirements - The requirements for settlement
   * @returns Settlement response with transaction details
   */
  async settle(
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const request = {
      paymentPayload,
      paymentRequirements,
    };
    return this.authenticatedRequest<SettleResponse>(
      'settle',
      'POST',
      request,
    );
  }

  /**
   * Get supported payment kinds and extensions from the CDP facilitator.
   *
   * Sends a GET request to the `/supported` endpoint to discover what
   * payment schemes and networks are available.
   *
   * @returns Supported payment kinds and extensions
   */
  async getSupported(): Promise<SupportedResponse> {
    return this.authenticatedRequest<SupportedResponse>(
      'supported',
      'GET',
    );
  }

  /**
   * Convert objects to JSON-safe format.
   * Handles BigInt and other non-JSON-serializable types.
   *
   * @param obj - The object to convert
   * @returns The JSON-safe representation of the object
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
