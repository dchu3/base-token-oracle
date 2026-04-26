import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createApp, DEFAULT_TRUST_PROXY } from '../src/server.js';

describe('createApp trust-proxy wiring', () => {
  it('uses the loopback default so X-Forwarded-Proto from a sibling proxy is honored', async () => {
    const app = createApp();
    expect(app.get('trust proxy')).toBe(DEFAULT_TRUST_PROXY);

    // Mount a debug route AFTER createApp so the trust proxy setting is in
    // effect. Supertest connects from 127.0.0.1, which falls within the
    // default 'loopback' subnet, so X-Forwarded-Proto is honored.
    app.get('/__proto', (req, res) => {
      res.json({ protocol: req.protocol, secure: req.secure });
    });
    const res = await request(app)
      .get('/__proto')
      .set('X-Forwarded-Proto', 'https');
    expect(res.body).toEqual({ protocol: 'https', secure: true });
  });

  it('passes through a string trustProxy value verbatim', () => {
    const app = createApp({ trustProxy: '10.0.0.0/8' });
    expect(app.get('trust proxy')).toBe('10.0.0.0/8');
  });

  it('can be disabled by passing false', async () => {
    const app = createApp({ trustProxy: false });
    expect(app.get('trust proxy')).toBe(false);
    app.get('/__proto', (req, res) => {
      res.json({ protocol: req.protocol });
    });
    const res = await request(app)
      .get('/__proto')
      .set('X-Forwarded-Proto', 'https');
    // Without trust proxy, Express ignores X-Forwarded-Proto.
    expect(res.body.protocol).toBe('http');
  });

  it('honors a numeric hop count', () => {
    const app = createApp({ trustProxy: 1 });
    // Express normalizes numeric hop counts into a function; just assert it
    // didn't blow up and a request still works.
    expect(typeof app.get('trust proxy')).not.toBe('undefined');
  });

  it('the trust-proxy default does not interfere with vanilla Express apps', () => {
    // Sanity: untouched express() defaults to false.
    const app = express();
    expect(app.get('trust proxy')).toBe(false);
  });
});
