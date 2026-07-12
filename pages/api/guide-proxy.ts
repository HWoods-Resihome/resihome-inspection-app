/**
 * GET /api/guide-proxy?url=… — same-origin proxy for the ResiWALK training guide.
 *
 * resihome.com sends X-Frame-Options / CSP frame-ancestors, so it can't be
 * iframed directly. This fetches the guide HTML server-side and re-serves it
 * from OUR origin (which the app can frame): it injects a <base> so the guide's
 * own CSS/JS/images/fonts still load from resihome.com, and rewrites same-site
 * links to route back through this proxy so in-guide navigation stays in-app.
 *
 * Locked to resihome.com only (no open proxy / SSRF).
 */
import type { NextApiRequest, NextApiResponse } from 'next';

const GUIDE_URL = 'https://www.resihome.com/resiwalkguide';
const ALLOWED = /^https?:\/\/(www\.)?resihome\.com(\/|$)/i;

export const config = { maxDuration: 30 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const raw = typeof req.query.url === 'string' ? req.query.url : '';
  const target = raw && ALLOWED.test(raw) ? raw : GUIDE_URL;

  // This app's own origin, so rewritten links are absolute to us (the injected
  // <base> only affects the guide's relative asset URLs, not these).
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const self = `${proto}://${req.headers.host}`;

  try {
    const upstream = await fetch(target, {
      headers: { 'User-Agent': String(req.headers['user-agent'] || 'Mozilla/5.0'), 'Accept': 'text/html,*/*' },
      redirect: 'follow',
    });
    const ct = upstream.headers.get('content-type') || '';
    if (!ct.includes('text/html')) { res.redirect(target); return; }

    let html = await upstream.text();
    const origin = new URL(target).origin;

    // Strip any page-level CSP/X-Frame meta that could re-impose framing limits.
    html = html.replace(/<meta[^>]+http-equiv=["'](?:content-security-policy|x-frame-options)["'][^>]*>/gi, '');

    // <base> so the guide's relative + root-relative assets resolve to resihome.
    const baseTag = `<base href="${origin}/">`;
    html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + baseTag) : baseTag + html;

    // Route same-site anchor links back through this proxy (absolute to us so the
    // <base> doesn't rewrite them to resihome.com).
    html = html.replace(/\bhref=(["'])(\/[^"'/][^"']*|https?:\/\/(?:www\.)?resihome\.com\/[^"']*)\1/gi, (_m, q, href) => {
      const abs = href.startsWith('http') ? href : origin + href;
      return `href=${q}${self}/api/guide-proxy?url=${encodeURIComponent(abs)}${q}`;
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.status(200).send(html);
  } catch (e: any) {
    res.status(502).send(`<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:24px;color:#374151">Couldn’t load the training guide right now. <a href="${GUIDE_URL}" target="_blank" rel="noopener">Open it in your browser</a>.</body>`);
  }
}
