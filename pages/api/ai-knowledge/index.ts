/**
 * /api/ai-knowledge
 *
 *   GET  -> { entries }   list all knowledge-base entries (ADMIN only)
 *   POST -> { entry }     add a new entry (any authenticated inspector)
 *
 * The knowledge base is the field-trained guidance that feeds the LIVE in-camera
 * call-out model (see /api/rate-card/room-scan-live). Inspectors add entries by
 * voice from the AI camera ("Teach AI"); they go live immediately. Admins curate
 * (edit/delete) via /api/ai-knowledge/[id] and the /ai-knowledge screen.
 *
 * Stored as JSON on the admin's Agent record — see lib/hubspot.ts.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { readKnowledgeEntries, addKnowledgeEntry } from '@/lib/hubspot';
import { isAppAdmin } from '@/lib/adminAccess';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  if (req.method === 'GET') {
    // Listing is for the admin curation screen.
    if (!(await isAppAdmin(session.email))) return res.status(403).json({ error: 'Admin only.' });
    try {
      const entries = await readKnowledgeEntries();
      return res.status(200).json({ entries });
    } catch (e: any) {
      console.error('[ai-knowledge] list failed:', e);
      return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
    }
  }

  if (req.method === 'POST') {
    // Any authenticated inspector can teach the AI.
    try {
      const text = String((req.body || {}).text || '').trim();
      if (!text) return res.status(400).json({ error: 'Knowledge text is required.' });
      const entry = await addKnowledgeEntry({
        text,
        addedByEmail: session.email,
        addedByName: session.name,
      });
      return res.status(200).json({ ok: true, entry });
    } catch (e: any) {
      console.error('[ai-knowledge] add failed:', e);
      return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'Method not allowed' });
}
