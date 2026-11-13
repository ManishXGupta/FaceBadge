'use strict';
// Evaluation log for the paper. It holds NO names, NO face data and NO profile fields:
// only event types, timings, distances and tier decisions.

class EvalLog {
  constructor() {
    this.rows = [];
  }

  add(event, fields = {}) {
    this.rows.push({ t: new Date().toISOString(), event, ...fields });
  }

  clear() {
    this.rows = [];
  }

  toCSV() {
    const cols = ['t', 'event', 'requestId', 'distance', 'matchMs', 'agentSource', 'agentMs', 'recommendedTier', 'releasedTier', 'decisionMs', 'outcome'];
    const esc = (v) => {
      if (v === undefined || v === null) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [cols.join(','), ...this.rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n') + '\n';
  }
}

module.exports = { EvalLog };
