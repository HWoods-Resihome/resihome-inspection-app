/**
 * Shared loader for /api/insights/kb-changes so the KB feed card and the KB
 * velocity card draw from ONE network read (the endpoint reads the whole KB from
 * HubSpot — not something to fetch twice). The in-flight promise is memoised at
 * module scope; both cards mount the hook and share the same result. cache:
 * 'no-store' on the request keeps it fresh per full page load.
 */
import { useEffect, useState } from 'react';

export interface KbEntry {
  id: string;
  text: string;
  kind: 'rule' | 'example';
  source: 'inspector' | 'admin' | 'auto';
  expected: string | null;
  addedByName: string | null;
  createdAt: number;
  updatedAt: number | null;
  samples: number | null;
  accepts: number | null;
  rejects: number | null;
  code: string | null;
}
export interface KbCounts { total: number; auto: number; examples: number; }
export interface KbChangesData { entries: KbEntry[]; counts: KbCounts | null; }

let _promise: Promise<KbChangesData> | null = null;
function load(): Promise<KbChangesData> {
  if (!_promise) {
    _promise = fetch('/api/insights/kb-changes', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        if (d?.error) throw new Error(d.error);
        return { entries: (d.entries || []) as KbEntry[], counts: (d.counts || null) as KbCounts | null };
      })
      .catch((e) => { _promise = null; throw e; }); // let a later mount retry
  }
  return _promise;
}

export interface UseKbChanges { data: KbChangesData | null; error: string | null; }

export function useKbChanges(): UseKbChanges {
  const [data, setData] = useState<KbChangesData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    load()
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(String(e?.message || e)); });
    return () => { cancelled = true; };
  }, []);
  return { data, error };
}
