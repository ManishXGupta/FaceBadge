/* Consent Face Connect: browser client.
   All face processing happens here, on the device. The server only ever receives
   a 128-number template for ONE face: your own at enrollment, or the single
   closest person when you scan. Video frames are never uploaded. */
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  // ---- config ----
  const DETECT_OPTS = () => new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
  const MIN_FACE_FRACTION = 0.18; // "barcode distance": the face must fill at least this much of the frame width
  const SCAN_INTERVAL_MS = 450;
  const COOLDOWN_MS = 4000;

  let modelsReady = false;
  let token = store.get('cfc_token');
  let requesterKey = store.get('cfc_requester_key');
  if (!requesterKey) {
    requesterKey = crypto.getRandomValues(new Uint32Array(4)).join('-');
    store.set('cfc_requester_key', requesterKey);
  }

  // ---- tabs ----
  function showTab(name) {
    document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.id !== `tab-${name}`; });
    if (name !== 'scan') stopScan();
  }
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  // ---- api ----
  async function api(path, opts = {}) {
    const headers = { 'content-type': 'application/json' };
    if (opts.auth && token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || `http_${res.status}`); e.status = res.status; throw e; }
    return data;
  }

  api('/api/event').then((e) => {
    $('#eventLine').textContent = `${e.event} · ${e.enrolled} joined · agent: ${e.agent === 'claude' ? 'Claude' : 'rule-based'}${e.eventEndsAt ? ` · data deleted after ${new Date(e.eventEndsAt).toLocaleString()}` : ''}`;
  }).catch(() => { $('#eventLine').textContent = 'Server not reachable'; });

  // ---- models ----
  async function loadModels() {
    try {
      try { await faceapi.tf.setBackend('webgl'); } catch { /* fall through */ }
      await faceapi.tf.ready();
      if (faceapi.tf.getBackend() !== 'webgl') { await faceapi.tf.setBackend('cpu'); await faceapi.tf.ready(); }
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri('models'),
        faceapi.nets.faceLandmark68TinyNet.loadFromUri('models'),
        faceapi.nets.faceRecognitionNet.loadFromUri('models'),
      ]);
      modelsReady = true;
      $('#modelStatus').textContent = `Face models ready on this device (${faceapi.tf.getBackend()}).`;
      $('#scanBtn').disabled = false;
      refreshEnrollButton();
    } catch (err) {
      $('#modelStatus').textContent = `Could not load face models: ${err.message}`;
      $('#modelStatus').classList.add('err');
    }
  }

  // ---- camera ----
  async function startCamera(video, facingMode) {
    if (video.srcObject) return;
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
    video.srcObject = stream;
    await video.play();
    await new Promise((r) => (video.readyState >= 2 ? r() : video.addEventListener('loadeddata', r, { once: true })));
  }
  function stopCamera(video) {
    const s = video.srcObject;
    if (s) s.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  }

  // ---- face pipeline ----
  // 1) detect all faces (boxes only), 2) keep ONLY the largest one if it is close enough,
  // 3) compute a template for that one face. Other faces never get a template.
  async function closestFaceTemplate(video, overlay) {
    const dets = await faceapi.detectAllFaces(video, DETECT_OPTS());
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    let chosen = null;
    for (const d of dets) if (!chosen || d.box.area > chosen.box.area) chosen = d;
    const closeEnough = chosen && chosen.box.width >= MIN_FACE_FRACTION * vw;
    drawOverlay(overlay, vw, vh, dets, closeEnough ? chosen : null);
    if (!chosen) return { status: 'no_face', faces: 0 };
    if (!closeEnough) return { status: 'too_far', faces: dets.length };

    const [crop] = await faceapi.extractFaces(video, [chosen]);
    const landmarks = await faceapi.detectFaceLandmarksTiny(crop);
    const [aligned] = await faceapi.extractFaces(crop, [landmarks.align()]);
    const descriptor = await faceapi.computeFaceDescriptor(aligned);
    return { status: 'ok', descriptor: Array.from(descriptor), faces: dets.length, ignored: dets.length - 1, score: chosen.score };
  }

  function drawOverlay(canvas, w, h, dets, chosen) {
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    for (const d of dets) {
      const isChosen = chosen && d === chosen;
      const b = d.box;
      ctx.lineWidth = isChosen ? 4 : 2;
      ctx.strokeStyle = isChosen ? '#0a66c2' : 'rgba(200,200,200,.8)';
      if (!isChosen) {
        ctx.fillStyle = 'rgba(40,40,40,.55)'; // visually mask people who are not being scanned
        ctx.fillRect(b.x, b.y, b.width, b.height);
      }
      ctx.strokeRect(b.x, b.y, b.width, b.height);
    }
  }

  function dist(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2; return Math.sqrt(s); }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- enrollment ----
  const form = $('#enrollForm');
  function refreshEnrollButton() {
    const ok = modelsReady && $('#enrollVideo').srcObject && form.consentBio.checked && form.consentRules.checked && form.fullName.value.trim();
    $('#enrollBtn').disabled = !ok;
  }
  form.addEventListener('input', refreshEnrollButton);
  form.addEventListener('change', refreshEnrollButton);
  $('#startEnrollCam').addEventListener('click', async () => {
    try { await startCamera($('#enrollVideo'), 'user'); $('#startEnrollCam').hidden = true; refreshEnrollButton(); }
    catch (err) { setMsg('#enrollMsg', `Camera error: ${err.message}. Camera needs HTTPS or localhost.`, true); }
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = $('#enrollBtn');
    btn.disabled = true;
    try {
      setMsg('#enrollMsg', 'Look at the camera. Taking 3 samples…');
      const samples = [];
      for (let tries = 0; samples.length < 3 && tries < 20; tries++) {
        const r = await closestFaceTemplate($('#enrollVideo'), $('#enrollOverlay'));
        if (r.status === 'ok') samples.push(r.descriptor);
        await sleep(350);
      }
      if (samples.length < 3) throw new Error('Could not see your face clearly. Move closer and try again.');
      for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) {
        if (dist(samples[i], samples[j]) > 0.45) throw new Error('Samples look like different faces. Make sure only you are in front of the camera.');
      }
      const avg = samples[0].map((_, k) => (samples[0][k] + samples[1][k] + samples[2][k]) / 3);
      const f = new FormData(form);
      const out = await api('/api/enroll', {
        method: 'POST',
        body: {
          descriptor: avg,
          profile: { fullName: f.get('fullName'), role: f.get('role'), organization: f.get('organization'), linkedin: f.get('linkedin').trim() },
          policy: { mode: f.get('mode') || 'everyone', text: f.get('policyText') },
          consent: { biometric: !!f.get('consentBio'), scanLogging: !!f.get('consentRules') },
        },
      });
      token = out.token;
      store.set('cfc_token', token);
      stopCamera($('#enrollVideo'));
      setMsg('#enrollMsg', '');
      renderEnrolled();
      pollInbox();
    } catch (err) {
      setMsg('#enrollMsg', friendly(err), true);
      refreshEnrollButton();
    }
  });

  $('#withdrawBtn').addEventListener('click', async () => {
    try { await api('/api/me', { method: 'DELETE', auth: true }); } catch { /* already gone */ }
    token = null; store.del('cfc_token');
    renderEnrolled();
  });

  function renderEnrolled() {
    $('#enrollDone').hidden = !token;
    form.hidden = !!token;
    if (!token) $('#startEnrollCam').hidden = false;
  }

  // ---- who scanned me (the scanned person's side) ----
  let inboxTimer = null;
  async function pollInbox() {
    clearTimeout(inboxTimer);
    if (!token) return;
    try {
      const data = await api('/api/scans', { auth: true });
      renderLog(data);
    } catch (err) {
      if (err.status === 401) { token = null; store.del('cfc_token'); renderEnrolled(); return; }
    }
    inboxTimer = setTimeout(pollInbox, 2000);
  }

  const TIER_LABELS = ['Nothing', 'First name', 'Name, role and organization', 'Name, role, organization and LinkedIn'];
  function renderLog({ scans }) {
    const list = $('#inboxList');
    const others = scans.filter((s) => !s.self).length;
    $('#inboxBadge').hidden = others === 0;
    $('#inboxBadge').textContent = others;
    if (!scans.length) { list.innerHTML = '<p class="empty">Nobody has scanned you yet.</p>'; return; }
    list.replaceChildren(...scans.map((e) => {
      const el = document.createElement('div');
      el.className = 'req';
      el.dataset.scanId = e.id;
      el.innerHTML = '<h3></h3><div class="meta"></div><div class="agent"></div><div class="actions"></div>';
      el.querySelector('h3').textContent = e.self ? 'You (self-scan)' : `${e.scanner.name} scanned you`;
      el.querySelector('.meta').textContent = [new Date(e.at).toLocaleTimeString(), e.scanner.role, e.scanner.organization, e.scanner.purpose && `"${e.scanner.purpose}"`].filter(Boolean).join(' · ');
      el.querySelector('.agent').textContent = `Shared: ${TIER_LABELS[e.tier]}. ${e.reason || ''}`;
      const actions = el.querySelector('.actions');
      if (!e.self) {
        const b = document.createElement('button');
        b.className = e.blocked ? 'ghost' : 'ghost danger';
        b.textContent = e.blocked ? 'Unblock' : 'Block this person';
        b.dataset.action = e.blocked ? 'unblock' : 'block';
        b.addEventListener('click', async () => {
          await api('/api/block', { method: 'POST', auth: true, body: { scannerId: e.scannerId, blocked: !e.blocked } });
          pollInbox();
        });
        actions.appendChild(b);
      }
      return el;
    }));
  }

  // ---- scanning (the requester's side) ----
  let scanning = false;
  let pollTimer = null;
  $('#scanBtn').addEventListener('click', () => (scanning ? stopScan() : startScan()));

  async function startScan() {
    try {
      await startCamera($('#scanVideo'), 'environment');
    } catch (err) {
      setMsg('#scanState', `Camera error: ${err.message}. Camera needs HTTPS or localhost.`, true);
      return;
    }
    if (!token) { setMsg('#scanState', 'Register first. Only registered attendees can scan.', true); stopCamera($('#scanVideo')); return; }
    scanning = true;
    $('#scanBtn').textContent = 'Stop';
    $('#scanVideo').parentElement.classList.add('scanning');
    scanLoop();
  }
  function stopScan() {
    scanning = false;
    $('#scanBtn').textContent = 'Start scanning';
    $('#scanVideo').parentElement.classList.remove('scanning');
    stopCamera($('#scanVideo'));
    const ov = $('#scanOverlay'); ov.getContext('2d').clearRect(0, 0, ov.width, ov.height);
  }

  async function scanLoop() {
    while (scanning) {
      const t0 = performance.now();
      let r;
      try { r = await closestFaceTemplate($('#scanVideo'), $('#scanOverlay')); } catch { r = { status: 'error' }; }
      if (!scanning) break;
      if (r.status === 'no_face') setMsg('#scanState', 'Looking for a face…');
      else if (r.status === 'too_far') setMsg('#scanState', 'Move closer to one person.');
      else if (r.status === 'ok') {
        setMsg('#scanState', `Checking… (${r.ignored} other face${r.ignored === 1 ? '' : 's'} ignored on this phone)`);
        try {
          const out = await api('/api/match', { method: 'POST', auth: true, body: { descriptor: r.descriptor, purpose: $('#reqPurpose').value } });
          const ms = Math.round(performance.now() - t0);
          if (out.matched) {
            setMsg('#scanState', `Found a registered attendee in ${ms} ms.`);
            stopScan();
            showResult(out);
            return;
          }
          setMsg('#scanState', out.reason === 'ambiguous' ? 'Not sure who this is, so nothing was shared.' : 'This person is not registered. Nothing was stored.');
          await sleep(COOLDOWN_MS);
        } catch (err) {
          setMsg('#scanState', friendly(err), true);
          await sleep(COOLDOWN_MS);
        }
      }
      await sleep(SCAN_INTERVAL_MS);
    }
  }

  function showResult(s) {
    const box = $('#scanResult');
    box.innerHTML = '<div class="result" id="resultCard"></div>';
    const card = $('#resultCard');
    card.dataset.tier = s.tier;
    const sh = s.shared || {};
    if (s.tier > 0) {
      const n = document.createElement('div'); n.className = 'name'; n.textContent = (sh.fullName || sh.firstName) + (s.self ? ' (you)' : ''); card.appendChild(n);
      if (sh.role || sh.organization) { const m = document.createElement('div'); m.className = 'msg'; m.textContent = [sh.role, sh.organization].filter(Boolean).join(' · '); card.appendChild(m); }
      if (sh.linkedin) {
        const a = document.createElement('a');
        a.className = 'primary li'; a.id = 'openLinkedIn';
        a.href = sh.linkedin; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.textContent = 'Open LinkedIn and connect';
        card.appendChild(a);
      }
    }
    const st = document.createElement('div'); st.className = 'msg';
    st.textContent = s.tier === 0 ? 'This person is not sharing with you.' : `Shared: ${s.tierLabel}. ${s.reason || ''}`;
    card.appendChild(st);
  }

  // ---- helpers ----
  function setMsg(sel, text, err = false) { const el = $(sel); el.textContent = text; el.classList.toggle('err', !!err); }
  function friendly(err) {
    const map = {
      consent_required: 'Please tick both consent boxes.',
      register_to_scan: 'Register first. Only registered attendees can scan.',
      invalid_linkedin_url: 'LinkedIn URL should look like https://www.linkedin.com/in/your-id',
      name_required: 'Please enter your name.',
      too_many_scans: 'Too many scans. Please wait a minute.',
      event_closed: 'This event has ended and all data was deleted.',
    };
    return map[err.message] || err.message;
  }

  renderEnrolled();
  pollInbox();
  loadModels();
})();
