/**
 * Video clips ride the SAME persisted `photo_urls` list as photos — there is no
 * separate HubSpot property for video (adding one would 400 the answer batch;
 * see lib/answerProps.ts). A clip is stored as a single list entry encoding both
 * its poster image and the video file:
 *
 *     <posterUrl>#v=<encodeURIComponent(videoUrl)>
 *
 * WHY A URL FRAGMENT: the `#…` part is stripped by browsers (and `fetch`) before
 * the HTTP request, so any render site that hasn't been taught about video still
 * loads the POSTER image cleanly — no broken thumbnails anywhere. Sites that DO
 * know about video parse the fragment to add a ▶ play affordance and link to the
 * actual video file. The poster is a normal .jpg, so the existing read/split
 * logic (semicolon/comma delimited) and HEIC checks are unaffected.
 */

import { brandedFileUrl } from '@/lib/photoDisplay';

const VIDEO_MARKER = '#v=';

/** Build a single photo_urls entry that carries both poster and video. */
export function makeVideoEntry(posterUrl: string, videoUrl: string): string {
  return `${posterUrl}${VIDEO_MARKER}${encodeURIComponent(videoUrl)}`;
}

/** True if a photo_urls entry is an encoded video clip (vs a plain image). */
export function isVideoEntry(entry: string | null | undefined): boolean {
  return !!entry && entry.includes(VIDEO_MARKER);
}

/** The poster/still image URL for an entry (the entry itself if it's a plain image). */
export function getPosterUrl(entry: string): string {
  if (!entry) return entry;
  const i = entry.indexOf(VIDEO_MARKER);
  return i === -1 ? entry : entry.slice(0, i);
}

/** The playable video URL for an encoded entry, or '' for a plain image. */
export function getVideoUrl(entry: string): string {
  if (!entry) return '';
  const i = entry.indexOf(VIDEO_MARKER);
  if (i === -1) return '';
  try {
    return decodeURIComponent(entry.slice(i + VIDEO_MARKER.length));
  } catch {
    return entry.slice(i + VIDEO_MARKER.length);
  }
}

// HubSpot file hosts (region/CDN/TLD variants) — clips stored on HubSpot Files.
// resihome.com / resiwalk.com = HubSpot's file CDN served via the connected
// custom domain (this portal's uploads resolve there). MUST be included or
// playableVideoSrc serves those clips DIRECT — bypassing /api/video-proxy's
// faststart + content-type fix — and iOS won't play them.
const HUBSPOT_HOST_RE = /(^|\.)(hubspot[a-z0-9-]*\.(net|com)|hubfs\.com|hs-sites\.com|hubapi\.com|resihome\.com|resiwalk\.com)$/i;

/**
 * The <video> src to actually render. iOS Safari only plays a source whose
 * server returns a real video/* Content-Type AND honors HTTP Range (206) —
 * HubSpot's File Manager CDN doesn't reliably do either, so HubSpot-hosted clips
 * (which played on Android but showed a black frame + dead play button on
 * iPhones) are routed through /api/video-proxy, which forces the right type and
 * implements Range. blob: URLs (offline, pre-upload) and Vercel Blob URLs
 * (larger clips — Blob supports Range natively) are returned as-is.
 */
export function playableVideoSrc(entry: string): string {
  const url = getVideoUrl(entry) || entry;
  if (!url || url.startsWith('blob:') || url.startsWith('data:')) return url;
  try {
    const host = new URL(url).hostname;
    if (HUBSPOT_HOST_RE.test(host)) return `/api/video-proxy?url=${encodeURIComponent(url)}`;
  } catch { /* not an absolute URL — return as-is */ }
  // Vercel Blob clips play direct (Blob honors Range) — but rebrand to our /m/*
  // domain so the raw blob host never shows. brandedFileUrl no-ops when unconfigured
  // or for non-blob URLs, preserving the Range-native direct behavior.
  return brandedFileUrl(url);
}
