/**
 * Device storage quota — field inspectors capture lots of photos/video that sit
 * in IndexedDB until they sync. If the device runs out of space, queued saves
 * silently fail and work is lost. This module lets the UI (a) proactively warn
 * before the wall is hit and (b) surface a clear error if a write does fail.
 */

import { useEffect, useState } from 'react';

export type StorageStatus = {
  supported: boolean;
  usageBytes: number;
  quotaBytes: number;
  pct: number;       // 0..1 of quota used
  nearFull: boolean; // >= 80%
  critical: boolean; // >= 95%
};

const NEAR = 0.8;
const CRIT = 0.95;

const EMPTY: StorageStatus = {
  supported: false, usageBytes: 0, quotaBytes: 0, pct: 0, nearFull: false, critical: false,
};

/** Snapshot current storage usage via the Storage API (best-effort). */
export async function estimateStorage(): Promise<StorageStatus> {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return EMPTY;
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    const pct = quota > 0 ? usage / quota : 0;
    return {
      supported: true,
      usageBytes: usage,
      quotaBytes: quota,
      pct,
      nearFull: pct >= NEAR,
      critical: pct >= CRIT,
    };
  } catch {
    return EMPTY;
  }
}

/** Thrown when a local write fails because the device is out of storage. */
export class StorageFullError extends Error {
  constructor() {
    super('This device is out of storage, so the photo couldn’t be saved offline. Free up space (or reconnect to upload) and try again.');
    this.name = 'StorageFullError';
  }
}

/** Is a thrown error an IndexedDB/localStorage quota-exceeded failure? */
export function isQuotaError(err: any): boolean {
  if (!err) return false;
  const name = String(err?.name || '');
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
  // Some engines surface a numeric code (22 / 1014) instead of the name.
  if (err?.code === 22 || err?.code === 1014) return true;
  return /quota|storage.*full|exceeded the quota/i.test(String(err?.message || ''));
}

export function formatMB(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/**
 * React hook: polls storage usage so a banner can warn the inspector before
 * they run out of room. Re-checks on mount, on a timer, and when the tab
 * becomes visible again (after a capture session in the background).
 */
export function useStorageQuota(pollMs = 30000): StorageStatus {
  const [status, setStatus] = useState<StorageStatus>(EMPTY);
  useEffect(() => {
    let alive = true;
    const check = () => { void estimateStorage().then((s) => { if (alive) setStatus(s); }); };
    check();
    const timer = setInterval(check, pollMs);
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [pollMs]);
  return status;
}
