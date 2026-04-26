import { describe, it, expect } from 'vitest';
import {
  CDP_FACILITATOR_URL,
  warnIfBazaarIndexingDisabled,
  type PaymentConfig,
} from '../src/payments.js';

function baseConfig(overrides: Partial<PaymentConfig> = {}): PaymentConfig {
  return {
    receivingAddress: '0x2222222222222222222222222222222222222222',
    facilitatorUrl: CDP_FACILITATOR_URL,
    prices: { market: '0.005', honeypot: '0.01', forensics: '0.02', report: '0.03' },
    ...overrides,
  };
}

describe('warnIfBazaarIndexingDisabled', () => {
  it('warns when FACILITATOR_URL is not the CDP facilitator', () => {
    const messages: string[] = [];
    warnIfBazaarIndexingDisabled(
      baseConfig({ facilitatorUrl: 'https://example.com/x402' }),
      (m) => messages.push(m),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/not the CDP facilitator/i);
    expect(messages[0]).toContain(CDP_FACILITATOR_URL);
  });

  it('warns when CDP URL is set but credentials are missing', () => {
    const messages: string[] = [];
    warnIfBazaarIndexingDisabled(baseConfig(), (m) => messages.push(m));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/CDP_API_KEY_ID/);
    expect(messages[0]).toMatch(/PRIVATE_KEY/);
  });

  it('warns when CDP URL is set with only key id (no private key)', () => {
    const messages: string[] = [];
    warnIfBazaarIndexingDisabled(
      baseConfig({ cdpKeyId: 'k' }),
      (m) => messages.push(m),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/PRIVATE_KEY/);
  });

  it('is silent when CDP URL + both credentials are present', () => {
    const messages: string[] = [];
    warnIfBazaarIndexingDisabled(
      baseConfig({ cdpKeyId: 'k', cdpPrivateKey: 'priv' }),
      (m) => messages.push(m),
    );
    expect(messages).toEqual([]);
  });

  it('tolerates a trailing slash on the CDP URL', () => {
    const messages: string[] = [];
    warnIfBazaarIndexingDisabled(
      baseConfig({
        facilitatorUrl: `${CDP_FACILITATOR_URL}/`,
        cdpKeyId: 'k',
        cdpPrivateKey: 'priv',
      }),
      (m) => messages.push(m),
    );
    expect(messages).toEqual([]);
  });
});
