// Server-side proxy for the ResiWalk "Unlock" (Rently vendor code) button.
//
// WHY a server route (not a direct call from the app): issuing a code requires the
// VCB shared secret, which opens physical doors — it must NEVER ship in the web/
// native bundle. The browser calls THIS same-origin route (authenticated by the
// existing session cookie, no secret), and we forward to the VCB Apps Script Web
// App with the secret pulled from server env. The device only ever sees the code.
//
// The upstream Apps Script always returns HTTP 200 (ContentService can't set
// status codes), so callers MUST branch on the JSON `status` field, not res.status.
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ status: 'FAILED', errorClass: 'bad_request', error: 'Method not allowed' });
    return;
  }

  // Only signed-in users. The email is read from the SESSION (authoritative) and
  // forwarded for the endpoint's domain check — never trusted from the client.
  const session = await getSessionFromRequest(req);
  if (!session) {
    res.status(200).json({ status: 'FAILED', errorClass: 'forbidden', error: 'Not signed in' });
    return;
  }

  const endpoint = process.env.RENTLY_UNLOCK_ENDPOINT; // VCB Apps Script /exec URL
  const token = process.env.RENTLY_UNLOCK_TOKEN;       // VCB_RESIWALK_SHARED_SECRET
  if (!endpoint || !token) {
    res.status(200).json({ status: 'FAILED', errorClass: 'not_configured', error: 'Unlock service is not configured.' });
    return;
  }

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const { propertyId, address, inspectionId } = body as Record<string, string>;
  if (!propertyId && !address) {
    res.status(200).json({ status: 'FAILED', errorClass: 'bad_request', error: 'Missing property reference.' });
    return;
  }

  // Don't hang the inspector forever on a slow door call.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const upstream = await fetch(endpoint, {
      method: 'POST',
      // text/plain so the (preflight-incapable) Apps Script Web App isn't sent a
      // CORS preflight; it parses the JSON body itself.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        token,
        propertyId: propertyId || '',
        address: address || '',
        // The Rently access-log label is the signed-in ResiWalk inspector's name
        // (authoritative, from the session) — no vendor name/email is required of
        // the inspector. The endpoint pulls the lock details from the Property.
        inspectionName: session.name || 'ResiWalk Inspection',
        inspectionDate: '',
        inspectionId: inspectionId || '',
        userEmail: session.email,
        userPhone: '',
      }),
      signal: ctrl.signal,
    });
    const text = await upstream.text();
    let data: unknown;
    try { data = JSON.parse(text); }
    catch { data = { status: 'FAILED', errorClass: 'server_error', error: 'Bad response from code service.' }; }
    res.status(200).json(data);
  } catch (e: any) {
    const aborted = e?.name === 'AbortError';
    res.status(200).json({
      status: 'FAILED',
      errorClass: 'network_error',
      error: aborted ? 'The code service timed out. Try again.' : 'Could not reach the code service.',
    });
  } finally {
    clearTimeout(timer);
  }
}
