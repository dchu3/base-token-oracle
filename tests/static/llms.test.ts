import path from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { createApp } from '../../src/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '..', '..', 'public');

describe('static /public assets', () => {
  it('serves /llms.txt with 200 and the expected header', async () => {
    const app = createApp({ publicDir });
    const res = await request(app).get('/llms.txt');
    expect(res.status).toBe(200);
    expect(res.text.startsWith('# base-token-oracle')).toBe(true);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
  });
});
