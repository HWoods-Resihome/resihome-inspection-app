// Server-only: make an mp4 "faststart" (moov atom at the FRONT) so iOS Safari
// will play it from a URL.
//
// WHY: the in-app camera records via WebKit MediaRecorder, which emits H.264 mp4
// with the moov atom at the END. Android/Chrome play that fine, but iOS Safari's
// <video> refuses to start such a file over HTTP — the "black frame + slashed
// play button" users hit on iPhone even after the range proxy + content-type
// fixes (those are delivery; this is file structure). ffmpeg `-c copy -movflags
// +faststart` relocates the moov to the front WITHOUT re-encoding, so it stays
// H.264 (still plays everywhere) and becomes iOS-playable.
//
// SAFE BY DESIGN: every failure path returns the ORIGINAL bytes unchanged, so a
// missing binary / odd input / timeout can never corrupt or drop an evidence
// clip — worst case it's left exactly as it is today.

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import ffmpegPath from 'ffmpeg-static';

/** True if the buffer looks like an ISO-BMFF (mp4/mov) file — 'ftyp' at offset 4. */
export function isMp4(buf: Buffer): boolean {
  return buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp';
}

/**
 * Cheap, read-only check: does this mp4 need faststart? Scans the top-level
 * atoms (no decoding, no rewriting) and reports whether 'moov' sits AFTER 'mdat'.
 * Returns false on anything unusual so we never transcode unnecessarily.
 */
export function needsFaststart(buf: Buffer): boolean {
  if (!isMp4(buf)) return false;
  let pos = 0;
  let moovPos = -1;
  let mdatPos = -1;
  while (pos + 8 <= buf.length) {
    let size = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > buf.length) break;
      const hi = buf.readUInt32BE(pos + 8);
      const lo = buf.readUInt32BE(pos + 12);
      size = hi * 2 ** 32 + lo;
      header = 16;
    } else if (size === 0) {
      size = buf.length - pos; // extends to EOF
    }
    if (size < header || pos + size > buf.length) break; // malformed → bail
    if (type === 'moov') moovPos = pos;
    else if (type === 'mdat') mdatPos = pos;
    if (moovPos >= 0 && mdatPos >= 0) break;
    pos += size;
  }
  return moovPos >= 0 && mdatPos >= 0 && moovPos > mdatPos;
}

/**
 * Remux an mp4 to faststart (moov at the front) via ffmpeg `-c copy` (no
 * re-encode → fast + lossless, stays H.264). Returns the rewritten buffer, or
 * the ORIGINAL buffer unchanged on any problem. Bounded by a timeout so a
 * pathological input can't hang the function.
 */
export async function faststartMp4(buf: Buffer, timeoutMs = 30000): Promise<Buffer> {
  if (!ffmpegPath || !isMp4(buf)) return buf;
  let dir: string | null = null;
  try {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'faststart-'));
    const inPath = path.join(dir, 'in.mp4');
    const outPath = path.join(dir, 'out.mp4');
    await fs.writeFile(inPath, buf);
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(
        ffmpegPath as string,
        ['-y', '-loglevel', 'error', '-i', inPath, '-c', 'copy', '-movflags', '+faststart', outPath],
        { stdio: 'ignore' },
      );
      const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* noop */ } reject(new Error('ffmpeg timeout')); }, timeoutMs);
      proc.on('error', (e) => { clearTimeout(timer); reject(e); });
      proc.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)); });
    });
    const out = await fs.readFile(outPath);
    // Sanity: a valid remux is non-empty and still an mp4. Otherwise keep original.
    return out.length > 0 && isMp4(out) ? out : buf;
  } catch {
    return buf; // never corrupt/drop — fall back to the original bytes
  } finally {
    if (dir) { try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* noop */ } }
  }
}

/** Convenience: faststart only when needed (skips already-faststart clips). */
export async function ensureFaststart(buf: Buffer): Promise<Buffer> {
  return needsFaststart(buf) ? faststartMp4(buf) : buf;
}
