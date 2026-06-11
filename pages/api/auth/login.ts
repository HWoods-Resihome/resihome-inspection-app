// Step 1 of login: validate that the typed email is an active HubSpot user.
// This NO LONGER mints a session — authentication is completed by Google
// sign-in (see /api/auth/google-login -> /api/auth/gmail/callback). On success
// the client redirects the browser to /api/auth/google-login?email=...

import type { NextApiRequest, NextApiResponse } from 'next';
import { fetchActiveUsers } from '@/lib/hubspot';

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

    let users;
    try {
      users = await fetchActiveUsers();
    } catch (e: any) {
      console.error('Login: failed to fetch HubSpot users:', e);
      return res.status(500).json({ error: 'Could not verify users at this time. Try again.' });
    }

    const match = users.find((u) => u.email.toLowerCase() === normalized);
    if (!match) {
      // Generic error to avoid leaking whether an email exists in our portal.
      return res.status(401).json({ error: 'Email not recognized' });
    }

    // Valid HubSpot user. Don't create a session yet — tell the client to
    // continue to Google sign-in to prove ownership of this email.
    return res.status(200).json({ ok: true, next: 'google', email: match.email });
  } catch (e: any) {
    console.error('POST /api/auth/login failed:', e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}
