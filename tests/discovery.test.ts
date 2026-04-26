import { describe, expect, it } from 'vitest';
import { BAZAAR, validateDiscoveryExtension } from '@x402/extensions';
import { buildDiscoveryExtensions } from '../src/discovery.js';
import { BASE_PATH } from '../src/payments.js';

const expectedKeys = [
  `GET ${BASE_PATH}/token/:address/report`,
] as const;

const BAZAAR_KEY = (BAZAAR as { key: string }).key;

interface BazaarExt {
  info?: {
    input?: Record<string, unknown> & { method?: string };
    output?: { example?: unknown; schema?: Record<string, unknown> };
  };
  schema?: Record<string, unknown>;
}

describe('buildDiscoveryExtensions', () => {
  const extensions = buildDiscoveryExtensions();

  it('returns one entry per paid GET route', () => {
    expect(Object.keys(extensions).sort()).toEqual([...expectedKeys].sort());
  });

  for (const key of expectedKeys) {
    const entry = extensions[key];
    const ext = entry?.[BAZAAR_KEY] as BazaarExt | undefined;

    it(`route ${key} declares the bazaar discovery extension envelope`, () => {
      expect(ext).toBeDefined();
      expect(ext?.info).toBeDefined();
      expect(ext?.schema).toBeDefined();
      expect(ext?.schema?.type).toBe('object');
    });

    it(`route ${key} pre-injects method='GET' so the raw declaration is valid on every 402 path`, () => {
      expect(ext?.info?.input?.method).toBe('GET');
      const inputSchema = (ext?.schema?.properties as Record<string, unknown> | undefined)?.input as
        | { properties?: Record<string, unknown>; required?: string[] }
        | undefined;
      expect(inputSchema?.required).toContain('method');
      expect(inputSchema?.properties?.method).toBeDefined();
    });

    it(`route ${key} passes the SDK's validateDiscoveryExtension`, () => {
      const result = validateDiscoveryExtension(ext as never);
      expect(result.valid, JSON.stringify(result.errors)).toBe(true);
    });

    it(`route ${key} declares an output example with an inline JSON schema`, () => {
      expect(ext?.info?.output?.example).toBeDefined();
      const serialized = JSON.stringify(ext?.schema);
      expect(serialized).not.toContain('"$ref"');
      expect(serialized).not.toContain('"$defs"');
      expect(serialized).not.toContain('"definitions"');
      expect(serialized).not.toContain('draft-07');
      const props = ext?.schema?.properties as
        | { output?: { properties?: { example?: Record<string, unknown> } } }
        | undefined;
      const example = props?.output?.properties?.example;
      expect(example).toBeDefined();
      expect(example?.type).toBe('object');
    });
  }
});
