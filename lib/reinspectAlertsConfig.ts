/**
 * Config for the Turn Re-Inspect + New Construction RRQC result Slack alerts,
 * ported from the retired HubSpot workflow custom-code actions. PASS and FAIL
 * post to SEPARATE per-region channel sets. Region prefix → POD is the same
 * mapping the scope-approval cards use.
 */

// Leasing pipeline + the deal stages that mean "a lease is in motion"
// (Conditional Approval → Lease Start Day).
export const REINSPECT_LEASING_PIPELINE_ID = (process.env.HUBSPOT_LEASING_PIPELINE_ID || '24505349').trim();
export const REINSPECT_WATCHED_STAGES: Record<string, string> = {
  '93711522': 'Conditional Approval',
  '93711523': 'Full Approval',
  '93711524': 'Pre-Lease Compliance',
  '93679033': 'Lease Drafting',
  '1345950475': 'Lease Sent',
  '57133602': 'Move-in Scheduled',
  '57133603': 'Lease Start Day',
};
export const REINSPECT_STAGE_IDS = Object.keys(REINSPECT_WATCHED_STAGES);

// MIRD proximity warning threshold (days) on the FAIL card.
export const MIRD_FLAG_DAYS = 3;

export const COLOR_PASS = '#73E3DF'; // aqua left bar
export const COLOR_FAIL = '#ff0060'; // pink left bar

export type Pod = 'GA' | 'SE' | 'SW' | 'FL';

// PASS channel set (from Workflow B).
export const PASS_CHANNELS: Record<Pod, string> = {
  GA: 'C0A2NV9LNKB', SE: 'C0A26K1UH8V', SW: 'C0A2P01RTND', FL: 'C0A23L8NGRZ',
};
// FAIL channel set (from Workflow A) — a distinct set of channels.
export const FAIL_CHANNELS: Record<Pod, string> = {
  GA: 'C04HWGYM5HN', SE: 'C05FEMRF8Q6', SW: 'C04436J2SCW', FL: 'C04KHA52K4H',
};

// Pinged in the title line of every PASS card.
export const NOTIFY_USER = 'U03K6DWKBMM';

/** Region prefix → POD, or null when the region maps to no POD (skip the post). */
export function podForRegion(region: string | null): Pod | null {
  const r = (region || '').trim().toUpperCase();
  if (r.startsWith('GA:')) return 'GA';
  if (r.startsWith('NC:') || r.startsWith('SC:') || r.startsWith('AL:') || r.startsWith('TN:') || r.startsWith('IN:')) return 'SE';
  if (r.startsWith('TX:') || r.startsWith('AZ:') || r.startsWith('OK:')) return 'SW';
  if (r.startsWith('FL:')) return 'FL';
  return null;
}

// Per-template display + admin-gate key. Only these two templates alert.
export const REINSPECT_TEMPLATES: Record<string, { title: string; slackKey: string }> = {
  pm_turn_reinspect_qc: { title: 'Turn ReInspect', slackKey: 'reinspect_result' },
  qc_new_construction_rrqc: { title: 'New Construction RRQC', slackKey: 'rrqc_result' },
};
