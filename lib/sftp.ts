// Server-only SFTP upload for the Tenant Chargeback import file.
//
// Used by the Finalize flow (best-effort — never blocks finalize) and by the
// admin "re-send" button. Credentials come from env so nothing is hardcoded:
//   SFTP_HOST, SFTP_PORT (default 22), SFTP_USERNAME, SFTP_PASSWORD, SFTP_REMOTE_DIR
// If any of host/username/password is missing, the upload no-ops with
// configured:false so finalize keeps working before the env is set.

import SftpClient from 'ssh2-sftp-client';

export interface SftpUploadResult {
  ok: boolean;
  configured: boolean;
  remotePath?: string;
  error?: string;
}

interface SftpConfig {
  host: string;
  username: string;
  password: string;
  port: number;
  dir: string;
}

function readConfig(): SftpConfig | null {
  const host = (process.env.SFTP_HOST || '').trim();
  const username = (process.env.SFTP_USERNAME || '').trim();
  const password = process.env.SFTP_PASSWORD || '';
  const port = Number(process.env.SFTP_PORT || 22) || 22;
  const dir = (process.env.SFTP_REMOTE_DIR || '/').trim();
  if (!host || !username || !password) return null;
  return { host, username, password, port, dir };
}

/**
 * Upload a buffer to the configured SFTP folder, overwriting a same-named file.
 * Never throws — returns a result object the caller can surface (e.g. in the
 * finalize email) or report from the admin test button.
 *
 * If the target directory doesn't exist we try to create it (recursive mkdir)
 * before writing — many "Not Found" write errors are just a missing folder.
 */
export async function uploadToSftp(filename: string, buffer: Buffer): Promise<SftpUploadResult> {
  const cfg = readConfig();
  if (!cfg) {
    return { ok: false, configured: false, error: 'SFTP not configured (set SFTP_HOST / SFTP_USERNAME / SFTP_PASSWORD).' };
  }

  // Sanitize the filename to a single path segment (no traversal / slashes).
  const safeName = filename.replace(/[\\/]+/g, '-').trim() || `tenant-charge-import-${Date.now()}.xlsx`;
  const dir = cfg.dir.replace(/\/+$/, '') || '/';
  const remotePath = `${dir === '/' ? '' : dir}/${safeName}`;

  const sftp = new SftpClient();
  try {
    await sftp.connect({ host: cfg.host, port: cfg.port, username: cfg.username, password: cfg.password, readyTimeout: 20000 });

    // Make sure the destination folder exists. `exists` returns 'd' for a
    // directory, '' (falsy) when it's missing. If missing, try to create it
    // (recursive). A chroot/permissions problem will surface as the mkdir error.
    if (dir && dir !== '/') {
      const kind = await sftp.exists(dir);
      if (!kind) {
        try {
          await sftp.mkdir(dir, true);
        } catch (mkErr: any) {
          return {
            ok: false,
            configured: true,
            error: `Remote dir "${dir}" doesn't exist and couldn't be created: ${String(mkErr?.message || mkErr).slice(0, 160)}`,
          };
        }
      } else if (kind !== 'd') {
        return { ok: false, configured: true, error: `Remote path "${dir}" exists but is not a directory (type "${kind}").` };
      }
    }

    // `put` overwrites an existing file with the same name by default.
    await sftp.put(buffer, remotePath);
    return { ok: true, configured: true, remotePath };
  } catch (e: any) {
    return { ok: false, configured: true, error: String(e?.message || e).slice(0, 220) };
  } finally {
    try { await sftp.end(); } catch { /* ignore close errors */ }
  }
}
