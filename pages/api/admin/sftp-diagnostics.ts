/**
 * GET /api/admin/sftp-diagnostics
 *
 * Read-only forensic view of the Tenant Chargeback SFTP → "error reply" pipeline,
 * for diagnosing "the import errored but I never got the follow-up email."
 *
 * It surfaces EVERY gate the follow-up email must pass, in one fetch:
 *   1. config        — is the cron actually enabled (CRON_SECRET), is SFTP
 *                      configured, is an ops fallback inbox set (SFTP_ERROR_NOTIFY)?
 *   2. sftp          — can we connect, and what's currently in the Errors /
 *                      Processed folders (names + modify times)?
 *   3. watchQueue    — the live watch queue: each pending watch's address, window,
 *                      recipients, and whether it carries a Gmail token to send with.
 *   4. match (opt)   — pass ?address=<street/zip> to test the matcher against the
 *                      files currently in the Errors folder.
 *
 * Changes nothing. Admin-gated (@resihome.com).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getSessionFromRequest } from '@/lib/auth';
import { readSftpWatchQueue } from '@/lib/hubspot';
import { withSftpClient, listSftpDir, type SftpEntry } from '@/lib/sftp';
import { normalizeForMatch, errorFileMatchesAddress, WATCH_WINDOW_MS, type SftpWatch } from '@/lib/sftpWatch';

export const config = { maxDuration: 60 };

const ms = (n: number) => {
  if (!n) return null;
  const d = new Date(n);
  return isNaN(d.getTime()) ? null : d.toISOString();
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const session = await getSessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  if (!/@resihome\.com$/i.test(session.email)) return res.status(403).json({ error: 'Admin only.' });

  const now = Date.now();
  const address = typeof req.query.address === 'string' ? req.query.address : '';

  // 1. Config gates.
  const cfg = {
    cronEnabled: !!process.env.CRON_SECRET,
    cronNote: process.env.CRON_SECRET
      ? 'CRON_SECRET set — the sweep runs each minute.'
      : 'CRON_SECRET NOT set — /api/cron/sftp-watch is a silent no-op, so NO follow-up emails ever send. This is the most common cause.',
    sftpConfigured: !!(process.env.SFTP_HOST && process.env.SFTP_USERNAME && process.env.SFTP_PASSWORD),
    opsNotifyInbox: (process.env.SFTP_ERROR_NOTIFY || '').split(',').map((s) => s.trim()).filter(Boolean),
    errorsDir: process.env.SFTP_ERRORS_DIR || '(derived: <drop>/Errors)',
    processedDir: process.env.SFTP_PROCESSED_DIR || '(derived: <drop>/Processed)',
    watchWindowMinutes: WATCH_WINDOW_MS / 60000,
  };

  // 2. Live SFTP folder contents.
  let sftp: any = { configured: cfg.sftpConfigured, reachable: false };
  const sortByTime = (a: SftpEntry, b: SftpEntry) => b.modifyTime - a.modifyTime;
  const result = await withSftpClient(async (client, dirs) => {
    const [errors, processed] = await Promise.all([
      listSftpDir(client, dirs.errors),
      listSftpDir(client, dirs.processed),
    ]);
    return { dirs, errors: errors.sort(sortByTime), processed: processed.sort(sortByTime) };
  });
  if (result.ok) {
    const fmt = (e: SftpEntry) => ({ name: e.name, modified: ms(e.modifyTime), ageMin: e.modifyTime ? Math.round((now - e.modifyTime) / 60000) : null, size: e.size });
    sftp = {
      configured: true,
      reachable: true,
      dirs: result.value.dirs,
      errors: result.value.errors.map(fmt),
      processed: result.value.processed.slice(0, 25).map(fmt),
    };
  } else {
    sftp = { configured: result.configured, reachable: false, error: result.error };
  }

  // 3. The live watch queue.
  let watchQueue: any[] = [];
  try {
    const q = await readSftpWatchQueue<SftpWatch>();
    watchQueue = q.map((w) => ({
      inspectionId: w.inspectionId,
      droppedFilename: w.droppedFilename,
      addressKey: w.addressKey,
      droppedAt: ms(w.droppedAt),
      watchUntil: ms(w.watchUntil),
      windowOpen: now < w.watchUntil,
      hasGmailToken: !!w.encToken,
      recipients: { to: w.reply?.to || [], cc: w.reply?.cc || [] },
      threaded: !!(w.reply?.messageId || w.reply?.threadId),
      attempts: w.attempts || 0,
      lastCheckedAt: ms(w.lastCheckedAt || 0),
    }));
  } catch (e: any) {
    watchQueue = [{ error: String(e?.message || e).slice(0, 160) }];
  }

  // 4. Optional: test the address matcher against the live Errors files.
  let matchTest: any = undefined;
  if (address && sftp.reachable) {
    const addrNorm = normalizeForMatch(address);
    matchTest = {
      address,
      normalized: addrNorm,
      errorFiles: (sftp.errors as any[]).map((e) => ({ name: e.name, matches: errorFileMatchesAddress(addrNorm, e.name) })),
    };
  }

  return res.status(200).json({
    ok: true,
    now: ms(now),
    summary: 'Read-only. Walk the gates top-to-bottom: cronEnabled → sftp.reachable → an Errors file matching your address → a watch in watchQueue with hasGmailToken=true and recipients.',
    config: cfg,
    sftp,
    watchQueue,
    matchTest,
  });
}
