/**
 * POST /api/admin/impersonate — admin "view as / login as" another user.
 *
 *   { email, name }  → start viewing as that user (sets the impersonation cookie)
 *   { stop: true }   → stop and return to the admin's own view (clears it)
 *
 * App-admin only (checked against the admin's REAL identity, so it still works
 * while already impersonating). The cookie is signed + bound to the admin, so a
 * leaked cookie can't be replayed from another session. The admin's real identity
 * is preserved (session.realEmail) for the banner + audit.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest, createImpersonationCookie, clearImpersonationCookie } from '@/lib/auth';
import { isAppAdmin } from '@/lib/adminAccess';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  // Admin check against the REAL admin (works even while already impersonating).
  const adminEmail = session.realEmail || session.email;
  if (!(await isAppAdmin(adminEmail))) return res.status(403).json({ error: 'Admin only.' });

  const body = req.body || {};
  if (body.stop === true || !body.email) {
    res.setHeader('Set-Cookie', clearImpersonationCookie());
    return res.status(200).json({ ok: true, impersonating: false });
  }

  const email = String(body.email).trim();
  const name = String(body.name || '').trim();
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'A valid email is required.' });
  if (email.toLowerCase() === adminEmail.toLowerCase()) {
    // Viewing as yourself is a no-op — just clear any existing impersonation.
    res.setHeader('Set-Cookie', clearImpersonationCookie());
    return res.status(200).json({ ok: true, impersonating: false });
  }

  res.setHeader('Set-Cookie', await createImpersonationCookie({ email, name }, adminEmail));
  return res.status(200).json({ ok: true, impersonating: true, email, name });
}
