/**
 * GET /api/admin/env-check — ADMIN diagnostic: validate every HUBSPOT_*_TYPE_ID
 * environment variable against the portal's REAL object schemas.
 *
 * Built for the "Invalid object or event type id" class of outage (an env var
 * edited to a typo'd / wrong-portal id breaks whole app sections with sanitized
 * 400s). Returns, per variable: the configured value, whether it matches a real
 * schema in THIS portal, and which object it points at — plus the portal's full
 * custom-object catalog (name → objectTypeId) so the correct value is right
 * there to copy. Read-only; never prints the token.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';
import { listAllSchemas } from '@/lib/hubspot';

const TYPE_ID_VARS = [
  'HUBSPOT_INSPECTION_TYPE_ID',
  'HUBSPOT_INSPECTION_QUESTION_TYPE_ID',
  'HUBSPOT_INSPECTION_ANSWER_TYPE_ID',
  'HUBSPOT_PROPERTY_TYPE_ID',
  'HUBSPOT_RATE_CARD_LINE_ITEM_TYPE_ID',
  'HUBSPOT_REGION_RATE_TYPE_ID',
  'HUBSPOT_SERVICE_TYPE_ID',
  'HUBSPOT_SERVICE_RULE_TYPE_ID',
  'HUBSPOT_COMMUNITY_TYPE_ID',
  'HUBSPOT_LISTING_TYPE_ID',
  'HUBSPOT_AGENT_TYPE_ID',
  'HUBSPOT_DEALS_TYPE_ID',      // standard object — '0-3' is valid without a schema entry
];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req).catch(() => null);
  if (!session?.email) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.realEmail || session.email).catch(() => false))) {
    return res.status(403).json({ error: 'Admin only.' });
  }
  try {
    const schemas = await listAllSchemas();
    const byId = new Map(schemas.map((s) => [s.objectTypeId, s]));
    const vars = TYPE_ID_VARS.map((name) => {
      const value = (process.env[name] || '').trim();
      if (!value) return { name, value: '(not set)', ok: false, note: 'Not set — code default applies where one exists.' };
      // Standard CRM objects (0-x) are valid without appearing in /schemas.
      if (/^0-\d+$/.test(value)) return { name, value, ok: true, note: 'Standard HubSpot object id.' };
      const hit = byId.get(value);
      return hit
        ? { name, value, ok: true, note: `→ "${hit.name}" (${hit.label})` }
        : { name, value, ok: false, note: '❌ NOT A VALID OBJECT IN THIS PORTAL — typo or wrong-portal id. Fix this variable.' };
    });
    return res.status(200).json({
      ok: vars.every((v) => v.ok || v.value === '(not set)'),
      broken: vars.filter((v) => !v.ok && v.value !== '(not set)').map((v) => v.name),
      vars,
      portalObjects: schemas.map((s) => ({ name: s.name, label: s.label, objectTypeId: s.objectTypeId })),
    });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300), hint: 'If this itself fails, HUBSPOT_TOKEN may be wrong.' });
  }
}
