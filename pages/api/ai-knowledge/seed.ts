/**
 * POST /api/ai-knowledge/seed — import the starter "gold list" of worked
 * examples into the AI Knowledge Base (ADMIN only). Idempotent: examples whose
 * utterance is already present are skipped, so it's safe to re-run after the
 * seed list grows. Returns { added, skipped }.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { seedKnowledgeExamples } from '@/lib/hubspot';
import { AI_KNOWLEDGE_EXAMPLE_SEED } from '@/lib/aiKnowledgeSeed';
import { isAppAdmin } from '@/lib/adminAccess';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!(await isAppAdmin(session.email))) return res.status(403).json({ error: 'Admin only.' });
  try {
    const { added, skipped } = await seedKnowledgeExamples(AI_KNOWLEDGE_EXAMPLE_SEED, session.email);
    return res.status(200).json({ ok: true, added, skipped, total: AI_KNOWLEDGE_EXAMPLE_SEED.length });
  } catch (e: any) {
    console.error('[ai-knowledge] seed failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
