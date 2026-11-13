'use strict';
// HTTP API + static file server. No external dependencies.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Gallery, isValidDescriptor } = require('./gallery');
const { clampTier, releasedView, TIERS, MAX_TIER } = require('./tiers');
const agent = require('./agent');
const { EvalLog } = require('./evalLog');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.bin': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const LINKEDIN_RE = /^https:\/\/(www\.)?linkedin\.com\/in\/[A-Za-z0-9\-_%]{3,100}\/?$/;

function createApp(config = {}) {
  const cfg = {
    eventName: config.eventName || process.env.EVENT_NAME || 'Demo Conference 2026',
    eventEndsAt: config.eventEndsAt || process.env.EVENT_ENDS_AT || null, // ISO time; data wiped after this
    adminKey: config.adminKey || process.env.ADMIN_KEY || crypto.randomBytes(12).toString('base64url'),
    threshold: Number(config.threshold || process.env.MATCH_THRESHOLD || 0.5),
    margin: Number(config.margin || process.env.MATCH_MARGIN || 0.05),
    requestTtlMs: Number(config.requestTtlMs || 10 * 60 * 1000),
    scanRatePerMin: Number(config.scanRatePerMin || 30),
  };

  const gallery = new Gallery({ threshold: cfg.threshold, margin: cfg.margin });
  const requests = new Map(); // id -> request
  const evalLog = new EvalLog();
  const scanBuckets = new Map(); // scanner id -> [timestamps]
  const scanLogs = new Map(); // scanned attendee id -> [log entries]

  function eventOver() {
    return cfg.eventEndsAt && Date.now() > Date.parse(cfg.eventEndsAt);
  }

  function wipeAll(reason) {
    const n = gallery.clear();
    requests.clear();
    scanLogs.clear();
    evalLog.add('event_closed', { outcome: `${reason}:${n}_templates_deleted` });
    return n;
  }

  function rateLimited(key) {
    const now = Date.now();
    const arr = (scanBuckets.get(key) || []).filter((t) => now - t < 60_000);
    arr.push(now);
    scanBuckets.set(key, arr);
    return arr.length > cfg.scanRatePerMin;
  }

  const MODES = { everyone: 3, agent: 3, name: 1 };

  // ---------------- API handlers ----------------

  // Registration: consent is given once, here. The sharing mode is chosen here too.
  async function enroll(body) {
    const { descriptor, profile = {}, policy = {}, consent = {} } = body || {};
    if (!consent.biometric || !consent.scanLogging) return [400, { error: 'consent_required' }];
    if (!isValidDescriptor(descriptor)) return [400, { error: 'invalid_descriptor' }];
    const fullName = str(profile.fullName, 80);
    const linkedin = str(profile.linkedin, 200);
    if (!fullName) return [400, { error: 'name_required' }];
    if (linkedin && !LINKEDIN_RE.test(linkedin)) return [400, { error: 'invalid_linkedin_url' }];
    const mode = Object.prototype.hasOwnProperty.call(MODES, policy.mode) ? policy.mode : 'everyone';
    const cleanProfile = {
      fullName,
      firstName: str(profile.firstName, 40) || fullName.split(/\s+/)[0],
      role: str(profile.role, 120),
      organization: str(profile.organization, 120),
      linkedin,
    };
    const cleanPolicy = { mode, text: str(policy.text, 600), maxTier: MODES[mode] };
    const { id, token } = gallery.enroll({ descriptor, profile: cleanProfile, policy: cleanPolicy });
    gallery.people.get(id).blocked = new Set();
    evalLog.add('enrolled', { outcome: `mode=${mode}` });
    return [201, { attendeeId: id, token, event: cfg.eventName, eventEndsAt: cfg.eventEndsAt }];
  }

  // Scanning: only a registered attendee (verified by their token) can scan.
  // The result is released at once, at the tier set by the scanned person's registration choice.
  async function match(body, bearer) {
    const scanner = gallery.byToken(bearer);
    if (!scanner) return [401, { error: 'register_to_scan' }];
    if (rateLimited(scanner.id)) return [429, { error: 'too_many_scans' }];
    const { descriptor, purpose } = body || {};
    if (!isValidDescriptor(descriptor)) return [400, { error: 'invalid_descriptor' }];

    const t0 = process.hrtime.bigint();
    const result = gallery.match(descriptor);
    const matchMs = Number(process.hrtime.bigint() - t0) / 1e6;

    if (result.status !== 'match') {
      // The probe template is discarded here. Nothing about this face is kept.
      evalLog.add('scan', { distance: result.distance, matchMs: matchMs.toFixed(3), outcome: result.status });
      return [200, { matched: false, reason: result.status }];
    }

    const owner = result.person;
    const scannerInfo = {
      name: scanner.profile.fullName,
      role: scanner.profile.role,
      organization: scanner.profile.organization,
      purpose: str(purpose, 300),
    };
    let dec;
    if (owner.blocked && owner.blocked.has(scanner.id)) dec = { tier: 0, reason: 'You blocked this person.', source: 'block' };
    else if (owner.policy.mode === 'everyone') dec = { tier: 3, reason: 'Shares with every registered attendee.', source: 'policy' };
    else if (owner.policy.mode === 'name') dec = { tier: 1, reason: 'Shares name only.', source: 'policy' };
    else dec = await agent.recommend({ owner, requester: scannerInfo, eventName: cfg.eventName });
    const tier = clampTier(dec.tier, owner.policy.maxTier);

    const entry = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      scannerId: scanner.id,
      scanner: scannerInfo,
      self: scanner.id === owner.id,
      tier,
      source: dec.source,
      reason: dec.reason,
    };
    if (!scanLogs.has(owner.id)) scanLogs.set(owner.id, []);
    scanLogs.get(owner.id).unshift(entry);

    evalLog.add('scan', {
      requestId: entry.id,
      distance: result.distance,
      matchMs: matchMs.toFixed(3),
      agentSource: dec.source,
      agentMs: dec.latencyMs ?? '',
      recommendedTier: dec.tier,
      releasedTier: tier,
      outcome: tier === 0 ? 'blocked_or_withheld' : 'released',
    });
    return [200, { matched: true, self: entry.self, tier, tierLabel: TIERS[tier].label, shared: releasedView(owner.profile, tier), reason: dec.reason, source: dec.source }];
  }

  // "Who scanned me": every scan of this attendee, with the scanner's registered identity.
  function scanLog(token) {
    const me = gallery.byToken(token);
    if (!me) return [401, { error: 'unknown_attendee' }];
    const blocked = me.blocked || new Set();
    return [200, {
      me: { profile: me.profile, policy: me.policy },
      scans: (scanLogs.get(me.id) || []).map((e) => ({ ...e, blocked: blocked.has(e.scannerId) })),
    }];
  }

  function setBlock(token, body) {
    const me = gallery.byToken(token);
    if (!me) return [401, { error: 'unknown_attendee' }];
    const id = str(body && body.scannerId, 64);
    if (!id) return [400, { error: 'scanner_required' }];
    if (!me.blocked) me.blocked = new Set();
    if (body.blocked === false) me.blocked.delete(id); else me.blocked.add(id);
    evalLog.add(body.blocked === false ? 'unblocked' : 'blocked', { outcome: 'ok' });
    return [200, { blocked: me.blocked.has(id) }];
  }

  function withdraw(token) {
    const me = gallery.byToken(token);
    if (!me) return [401, { error: 'unknown_attendee' }];
    gallery.remove(me.id);
    scanLogs.delete(me.id);
    evalLog.add('withdrawn', { outcome: 'template_and_log_deleted' });
    return [200, { deleted: true }];
  }

  // ---------------- HTTP plumbing ----------------

  const server = http.createServer(async (req, res) => {
    try {
      if (eventOver() && gallery.size > 0) wipeAll('event_end');
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname;
      const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

      if (p.startsWith('/api/')) {
        let out;
        if (req.method === 'GET' && p === '/api/event') {
          out = [200, { event: cfg.eventName, eventEndsAt: cfg.eventEndsAt, enrolled: gallery.size, threshold: cfg.threshold, agent: process.env.ANTHROPIC_API_KEY ? 'claude' : 'rules' }];
        } else if (req.method === 'POST' && p === '/api/enroll') {
          out = eventOver() ? [410, { error: 'event_closed' }] : await enroll(await readJson(req));
        } else if (req.method === 'POST' && p === '/api/match') {
          out = await match(await readJson(req), bearer);
        } else if (req.method === 'GET' && p === '/api/scans') {
          out = scanLog(bearer);
        } else if (req.method === 'POST' && p === '/api/block') {
          out = setBlock(bearer, await readJson(req));
        } else if (req.method === 'DELETE' && p === '/api/me') {
          out = withdraw(bearer);
        } else if (req.method === 'POST' && p === '/api/admin/close') {
          out = bearer === cfg.adminKey ? [200, { deletedTemplates: wipeAll('admin_close') }] : [403, { error: 'forbidden' }];
        } else if (req.method === 'GET' && p === '/api/admin/eval.csv') {
          if (url.searchParams.get('key') !== cfg.adminKey) out = [403, { error: 'forbidden' }];
          else {
            res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'cache-control': 'no-store' });
            return res.end(evalLog.toCSV());
          }
        } else {
          out = [404, { error: 'not_found' }];
        }
        return sendJson(res, out[0], out[1]);
      }

      // static files
      let file = p === '/' ? '/index.html' : p;
      file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
      const full = path.join(PUBLIC_DIR, file);
      if (!full.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'forbidden' });
      fs.readFile(full, (err, data) => {
        if (err) return sendJson(res, 404, { error: 'not_found' });
        res.writeHead(200, {
          'content-type': MIME[path.extname(full)] || 'application/octet-stream',
          'cache-control': file.startsWith('/models/') || file.startsWith('/vendor/') ? 'public, max-age=86400' : 'no-store',
          'permissions-policy': 'camera=(self)',
          'referrer-policy': 'no-referrer',
          'x-content-type-options': 'nosniff',
        });
        res.end(data);
      });
    } catch (err) {
      sendJson(res, err.status || 500, { error: err.code || 'server_error' });
    }
  });

  return { server, cfg, gallery, requests, evalLog, scanLogs };
}

function str(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        const e = new Error('too_large');
        e.status = 413;
        e.code = 'too_large';
        reject(e);
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        const e = new Error('bad_json');
        e.status = 400;
        e.code = 'bad_json';
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

module.exports = { createApp, LINKEDIN_RE };
