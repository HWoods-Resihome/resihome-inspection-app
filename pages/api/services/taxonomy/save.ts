/**
 * POST /api/services/taxonomy/save — persist admin-added work types / subtypes.
 * Admin-gated. Body: { taxonomy: CustomWorktypeDef[] }. Stored as JSON on the
 * admin Agent record; merged with the built-in taxonomy across the Services app.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { servicesEnabled } from '@/lib/servicesAccess';
import { isAppAdmin } from '@/lib/adminAccess';
import { writeServiceTaxonomy } from '@/lib/hubspot';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  const session = await getSessionFromRequest(req).catch(() => null);
  const email = session?.email;
  const ok = (await servicesEnabled(email).catch(() => false)) && (await isAppAdmin(email).catch(() => false));
  if (!ok) return res.status(403).json({ error: 'Admin only' });

  const taxonomy = (req.body || {}).taxonomy;
  if (!Array.isArray(taxonomy)) return res.status(400).json({ error: 'taxonomy array required' });
  // Sanitize to the {id,label,subtypes:[{id,label}]} shape.
  const clean = taxonomy
    .filter((w: any) => w && typeof w.id === 'string' && w.id.trim())
    .map((w: any) => ({
      id: String(w.id).slice(0, 40),
      label: String(w.label || w.id).slice(0, 80),
      subtypes: Array.isArray(w.subtypes)
        ? w.subtypes.filter((s: any) => s && typeof s.id === 'string' && s.id.trim()).map((s: any) => ({ id: String(s.id).slice(0, 40), label: String(s.label || s.id).slice(0, 80) }))
        : [],
    }));
  try {
    const okw = await writeServiceTaxonomy(clean);
    return res.status(200).json({ ok: okw, preview: !okw });
  } catch (e: any) {
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300), detail: e?.detail || null });
  }
}
