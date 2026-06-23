/**
 * lib/trainingGuide.ts — the "ResiWalk Training Guide" HubSpot Files connector.
 *
 * Source of truth is the HTML committed in the repo at content/training/. When a
 * new revision is pushed (Vercel redeploys), this syncs it INTO the existing
 * HubSpot file (Home ▸ Resiwalk ▸ ResiWalk_Training_Guide), replacing the content
 * in place so the URL never changes. A sha256 marker (Vercel Blob) means the
 * cron only pushes when the content actually changed.
 *
 * Trigger phrases ("UPDATE RESIWALK TRAINING GUIDE", etc.) → recompile the HTML →
 * overwrite content/training/ResiWalk_Training_Guide.html → commit + push. The
 * Vercel cron (or the admin deploy endpoint) does the HubSpot replace from there.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { put, list } from '@vercel/blob';
import { replaceHubspotFileById } from '@/lib/hubspot';

// The committed source HTML (force-included into the sync routes' bundles via
// next.config outputFileTracingIncludes).
export const TRAINING_GUIDE_PATH = path.join(process.cwd(), 'content/training/ResiWalk_Training_Guide.html');
// The HubSpot File to replace (Home ▸ Resiwalk ▸ ResiWalk_Training_Guide).
const FILE_ID = (process.env.HUBSPOT_TRAINING_GUIDE_FILE_ID || '215277624106').trim();
// Blob marker tracking the last content hash pushed to HubSpot.
const MARKER_PATH = 'training/guide-sync.json';

interface SyncMarker { sha: string; at: string; fileId: string; url: string }

export function readTrainingGuideHtml(): Buffer {
  return fs.readFileSync(TRAINING_GUIDE_PATH);
}

async function readMarker(): Promise<SyncMarker | null> {
  try {
    const { blobs } = await list({ prefix: MARKER_PATH, limit: 1 });
    const b = blobs.find((x) => x.pathname === MARKER_PATH) || blobs[0];
    if (!b) return null;
    const r = await fetch(b.url + `?t=${Date.now()}`, { cache: 'no-store' });
    return r.ok ? ((await r.json()) as SyncMarker) : null;
  } catch { return null; }
}

async function writeMarker(m: SyncMarker): Promise<void> {
  await put(MARKER_PATH, JSON.stringify(m), {
    access: 'public', contentType: 'application/json', allowOverwrite: true, addRandomSuffix: false,
  });
}

export interface SyncResult { synced: boolean; reason: string; sha?: string; url?: string; fileId?: string; error?: string }

/**
 * Push the committed training-guide HTML into the HubSpot file when it changed
 * (or always, when force). Returns a structured result for logging.
 */
export async function syncTrainingGuideToHubspot(opts?: { force?: boolean }): Promise<SyncResult> {
  let buf: Buffer;
  try { buf = readTrainingGuideHtml(); }
  catch (e: any) { return { synced: false, reason: 'read-failed', error: String(e?.message || e).slice(0, 200) }; }

  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const marker = await readMarker();
  if (!opts?.force && marker?.sha === sha) {
    return { synced: false, reason: 'unchanged', sha, fileId: FILE_ID, url: marker?.url };
  }

  const res = await replaceHubspotFileById(FILE_ID, buf, 'text/html');
  if (!res.ok) return { synced: false, reason: 'replace-failed', sha, fileId: FILE_ID, error: res.error };

  await writeMarker({ sha, at: new Date().toISOString(), fileId: res.id || FILE_ID, url: res.url || '' }).catch(() => {});
  return { synced: true, reason: opts?.force ? 'forced' : 'changed', sha, fileId: res.id || FILE_ID, url: res.url };
}
