/**
 * /api/insights/kb-changes   (canView — app admin OR Insights-Only user)
 *
 *   GET -> { entries }   recent AI Knowledge Base entries/adjustments for the
 *                        Insights "AI Knowledge Base changes" card.
 *
 * Read-only view of the live KB (HubSpot-backed readKnowledgeEntries): worked
 * examples, human rules, and AI-learned auto rules — newest first, with the
 * accept/reject evidence the loop recorded. Dismissed (tombstoned) auto entries
 * are hidden. No mutation here (curation stays on /ai-knowledge for admins).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { canViewInsights } from '@/lib/insightsAccess';
import { readKnowledgeEntries } from '@/lib/hubspot';

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!(await canViewInsights(session.email))) return res.status(403).json({ error: 'Insights access required.' });

  try {
    const raw = await readKnowledgeEntries();
    const entries = raw
      .filter((e) => e.status !== 'dismissed')
      .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt))
      .map((e) => {
        const m = (e.meta || {}) as Record<string, any>;
        return {
          id: e.id,
          text: e.text,
          kind: e.kind || 'rule',                 // 'rule' | 'example'
          source: e.source || 'inspector',        // 'inspector' | 'admin' | 'auto'
          expected: e.expected || null,
          addedByName: e.addedByName || null,
          createdAt: e.createdAt,
          updatedAt: e.updatedAt || null,
          // Evidence on AI-learned entries (for the "from N decisions (P✓ / Rx)" line).
          samples: num(m.samples),
          accepts: num(m.accepts),
          rejects: num(m.rejects),
          code: typeof m.code === 'string' ? m.code : null,
        };
      });
    // Headline counts for the card subtitle.
    const counts = {
      total: entries.length,
      auto: entries.filter((e) => e.source === 'auto').length,
      examples: entries.filter((e) => e.kind === 'example').length,
    };
    return res.status(200).json({ entries, counts });
  } catch (e: any) {
    console.error('[insights/kb-changes] failed:', e);
    return res.status(500).json({ error: String(e?.message || e).slice(0, 300) });
  }
}
