import { describe, it, expect, vi, afterEach } from 'vitest';
import { postJsonWithRetry, OfflineError } from '@/lib/net/resilientPost';

const json = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
// Backoff 0 so tests don't actually wait between retries.
const noWait = { backoffMs: () => 0 };

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('postJsonWithRetry', () => {
  it('returns the response on a first-try success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ ok: true }, 200));
    vi.stubGlobal('fetch', fetchMock);
    const r = await postJsonWithRetry('/x', { a: 1 }, noWait);
    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a 5xx then succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ error: 'boom' }, 500))
      .mockResolvedValueOnce(json({ ok: true }, 200));
    vi.stubGlobal('fetch', fetchMock);
    const r = await postJsonWithRetry('/x', {}, noWait);
    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a network error then succeeds (device online)', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json({ ok: true }, 200));
    vi.stubGlobal('fetch', fetchMock);
    const r = await postJsonWithRetry('/x', {}, noWait);
    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats a 409 alreadyCompleted as a terminal success — no extra retries', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ alreadyCompleted: true }, 409));
    vi.stubGlobal('fetch', fetchMock);
    const r = await postJsonWithRetry('/x', {}, { ...noWait, retry409: true, tries: 3 });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ alreadyCompleted: true });
    expect(fetchMock).toHaveBeenCalledTimes(1); // never retried the success signal
  });

  it('retries a 409 in-progress lock (no alreadyCompleted) when retry409 is set', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ error: 'in progress' }, 409))
      .mockResolvedValueOnce(json({ ok: true }, 200));
    vi.stubGlobal('fetch', fetchMock);
    const r = await postJsonWithRetry('/x', {}, { ...noWait, retry409: true });
    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a 4xx validation error — returns it for the caller', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ error: 'bad' }, 400));
    vi.stubGlobal('fetch', fetchMock);
    const r = await postJsonWithRetry('/x', {}, noWait);
    expect(r.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws OfflineError immediately when the device is offline', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(postJsonWithRetry('/x', {}, noWait)).rejects.toBeInstanceOf(OfflineError);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no pointless retries while offline
  });

  it('returns the last response after exhausting retries on persistent 5xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ error: 'down' }, 503));
    vi.stubGlobal('fetch', fetchMock);
    const r = await postJsonWithRetry('/x', {}, { ...noWait, tries: 3 });
    expect(r.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
