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
        // Rently's unlock API requires a phone on every code; the inspector
        // isn't asked for one, so send a placeholder. The code is still labeled
        // (and auditable) by the inspector's name + email above.
        userPhone: '5555555555',
      }),
      signal: ctrl.signal,
    });
    const httpStatus = upstream.status;
    const text = await upstream.text();

    // Try to parse the endpoint's JSON envelope.
    let data: any = null;
    try { data = JSON.parse(text); } catch { /* not JSON — handled below */ }

    // A well-formed envelope (SUCCESS / STUB / or the endpoint's OWN typed
    // FAILED) — relay it verbatim so the real errorClass + message reach the app.
    if (data && typeof data === 'object' && typeof data.status === 'string') {
      if (data.status === 'FAILED') {
        console.error('[rently/unlock] endpoint FAILED', {
          errorClass: data.errorClass, error: data.error, httpStatus,
        });
      }
      res.status(200).json(data);
      return;
    }

    // Non-JSON (or unexpected shape). This is almost always a DEPLOYMENT problem:
    // the Apps Script Web App isn't deployed with access "Anyone", so Google
    // served an HTML sign-in/redirect page instead of our JSON — or the env URL
    // points at the wrong deployment. Surface a precise, actionable diagnostic.
    const snippet = (text || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    const looksLikeGoogleLogin = /sign in|accounts\.google\.com|<!doctype html|<html/i.test(snippet);
    // An XML / TwiML <Response/> means the /exec URL is answering with a
    // DIFFERENT web app entry point (e.g. a Twilio-webhook doPost) — i.e. the
    // Apps Script project has more than one doPost and ours isn't the one that
    // ran. Only one doPost can exist per project; the Unlock handler must be
    // dispatched from that single doPost.
    const looksLikeXml = /^<\?xml|<Response\b|<Response\/>/i.test(snippet);
    console.error('[rently/unlock] non-JSON upstream', { httpStatus, snippet });
    res.status(200).json({
      status: 'FAILED',
      errorClass: 'server_error',
      error: looksLikeGoogleLogin
        ? `Code service returned a sign-in page (HTTP ${httpStatus}), not a code. ` +
          `Re-deploy the VCB Web App with “Who has access: Anyone”, and confirm ` +
          `RENTLY_UNLOCK_ENDPOINT is that deployment’s /exec URL.`
        : looksLikeXml
        ? `The code service URL is answering with a different web app (an XML/TwiML ` +
          `response), not the Unlock endpoint. The VCB Apps Script project has a ` +
          `second doPost (the Twilio webhook) that's overriding the Unlock one — ` +
          `dispatch the Unlock handler from the single project doPost.`
        : `Code service returned an unexpected response (HTTP ${httpStatus}): ` +
          `${snippet || '(empty body)'}`,
    });
  } catch (e: any) {
    const aborted = e?.name === 'AbortError';
    console.error('[rently/unlock] fetch error', { name: e?.name, message: e?.message });
    res.status(200).json({
      status: 'FAILED',
      errorClass: 'network_error',
      error: aborted ? 'The code service timed out. Try again.' : 'Could not reach the code service.',
    });
  } finally {
    clearTimeout(timer);
  }
}
