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
