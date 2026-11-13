'use strict';
const { createApp } = require('../src/app');

// Deterministic pseudo-random descriptors so tests are repeatable.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A unit-length 128-d "face template", like FaceNet-style embeddings. */
function randomDescriptor(seed) {
  const r = rng(seed);
  const v = Array.from({ length: 128 }, () => r() * 2 - 1);
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

/** Same person, new photo: add small noise and renormalize. distance ~ noise level. */
function sameFace(d, noise, seed) {
  const r = rng(seed);
  const v = d.map((x) => x + (r() * 2 - 1) * noise);
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

async function start(config = {}) {
  const app = createApp({ adminKey: 'test-admin', ...config });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const headers = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  };
  return { app, base, call, close: () => new Promise((r) => app.server.close(r)) };
}

module.exports = { randomDescriptor, sameFace, start };
