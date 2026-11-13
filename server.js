'use strict';
const { createApp } = require('./src/app');

const port = Number(process.env.PORT || 3000);
const { server, cfg } = createApp();

server.listen(port, () => {
  console.log(`Consent Face Connect running on http://localhost:${port}`);
  console.log(`Event: ${cfg.eventName}${cfg.eventEndsAt ? ` (data wiped after ${cfg.eventEndsAt})` : ''}`);
  console.log(`Disclosure agent: ${process.env.ANTHROPIC_API_KEY ? `Claude (${process.env.CLAUDE_MODEL || 'claude-sonnet-5-5'})` : 'rule-based fallback (set ANTHROPIC_API_KEY to use Claude)'}`);
  if (!process.env.ADMIN_KEY) console.log(`Admin key (for /api/admin/*): ${cfg.adminKey}`);
});
