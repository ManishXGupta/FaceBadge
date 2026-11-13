'use strict';
// End-to-end API tests of the registration-consent design.
// Manish Gupta's real public profile is the registered attendee being scanned.
const test = require('node:test');
const assert = require('node:assert/strict');
const mani = require('./fixtures/mani.json');
const { randomDescriptor, sameFace, start } = require('./helpers');
const { euclidean } = require('../src/gallery');

delete process.env.ANTHROPIC_API_KEY; // agent mode falls back to the rule-based agent here

const CONSENT = { biometric: true, scanLogging: true };
const MANI_FACE = randomDescriptor(42);
const PRIYA_FACE = randomDescriptor(11);
const STRANGER_FACE = randomDescriptor(7);
const PRIYA = { fullName: 'Priya Sharma', role: 'PhD student, AI governance', organization: 'University of Florida' };

const reg = (call, descriptor, profile, mode = 'everyone', text = '') =>
  call('/api/enroll', { method: 'POST', body: { descriptor, profile, policy: { mode, text }, consent: CONSENT } });
const scan = (call, token, descriptor, purpose = 'Enjoyed your talk on EU AI Act conformity') =>
  call('/api/match', { method: 'POST', token, body: { descriptor, purpose } });

test('registration requires both consents', async () => {
  const s = await start();
  try {
    const r = await s.call('/api/enroll', { method: 'POST', body: { descriptor: MANI_FACE, profile: mani.profile, policy: { mode: 'everyone' }, consent: { biometric: true } } });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'consent_required');
    assert.equal(s.app.gallery.size, 0);
  } finally { await s.close(); }
});

test('registration rejects a non-LinkedIn URL and a bad template', async () => {
  const s = await start();
  try {
    const bad = await reg(s.call, MANI_FACE, { ...mani.profile, linkedin: 'https://evil.example.com/in/x' });
    assert.equal(bad.body.error, 'invalid_linkedin_url');
    const badD = await reg(s.call, [1, 2, 3], mani.profile);
    assert.equal(badD.body.error, 'invalid_descriptor');
  } finally { await s.close(); }
});

test('only a registered attendee can scan', async () => {
  const s = await start();
  try {
    await reg(s.call, MANI_FACE, mani.profile);
    const anon = await scan(s.call, undefined, sameFace(MANI_FACE, 0.02, 1));
    assert.equal(anon.status, 401);
    assert.equal(anon.body.error, 'register_to_scan');
    const fake = await scan(s.call, 'not-a-real-token', sameFace(MANI_FACE, 0.02, 1));
    assert.equal(fake.status, 401);
  } finally { await s.close(); }
});

test('Priya scans Mani and gets his LinkedIn at once; Mani sees Priya in his scan log', async () => {
  const s = await start();
  try {
    const m = await reg(s.call, MANI_FACE, mani.profile, 'everyone');
    const p = await reg(s.call, PRIYA_FACE, PRIYA, 'everyone');
    const probe = sameFace(MANI_FACE, 0.02, 2);
    assert.ok(euclidean(probe, MANI_FACE) < 0.5);

    const r = await scan(s.call, p.body.token, probe);
    assert.equal(r.body.matched, true);
    assert.equal(r.body.tier, 3);
    assert.equal(r.body.shared.linkedin, 'https://www.linkedin.com/in/manish-gupta-9a871a10');
    assert.equal(r.body.shared.organization, 'Design Laboratory Inc.');

    const log = await s.call('/api/scans', { token: m.body.token });
    assert.equal(log.body.scans.length, 1);
    assert.equal(log.body.scans[0].scanner.name, 'Priya Sharma', 'scanner identity comes from her registration, not typed text');
    assert.equal(log.body.scans[0].scanner.purpose, 'Enjoyed your talk on EU AI Act conformity');
    assert.equal(log.body.scans[0].tier, 3);
    assert.equal(log.body.scans[0].self, false);
  } finally { await s.close(); }
});

test('a face that was never registered is never matched and nothing is kept', async () => {
  const s = await start();
  try {
    await reg(s.call, MANI_FACE, mani.profile);
    const p = await reg(s.call, PRIYA_FACE, PRIYA);
    const r = await scan(s.call, p.body.token, STRANGER_FACE);
    assert.equal(r.body.matched, false);
    assert.equal(r.body.reason, 'no_match');
    assert.equal(s.app.gallery.size, 2, 'stranger template was not added');
    assert.equal(s.app.scanLogs.size, 0, 'no log entry for a stranger');
    const csv = await s.call('/api/admin/eval.csv?key=test-admin');
    assert.ok(!/Manish|Priya/.test(csv.body), 'evaluation log has no names');
  } finally { await s.close(); }
});

test('name-only mode shares the first name and nothing else', async () => {
  const s = await start();
  try {
    await reg(s.call, MANI_FACE, mani.profile, 'name');
    const p = await reg(s.call, PRIYA_FACE, PRIYA);
    const r = await scan(s.call, p.body.token, sameFace(MANI_FACE, 0.02, 3));
    assert.equal(r.body.tier, 1);
    assert.deepEqual(r.body.shared, { firstName: 'Manish' });
  } finally { await s.close(); }
});

test('agent mode without Claude falls back to name only, and the reason is logged', async () => {
  const s = await start();
  try {
    const m = await reg(s.call, MANI_FACE, mani.profile, 'agent', mani.policy.text);
    const p = await reg(s.call, PRIYA_FACE, PRIYA);
    const r = await scan(s.call, p.body.token, sameFace(MANI_FACE, 0.02, 4));
    assert.equal(r.body.source, 'rules');
    assert.equal(r.body.tier, 1);
    const log = await s.call('/api/scans', { token: m.body.token });
    assert.match(log.body.scans[0].reason, /first name/i);
  } finally { await s.close(); }
});

test('after Mani blocks Priya, her scans show nothing', async () => {
  const s = await start();
  try {
    const m = await reg(s.call, MANI_FACE, mani.profile);
    const p = await reg(s.call, PRIYA_FACE, PRIYA);
    await scan(s.call, p.body.token, sameFace(MANI_FACE, 0.02, 5));
    const log = await s.call('/api/scans', { token: m.body.token });
    const priyaId = log.body.scans[0].scannerId;
    const b = await s.call('/api/block', { method: 'POST', token: m.body.token, body: { scannerId: priyaId } });
    assert.equal(b.body.blocked, true);
    const r = await scan(s.call, p.body.token, sameFace(MANI_FACE, 0.02, 6));
    assert.equal(r.body.tier, 0);
    assert.deepEqual(r.body.shared, {});
    const unb = await s.call('/api/block', { method: 'POST', token: m.body.token, body: { scannerId: priyaId, blocked: false } });
    assert.equal(unb.body.blocked, false);
  } finally { await s.close(); }
});

test('self-scan is recognized and marked in the log (used for the self-test)', async () => {
  const s = await start();
  try {
    const m = await reg(s.call, MANI_FACE, mani.profile);
    const r = await scan(s.call, m.body.token, sameFace(MANI_FACE, 0.02, 7));
    assert.equal(r.body.self, true);
    const log = await s.call('/api/scans', { token: m.body.token });
    assert.equal(log.body.scans[0].self, true);
  } finally { await s.close(); }
});

test('two near-identical registered faces give "ambiguous" instead of a risky guess', async () => {
  const s = await start();
  try {
    await reg(s.call, MANI_FACE, mani.profile);
    await reg(s.call, sameFace(MANI_FACE, 0.01, 99), { fullName: 'Twin Person' });
    const p = await reg(s.call, PRIYA_FACE, PRIYA);
    const r = await scan(s.call, p.body.token, sameFace(MANI_FACE, 0.01, 8));
    assert.equal(r.body.matched, false);
    assert.equal(r.body.reason, 'ambiguous');
  } finally { await s.close(); }
});

test('withdrawing consent deletes the template and the scan log immediately', async () => {
  const s = await start();
  try {
    const m = await reg(s.call, MANI_FACE, mani.profile);
    const p = await reg(s.call, PRIYA_FACE, PRIYA);
    await scan(s.call, p.body.token, sameFace(MANI_FACE, 0.02, 9));
    const w = await s.call('/api/me', { method: 'DELETE', token: m.body.token });
    assert.equal(w.body.deleted, true);
    assert.equal(s.app.gallery.size, 1);
    assert.equal(s.app.scanLogs.size, 0);
    const r = await scan(s.call, p.body.token, sameFace(MANI_FACE, 0.02, 10));
    assert.equal(r.body.matched, false);
  } finally { await s.close(); }
});

test('the organizer can end the event and wipe all templates and logs', async () => {
  const s = await start();
  try {
    await reg(s.call, MANI_FACE, mani.profile);
    const p = await reg(s.call, PRIYA_FACE, PRIYA);
    await scan(s.call, p.body.token, sameFace(MANI_FACE, 0.02, 11));
    assert.equal((await s.call('/api/admin/close', { method: 'POST', token: 'wrong' })).status, 403);
    const c = await s.call('/api/admin/close', { method: 'POST', token: 'test-admin' });
    assert.equal(c.body.deletedTemplates, 2);
    assert.equal(s.app.gallery.size, 0);
    assert.equal(s.app.scanLogs.size, 0);
  } finally { await s.close(); }
});

test('after the event end time, data is wiped and registration is closed', async () => {
  const s = await start({ eventEndsAt: new Date(Date.now() + 300).toISOString() });
  try {
    await reg(s.call, MANI_FACE, mani.profile);
    await new Promise((r) => setTimeout(r, 400));
    const ev = await s.call('/api/event');
    assert.equal(ev.body.enrolled, 0);
    assert.equal((await reg(s.call, MANI_FACE, mani.profile)).status, 410);
  } finally { await s.close(); }
});

test('scan rate limit stops mass scanning by one attendee', async () => {
  const s = await start({ scanRatePerMin: 5 });
  try {
    await reg(s.call, MANI_FACE, mani.profile);
    const p = await reg(s.call, PRIYA_FACE, PRIYA);
    let last;
    for (let i = 0; i < 6; i++) last = await scan(s.call, p.body.token, randomDescriptor(1000 + i));
    assert.equal(last.status, 429);
  } finally { await s.close(); }
});
