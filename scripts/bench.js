'use strict';
// Micro-benchmark: server-side 1:N matching time vs gallery size, and
// how the match threshold trades off false accepts vs false rejects on synthetic templates.
// Synthetic data only; real accuracy must come from the field study (see docs/evaluation-plan.md).
const { Gallery } = require('../src/gallery');
const { randomDescriptor, sameFace } = require('../test/helpers');

function pct(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

console.log('gallery_size,p50_ms,p95_ms');
for (const n of [50, 200, 500, 1000, 5000]) {
  const g = new Gallery({ threshold: 0.5 });
  const faces = [];
  for (let i = 0; i < n; i++) {
    faces.push(randomDescriptor(i + 1));
    g.enroll({ descriptor: faces[i], profile: {}, policy: {} });
  }
  const times = [];
  for (let k = 0; k < 300; k++) {
    const probe = sameFace(faces[k % n], 0.02, 10_000 + k);
    const t0 = process.hrtime.bigint();
    g.match(probe);
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  console.log(`${n},${pct(times, 50).toFixed(3)},${pct(times, 95).toFixed(3)}`);
}
