'use strict';
// Synthetic evaluation for the paper. Everything here uses SYNTHETIC face templates.
// The generator is calibrated so that distances look like those of the face-api model:
// same person, new photo: median about 0.39; different people: median about 0.85.
// These results show how the decision rule and the system behave. They are not
// a measurement of real face-recognition accuracy (that needs real faces).
//
// Part A: sweep of the match threshold (tau) and ambiguity margin (delta).
// Part B: a simulated 100-attendee event with 1,000 scans, run through the real HTTP server.
//
// Usage: node scripts/simulate.js [--json out.json]

const fs = require('node:fs');
const { Gallery, euclidean } = require('../src/gallery');
const { createApp } = require('../src/app');

delete process.env.ANTHROPIC_API_KEY; // agent mode uses the rule-based fallback in simulation

// ---------- deterministic synthetic templates ----------
let seed = 20261112;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const gauss = () => { let u = 0, v = 0; while (!u) u = rand(); while (!v) v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const D = 128;
const norm = (v) => { const n = Math.hypot(...v); return v.map((x) => x / n); };
const COMMON = norm(Array.from({ length: D }, gauss)); // shared "face-like" direction
const A = 1.5; // weight of the shared direction (sets between-person distance)
const PHOTO_NOISE = 0.30; // base per-photo variation; two photos of one person then differ by about 0.39

const newIdentity = () => norm(COMMON.map((c) => c * A + gauss() / Math.sqrt(D)));
const lookalikeOf = (id, s) => norm(id.map((x) => x + (gauss() * s) / Math.sqrt(D)));
// A photo: identity plus noise whose size varies with conditions (light, angle, distance).
const photo = (id) => norm(id.map((x) => x + (gauss() * PHOTO_NOISE * (0.6 + 0.8 * rand())) / Math.sqrt(D)));

const median = (xs) => { const a = [...xs].sort((p, q) => p - q); return a[a.length >> 1]; };
const pct = (xs, p) => { const a = [...xs].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))]; };
const r1 = (x) => Math.round(x * 10) / 10;

// ---------- Part A: decision-rule sweep ----------
function partA() {
  const N = 500;
  const ids = Array.from({ length: N }, newIdentity);
  // 3% of registered attendees have a registered lookalike (for example siblings).
  const LOOK = 15;
  for (let k = 0; k < LOOK; k++) ids[N - 1 - k] = lookalikeOf(ids[k], 0.25);
  const templates = ids.map(photo); // registration selfie
  // Probes
  const genuine = Array.from({ length: 2000 }, (_, k) => ({ truth: k % N, t: photo(ids[k % N]) }));
  const unregistered = Array.from({ length: 2000 }, (_, k) => {
    // 5% of unregistered people look like a registered attendee
    const id = k % 20 === 0 ? lookalikeOf(ids[k % N], 0.35) : newIdentity();
    return { t: photo(id) };
  });

  const gd = genuine.map((g) => euclidean(g.t, templates[g.truth]));
  const idist = unregistered.map((u) => Math.min(...templates.map((e) => euclidean(u.t, e))));
  const lookD = Array.from({ length: LOOK }, (_, k) => euclidean(templates[k], templates[N - 1 - k]));

  const rows = [];
  for (const tau of [0.4, 0.45, 0.5, 0.55, 0.6]) {
    for (const delta of [0, 0.05]) {
      const g = new Gallery({ threshold: tau, margin: delta });
      const idOf = new Map();
      templates.forEach((t, i) => { const { id } = g.enroll({ descriptor: t, profile: {}, policy: {} }); idOf.set(id, i); });
      let correct = 0, wrong = 0, amb = 0, miss = 0;
      for (const q of genuine) {
        const m = g.match(q.t);
        if (m.status === 'match') (idOf.get(m.person.id) === q.truth ? correct++ : wrong++);
        else if (m.status === 'ambiguous') amb++;
        else miss++;
      }
      let fm = 0;
      for (const q of unregistered) if (g.match(q.t).status === 'match') fm++;
      rows.push({
        tau, delta,
        trueMatchPct: r1((100 * correct) / genuine.length),
        wrongPersonPct: Math.round((10000 * wrong) / genuine.length) / 100,
        ambiguousPct: r1((100 * amb) / genuine.length),
        noMatchPct: r1((100 * miss) / genuine.length),
        unregisteredMatchedPct: Math.round((10000 * fm) / unregistered.length) / 100,
      });
    }
  }
  return {
    setup: { registered: N, registeredLookalikePairs: LOOK, genuineProbes: genuine.length, unregisteredProbes: unregistered.length, unregisteredLookalikeShare: 0.05 },
    distances: {
      genuineMedian: +median(gd).toFixed(3), genuineP95: +pct(gd, 95).toFixed(3),
      unregisteredNearestMedian: +median(idist).toFixed(3), unregisteredNearestP5: +pct(idist, 5).toFixed(3),
      lookalikePairMedian: +median(lookD).toFixed(3),
    },
    sweep: rows,
  };
}

// ---------- Part B: simulated event through the real server ----------
async function partB() {
  const app = createApp({ adminKey: 'sim', scanRatePerMin: 1e9 });
  await new Promise((r) => app.server.listen(0, r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return res.json();
  };

  const N = 100;
  const people = [];
  for (let i = 0; i < N; i++) {
    const id = newIdentity();
    const u = rand();
    const mode = u < 0.6 ? 'everyone' : u < 0.85 ? 'agent' : 'name';
    const out = await call('/api/enroll', {
      method: 'POST',
      body: {
        descriptor: photo(id),
        profile: { fullName: `Attendee ${i}`, firstName: `A${i}`, role: 'Researcher', organization: 'Org', linkedin: `https://www.linkedin.com/in/attendee-${i}` },
        policy: { mode, text: 'Share with researchers.' },
        consent: { biometric: true, scanLogging: true },
      },
    });
    people.push({ id, mode, token: out.token, attendeeId: out.attendeeId });
  }
  // 3 attendees block one other attendee in advance
  const blocks = new Set();
  for (let k = 0; k < 3; k++) {
    const owner = people[Math.floor(rand() * N)];
    const scanner = people[Math.floor(rand() * N)];
    if (owner === scanner) continue;
    await call('/api/block', { method: 'POST', token: owner.token, body: { scannerId: scanner.attendeeId } });
    blocks.add(owner.attendeeId + '>' + scanner.attendeeId);
  }

  const SCANS = 1000;
  const lat = [];
  const c = { registered: 0, unregistered: 0, released: 0, correctPerson: 0, wrongPerson: 0, noMatch: 0, ambiguous: 0, unregisteredReleased: 0, blockedPairs: 0, blockedHonored: 0, logged: 0, tier: { 0: 0, 1: 0, 3: 0 } };
  const expectTier = { everyone: 3, name: 1, agent: 1 };
  let modeCorrect = 0, modeChecked = 0;
  // Make some blocked pairs actually scan each other
  const blockedList = [...blocks].map((s) => s.split('>'));
  for (let k = 0; k < SCANS; k++) {
    let scanner, targetPerson = null, probe;
    const roll = rand();
    if (k < blockedList.length * 4) {
      const [ownerId, scannerId] = blockedList[k % blockedList.length];
      scanner = people.find((p) => p.attendeeId === scannerId);
      targetPerson = people.find((p) => p.attendeeId === ownerId);
      probe = photo(targetPerson.id);
    } else if (roll < 0.85) {
      scanner = people[Math.floor(rand() * N)];
      targetPerson = people[Math.floor(rand() * N)];
      probe = photo(targetPerson.id);
    } else {
      scanner = people[Math.floor(rand() * N)];
      probe = photo(newIdentity());
    }
    const t0 = process.hrtime.bigint();
    const r = await call('/api/match', { method: 'POST', token: scanner.token, body: { descriptor: probe, purpose: 'Liked your talk' } });
    lat.push(Number(process.hrtime.bigint() - t0) / 1e6);
    if (targetPerson) c.registered++; else c.unregistered++;
    if (!r.matched) { r.reason === 'ambiguous' ? c.ambiguous++ : c.noMatch++; continue; }
    c.logged++;
    c.tier[r.tier] = (c.tier[r.tier] || 0) + 1;
    if (!targetPerson) { c.unregisteredReleased++; continue; }
    const linkedinId = r.shared.linkedin ? r.shared.linkedin.split('attendee-')[1] : null;
    const isBlocked = blocks.has(targetPerson.attendeeId + '>' + scanner.attendeeId);
    if (isBlocked) { c.blockedPairs++; if (r.tier === 0) c.blockedHonored++; continue; }
    if (r.tier > 0) c.released++;
    const shownIdx = linkedinId ?? (r.shared.firstName ? r.shared.firstName.slice(1) : null);
    if (shownIdx !== null) {
      const truthIdx = String(people.indexOf(targetPerson));
      shownIdx === truthIdx ? c.correctPerson++ : c.wrongPerson++;
    }
    modeChecked++;
    if (r.tier === expectTier[targetPerson.mode]) modeCorrect++;
  }
  // Every match must be in the scanned person's log
  let logEntries = 0;
  for (const p of people) { const l = await call('/api/scans', { token: p.token }); logEntries += l.scans.length; }
  const close = await call('/api/admin/close', { method: 'POST', token: 'sim' });
  app.server.close();
  return {
    setup: { attendees: N, modes: { everyone: people.filter((p) => p.mode === 'everyone').length, agent: people.filter((p) => p.mode === 'agent').length, name: people.filter((p) => p.mode === 'name').length }, scans: SCANS, blockedPairs: blocks.size },
    counts: c,
    sharingMatchesRegistrationChoicePct: r1((100 * modeCorrect) / modeChecked),
    logEntries,
    logComplete: logEntries === c.logged,
    latencyMs: { p50: +pct(lat, 50).toFixed(2), p95: +pct(lat, 95).toFixed(2) },
    templatesDeletedAtClose: close.deletedTemplates,
  };
}

(async () => {
  const a = partA();
  const b = await partB();
  const out = { generatedAt: new Date().toISOString(), note: 'synthetic templates; see header', partA: a, partB: b };
  console.log(JSON.stringify(out, null, 2));
  const i = process.argv.indexOf('--json');
  if (i > 0) fs.writeFileSync(process.argv[i + 1], JSON.stringify(out, null, 2));
})();
