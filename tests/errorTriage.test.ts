import { describe, it, expect } from 'vitest';
import { normalizeMessage, triageErrorEvents } from '@/lib/errorTriage';
import type { ErrorEvent } from '@/lib/errorLog';

const ev = (o: Partial<ErrorEvent>): ErrorEvent => ({ ts: o.ts || '2026-07-01T00:00:00.000Z', kind: o.kind || 'server', message: o.message || 'x', ...o } as ErrorEvent);

describe('normalizeMessage', () => {
  it('masks ids, numbers, uuids, and urls so the same bug collapses', () => {
    const a = normalizeMessage("Cannot read 'x' of undefined (id 12345)");
    const b = normalizeMessage("Cannot read 'x' of undefined (id 98765)");
    expect(a).toBe(b);
    expect(normalizeMessage('fetch https://a.com/b/c 500')).toBe(normalizeMessage('fetch https://z.io/q 500'));
  });
});

describe('triageErrorEvents', () => {
  it('groups by kind + normalized message and counts / ranks them', () => {
    const events: ErrorEvent[] = [
      ev({ message: "Cannot read 'x' of undefined (id 1)", email: 'a@x.com' }),
      ev({ message: "Cannot read 'x' of undefined (id 2)", email: 'b@x.com' }),
      ev({ message: "Cannot read 'x' of undefined (id 3)", email: 'a@x.com' }),
      ev({ kind: 'login', message: 'OAuth mismatch', email: 'c@x.com' }),
    ];
    const r = triageErrorEvents(events, { topN: 10 });
    expect(r.distinct).toBe(2);
    const top = r.groups[0];
    expect(top.kind).toBe('server');
    expect(top.count).toBe(3);
    expect(top.users).toBe(2);   // a@ + b@ distinct
  });

  it('ranks a still-active issue above a larger but stale one', () => {
    const recent = new Date().toISOString();
    const old = '2020-01-01T00:00:00.000Z';
    const events: ErrorEvent[] = [
      ...Array.from({ length: 5 }, () => ev({ kind: 'sync', message: 'stale bug', ts: old })),
      ...Array.from({ length: 2 }, () => ev({ kind: 'server', message: 'live bug', ts: recent })),
    ];
    const r = triageErrorEvents(events);
    expect(r.groups[0].message).toBe('live bug'); // recentCount wins over raw count
  });
});
