import { describe, expect, it } from 'vitest';
import { BAZAAR } from '@x402/extensions';
import { buildDiscoveryExtensions } from '../src/discovery.js';
import { BASE_PATH } from '../src/payments.js';

const expectedKeys = [
  `GET ${BASE_PATH}/token/:address/market`,
  `GET ${BASE_PATH}/token/:address/honeypot`,
  `GET ${BASE_PATH}/token/:address/forensics`,
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

    it(`route ${key} declares an output example with an inline JSON schema`, () => {
      expect(ext?.info?.output?.example).toBeDefined();
      // Our output.schema is merged into the bazaar JSON Schema envelope at
      // `schema.properties.output.properties.example`. Assert it's inline
      // (no $ref / $defs) so the CDP facilitator's strict Ajv validator can
      // resolve it without external context.
      const serialized = JSON.stringify(ext?.schema);
      expect(serialized).not.toContain('"$ref"');
      expect(serialized).not.toContain('"$defs"');
      expect(serialized).not.toContain('"definitions"');
      // Sanity: our schema shows up under the merged output example slot.
      const props = ext?.schema?.properties as
        | { output?: { properties?: { example?: Record<string, unknown> } } }
        | undefined;
      const example = props?.output?.properties?.example;
      expect(example).toBeDefined();
      expect(example?.type).toBe('object');
    });
  }
});

