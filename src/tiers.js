'use strict';
// Progressive disclosure tiers. Each tier includes everything in the tiers below it.

const TIERS = [
  { tier: 0, label: 'Nothing', fields: [] },
  { tier: 1, label: 'First name', fields: ['firstName'] },
  { tier: 2, label: 'Name, role and organization', fields: ['firstName', 'fullName', 'role', 'organization'] },
  { tier: 3, label: 'Name, role, organization and LinkedIn profile', fields: ['firstName', 'fullName', 'role', 'organization', 'linkedin'] },
];

const MAX_TIER = 3;

function clampTier(t, max = MAX_TIER) {
  const n = Number.parseInt(t, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, max, MAX_TIER);
}

/** Return only the profile fields allowed at this tier. */
function releasedView(profile, tier) {
  const t = TIERS[clampTier(tier)];
  const out = {};
  for (const f of t.fields) if (profile[f] !== undefined && profile[f] !== '') out[f] = profile[f];
  return out;
}

module.exports = { TIERS, MAX_TIER, clampTier, releasedView };
