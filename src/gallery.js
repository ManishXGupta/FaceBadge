'use strict';
// Event-scoped, in-memory face gallery.
// Only people who enrolled themselves (with consent) are ever in here.
// Nothing is written to disk: restarting the server or closing the event wipes everything.

const crypto = require('node:crypto');

const DESCRIPTOR_LENGTH = 128;

function isValidDescriptor(d) {
  return Array.isArray(d) && d.length === DESCRIPTOR_LENGTH && d.every((x) => typeof x === 'number' && Number.isFinite(x));
}

function euclidean(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const t = a[i] - b[i];
    s += t * t;
  }
  return Math.sqrt(s);
}

class Gallery {
  /**
   * @param {object} opts
   * @param {number} opts.threshold  max distance accepted as the same person (lower = stricter)
   * @param {number} opts.margin     best match must beat the second best by this much, else "ambiguous"
   */
  constructor({ threshold = 0.5, margin = 0.05 } = {}) {
    this.threshold = threshold;
    this.margin = margin;
    this.people = new Map(); // id -> record
  }

  enroll({ descriptor, profile, policy }) {
    if (!isValidDescriptor(descriptor)) throw new Error('invalid_descriptor');
    const id = crypto.randomUUID();
    const token = crypto.randomBytes(24).toString('base64url'); // the attendee's private key for inbox / withdrawal
    this.people.set(id, {
      id,
      tokenHash: hash(token),
      descriptor: Float64Array.from(descriptor),
      profile,
      policy,
      enrolledAt: Date.now(),
    });
    return { id, token };
  }

  byToken(token) {
    if (typeof token !== 'string' || !token) return null;
    const h = hash(token);
    for (const p of this.people.values()) {
      if (timingSafeEqualStr(p.tokenHash, h)) return p;
    }
    return null;
  }

  remove(id) {
    return this.people.delete(id);
  }

  clear() {
    const n = this.people.size;
    this.people.clear();
    return n;
  }

  get size() {
    return this.people.size;
  }

  /**
   * 1:N search over the enrolled gallery only.
   * Returns { status: 'match' | 'no_match' | 'ambiguous', person?, distance }
   * The probe descriptor is never stored.
   */
  match(descriptor) {
    if (!isValidDescriptor(descriptor)) throw new Error('invalid_descriptor');
    let best = null;
    let bestD = Infinity;
    let secondD = Infinity;
    for (const p of this.people.values()) {
      const d = euclidean(descriptor, p.descriptor);
      if (d < bestD) {
        secondD = bestD;
        bestD = d;
        best = p;
      } else if (d < secondD) {
        secondD = d;
      }
    }
    if (!best || bestD > this.threshold) return { status: 'no_match', distance: round(bestD) };
    if (secondD - bestD < this.margin) return { status: 'ambiguous', distance: round(bestD) };
    return { status: 'match', person: best, distance: round(bestD) };
  }
}

function hash(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function round(x) {
  return Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null;
}

module.exports = { Gallery, euclidean, isValidDescriptor, DESCRIPTOR_LENGTH };
