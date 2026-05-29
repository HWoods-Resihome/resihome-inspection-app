import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { fetchQuestionsForTemplate } from '@/lib/hubspot';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Defense-in-depth: middleware already gates this, but verify the
  // session here too so the route is never reachable unauthenticated
  // even if the middleware matcher changes.
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const template = String(req.query.template || '');
  const debug = req.query.debug === '1';
  if (!template) {
    return res.status(400).json({ error: 'Missing ?template=...' });
  }
  try {
    const result = await fetchQuestionsForTemplate(template, { debug });
    if (debug) {
      return res.status(200).json({
        template,
        questions: result.questions,
        debug: result.debug,
      });
    }
    return res.status(200).json({ questions: result.questions });
  } catch (e: any) {
    console.error('GET /api/questions failed:', e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}
