import type { NextApiRequest, NextApiResponse } from 'next';
import { fetchUsers } from '@/lib/hubspot';
import { createSessionCookie } from '@/lib/auth';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  try {
    const { email } = req.body || {};
    if (!email || typeof email !== 'string') {
      return res.status(400).json({ error: 'Email is required' });
    }
    const normalized = email.trim().toLowerCase();
    if (!normalized.includes('@')) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Look up the email in HubSpot users (this is our source of truth)
    let users;
    try {
      users = await fetchUsers();
    } catch (e: any) {
      console.error('Login: failed to fetch HubSpot users:', e);
      return res.status(500).json({ error: 'Could not verify users at this time. Try again.' });
    }

    const match = users.find((u) => u.email.toLowerCase() === normalized);
    if (!match) {
      // Generic error to avoid leaking whether an email exists in our portal
      return res.status(401).json({ error: 'Email not recognized' });
    }

    const cookie = await createSessionCookie({
      userId: match.id,
      email: match.email,
      name: match.fullName,
    });
    res.setHeader('Set-Cookie', cookie);
    return res.status(200).json({
      ok: true,
      user: { userId: match.id, email: match.email, name: match.fullName },
    });
  } catch (e: any) {
    console.error('POST /api/auth/login failed:', e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}
