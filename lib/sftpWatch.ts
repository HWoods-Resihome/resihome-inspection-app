// SFTP watch — background tracking of Tenant Chargeback imports.
//
// After finalize drops an xlsx to the SFTP, we enqueue a "watch": the cron
// (/api/cron/sftp-watch) then polls the SFTP's Errors + Processed folders for a
// few minutes (the importer runs every ~5 min). If a matching ERROR file shows
// up, the cron emails a reply to the original inspection email — stating the
// upload errored, with the error file(s) attached — and drops the watch. If the
// file lands in Processed (or the window expires with no error), the watch is
// silently dropped. Entirely background: no app/desktop alerts.
//
// Matching is by ADDRESS: the importer renames the file (e.g. our "Tenant
// Chargeback Import - <addr> - <date>.xlsx" becomes "Import_ <addr>_0_bad_*.csv")
// so the only stable shared token is the property address.

import { decryptToken } from '@/lib/gmailAuth';
import { sendReplyEmailWithToken } from '@/lib/gmail';
import { withSftpClient, listSftpDir, downloadSftpFile, type SftpEntry } from '@/lib/sftp';
import { readSftpWatchQueue, writeSftpWatchQueue, updateInspection } from '@/lib/hubspot';

// How long after a drop we keep checking. The importer runs every ~5 min, but
// some errors only surface after a full import attempt, so we watch for 20 min
// (the cron sweeps every minute) to comfortably cover multiple cycles.
export const WATCH_WINDOW_MS = 20 * 60 * 1000;
// Files modified before (dropTime - slack) can't be ours — ignore them so we
// never match a stale error file from a previous import of the same address.
const DROP_SLACK_MS = 90 * 1000;
// Hard safety TTL: prune watches this far past their window even if the SFTP is
// unreachable, so the queue can't grow unbounded.
const HARD_TTL_MS = 24 * 60 * 60 * 1000;

export interface SftpWatch {
  id: string;
  inspectionId: string;
  droppedFilename: string;
  addressKey: string;       // normalized address (matching key)
  droppedAt: number;        // epoch ms
  watchUntil: number;       // epoch ms
  reply: {
    to: string[];
    cc: string[];
    subject: string;        // ORIGINAL subject (we send "Re: …")
    messageId: string;      // RFC822 Message-ID of the original email
    threadId?: string;      // Gmail thread id
    fromEmail: string;      // the inspector (original sender)
  };
  encToken: string;         // AES-encrypted Gmail refresh token (sender's)
  attempts?: number;
  lastCheckedAt?: number;
}

/** Normalize a filename/address to a punctuation-free lowercase token string. */
export function normalizeForMatch(s: string): string {
  return String(s || '')
    .replace(/\.[a-z0-9]+$/i, '')      // drop a file extension
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')       // punctuation/underscores → spaces
    .replace(/\s+/g, ' ')
    .trim();
}

/** Does a (normalized) error filename belong to this watch's address? */
export function errorFileMatchesAddress(addressKeyNorm: string, errorFileName: string): boolean {
  const fileNorm = normalizeForMatch(errorFileName);
  if (!addressKeyNorm) return false;
  // Primary: the full normalized address appears in the filename.
  if (fileNorm.includes(addressKeyNorm)) return true;
  // Fallback: street number + 5-digit zip both present (covers state-name vs
  // abbreviation and other minor formatting differences in the importer name).
  const streetNum = addressKeyNorm.match(/^\d+/)?.[0];
  const zip = addressKeyNorm.match(/\b\d{5}\b/)?.[0];
  if (streetNum && zip) {
    return new RegExp(`(^|\\D)${streetNum}(\\D|$)`).test(fileNorm) && fileNorm.includes(zip);
  }
  return false;
}

/**
 * Record the SFTP import outcome on the inspection so it's visible in HubSpot
 * later. Best-effort: if the sftp_import_* properties don't exist yet, the watch
 * still works — this just no-ops with a warning.
 */
export async function recordSftpResult(
  inspectionId: string,
  result: 'pending' | 'processed' | 'errored' | 'no_error',
  detail = '',
): Promise<void> {
  try {
    await updateInspection(inspectionId, {
      sftp_import_result: result,
      sftp_import_detail: detail.slice(0, 250),
      sftp_import_checked_at: Date.now(), // HubSpot datetime → epoch ms
    });
  } catch (e) {
    console.warn('[sftp-watch] could not record result (run scripts/sftp_watch to create the sftp_import_* properties):', e);
  }
}

/** Add a watch to the queue (best-effort; never throws). */
export async function enqueueSftpWatch(watch: SftpWatch): Promise<void> {
  try {
    const queue = await readSftpWatchQueue<SftpWatch>();
    // Drop any prior watch for the same inspection (re-finalize) + stale ones.
    const now = Date.now();
    const cleaned = queue.filter(
      (w) => w.inspectionId !== watch.inspectionId && now - (w.droppedAt || 0) < HARD_TTL_MS,
    );
    cleaned.push(watch);
    await writeSftpWatchQueue(cleaned.slice(-200));
  } catch (e) {
    console.warn('[sftp-watch] enqueue failed:', e);
  }
}

function buildErrorEmail(watch: SftpWatch, errorNames: string[], threaded = true) {
  const base = watch.reply.subject || `Tenant Chargeback Import error`;
  const subject = threaded ? (/^re:/i.test(base) ? base : `Re: ${base}`) : base;
  // Escape SFTP-supplied file names before interpolating into the HTML body — the
  // importer names the error files, so a name with an HTML-special char would
  // otherwise inject/break markup (every other HTML body in the app escapes).
  const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const list = errorNames.map((n) => `• ${n}`).join('\n');
  const listHtml = errorNames.map((n) => `<li>${esc(n)}</li>`).join('');
  const textBody =
    `Heads up — the Tenant Chargeback Import for this inspection did NOT process successfully.\n\n` +
    `The file was dropped to the SFTP but the importer moved it to the Errors folder.\n\n` +
    `Dropped file: ${watch.droppedFilename}\n` +
    `Error file(s) attached:\n${list}\n\n` +
    `Please review the attached error file(s) and re-submit the corrected import.\n\n` +
    `— ResiWalk automated SFTP monitor`;
  const htmlBody =
    `<p>Heads up — the <strong>Tenant Chargeback Import</strong> for this inspection did <strong>not</strong> process successfully.</p>` +
    `<p>The file was dropped to the SFTP but the importer moved it to the <strong>Errors</strong> folder.</p>` +
    `<p><strong>Dropped file:</strong> ${esc(watch.droppedFilename)}<br/><strong>Error file(s) attached:</strong></p>` +
    `<ul>${listHtml}</ul>` +
    `<p>Please review the attached error file(s) and re-submit the corrected import.</p>` +
    `<p style="color:#888;font-size:12px">— ResiWalk automated SFTP monitor</p>`;
  return { subject, textBody, htmlBody };
}

export interface SweepResult {
  configured: boolean;
  checked: number;
  errored: number;
  processed: number;
  expired: number;
  remaining: number;
  notes: string[];
}

/**
 * One pass: check every pending watch against the SFTP Errors/Processed folders,
 * email on error, and prune resolved/expired watches. Safe to call frequently.
 */
export async function runSftpWatchSweep(): Promise<SweepResult> {
  const notes: string[] = [];
  let queue = await readSftpWatchQueue<SftpWatch>();
  const now = Date.now();

  // Defensive prune of anything way past its window (e.g. if SFTP was down).
  queue = queue.filter((w) => now - (w.droppedAt || 0) < HARD_TTL_MS);
  if (queue.length === 0) {
    return { configured: true, checked: 0, errored: 0, processed: 0, expired: 0, remaining: 0, notes };
  }

  const result = await withSftpClient(async (sftp, dirs) => {
    const [errorFiles, processedFiles] = await Promise.all([
      listSftpDir(sftp, dirs.errors),
      listSftpDir(sftp, dirs.processed),
    ]);

    const keep: SftpWatch[] = [];
    let errored = 0, processed = 0, expired = 0;

    for (const w of queue) {
      const addrNorm = normalizeForMatch(w.addressKey);
      const minTime = w.droppedAt - DROP_SLACK_MS;
      const isOurs = (e: SftpEntry) =>
        (e.modifyTime === 0 || e.modifyTime >= minTime) && errorFileMatchesAddress(addrNorm, e.name);

      const matchedErrors = errorFiles.filter(isOurs);
      if (matchedErrors.length > 0) {
        // Download each error file and reply to the original email with them.
        const attachments: Array<{ filename: string; content: Buffer; mimeType: string }> = [];
        for (const e of matchedErrors) {
          try {
            const buf = await downloadSftpFile(sftp, `${dirs.errors}/${e.name}`);
            attachments.push({ filename: e.name, content: buf, mimeType: 'text/csv' });
          } catch (err) {
            notes.push(`download failed: ${e.name} (${String((err as any)?.message || err).slice(0, 60)})`);
          }
        }
        const errNames = matchedErrors.map((e) => e.name);
        const token = w.encToken ? decryptToken(w.encToken) : '';
        // Recipients: the original thread's recipients, else whoever we banked
        // (submitter). Plus an optional ops inbox so an error is never missed.
        const opsCc = (process.env.SFTP_ERROR_NOTIFY || '').split(',').map((s) => s.trim()).filter(Boolean);
        const to = (w.reply.to && w.reply.to.length) ? w.reply.to : [];
        const cc = Array.from(new Set([...(w.reply.cc || []), ...opsCc]));
        const canEmail = !!token && (to.length > 0 || cc.length > 0);
        if (!canEmail) {
          // No way to email (no Gmail token, or nobody to send to) — STILL flag
          // it in HubSpot so the error is never lost, then drop the watch.
          errored++;
          const why = !token ? 'no Gmail token' : 'no recipient';
          notes.push(`${w.inspectionId}: error file(s) found but not emailed (${why}) — recorded in HubSpot`);
          await recordSftpResult(w.inspectionId, 'errored', `error file(s): ${errNames.join(', ')}; not emailed (${why})`);
          continue;
        }
        // Reply in the original thread when we have it; otherwise send a fresh
        // standalone notification (still attaches the error file).
        const threaded = !!(w.reply.messageId || w.reply.threadId);
        const { subject, textBody, htmlBody } = buildErrorEmail(w, errNames, threaded);
        const sent = await sendReplyEmailWithToken({
          refreshToken: token,
          fromEmail: w.reply.fromEmail,
          to,
          cc,
          subject, htmlBody, textBody,
          inReplyToMessageId: w.reply.messageId || undefined,
          threadId: w.reply.threadId,
          attachments,
        });
        if (sent.sent) {
          errored++;
          notes.push(`${w.inspectionId}: error ${threaded ? 'reply' : 'email'} sent (${matchedErrors.length} file(s))`);
          await recordSftpResult(w.inspectionId, 'errored', errNames.join(', '));
        } else {
          // Send failed — keep the watch (within window) to retry next sweep.
          notes.push(`${w.inspectionId}: reply send failed: ${sent.error || 'unknown'}`);
          if (now < w.watchUntil) { keep.push({ ...w, attempts: (w.attempts || 0) + 1, lastCheckedAt: now }); }
          else {
            errored++; // give up after the window, but still flag the error in HubSpot
            await recordSftpResult(w.inspectionId, 'errored', `error file(s): ${errNames.join(', ')}; reply send failed: ${sent.error || 'unknown'}`);
          }
        }
        continue;
      }

      // No error — did it land in Processed? Then we're done (success).
      if (processedFiles.some(isOurs)) {
        processed++;
        await recordSftpResult(w.inspectionId, 'processed', '');
        continue;
      }

      // Still nothing: keep watching until the window closes, then assume OK.
      if (now < w.watchUntil) keep.push({ ...w, lastCheckedAt: now });
      else {
        expired++;
        await recordSftpResult(w.inspectionId, 'no_error', 'no error file seen within the watch window');
      }
    }

    return { keep, errored, processed, expired, total: queue.length };
  });

  if (!result.ok) {
    // SFTP unreachable/unconfigured this pass — leave the queue as-is and retry.
    notes.push(`sftp unavailable: ${result.error}`);
    return { configured: result.configured, checked: queue.length, errored: 0, processed: 0, expired: 0, remaining: queue.length, notes };
  }

  await writeSftpWatchQueue(result.value.keep);
  return {
    configured: true,
    checked: result.value.total,
    errored: result.value.errored,
    processed: result.value.processed,
    expired: result.value.expired,
    remaining: result.value.keep.length,
    notes,
  };
}
