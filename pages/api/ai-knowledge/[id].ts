/**
 * /api/ai-knowledge/[id]   (ADMIN only)
 *
 *   PATCH  { text }  -> edit an entry's text
 *   DELETE           -> remove an entry
 *
 * Curation of the field-trained AI knowledge base. See lib/hubspot.ts.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { updateKnowledgeEntry, deleteKnowledgeEntry } from '@/lib/hubspot';
import { isAppAdmin } from '@/lib/adminAccess';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await isAppAdmin(session.email))) return res.status(403).json({ error: 'Admin only.' });

  const { id } = req.query;
  if (!id || typeof id !== 'string') return res.status(400).json({ error: 'Missing entry id' });

  try {
    if (req.method === 'PATCH') {
      const body = req.body || {};
      const patch: { text?: string; expected?: string; template?: string; active?: boolean } = {};
      if (body.text !== undefined) {
        const text = String(body.text || '').trim();
        if (!text) return res.status(400).json({ error: 'Knowledge text is required.' });
        patch.text = text;
      }
      // `expected` present (even empty) means this is an example being edited.
      if (body.expected !== undefined) patch.expected = String(body.expected || '').trim();
      if (body.template !== undefined) patch.template = String(body.template || '');
      if (body.active !== undefined) patch.active = !!body.active;
      await updateKnowledgeEntry(id, patch);
      return res.status(200).json({ ok: true });
    }
    if (req.method === 'DELETE') {
      await deleteKnowledgeEntry(id);
      return res.status(200).json({ ok: true });
    }
    res.setHeader('Allow', 'PATCH, DELETE');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e: any) {
    console.error(`[ai-knowledge/${id}] ${req.method} failed:`, e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
