import { describe, it, expect } from 'vitest';
import { isNetworkError } from '@/lib/netError';

describe('isNetworkError', () => {
  it('matches the per-browser fetch network-failure messages', () => {
    expect(isNetworkError(new TypeError('Failed to fetch'))).toBe(true);        // Chrome/Blink
    expect(isNetworkError(new TypeError('Load failed'))).toBe(true);            // Safari/WebKit
    expect(isNetworkError(new Error('NetworkError when attempting to fetch resource'))).toBe(true); // Firefox
    expect(isNetworkError(new Error('The network connection was lost.'))).toBe(true); // iOS
    expect(isNetworkError(new Error('The Internet connection appears to be offline.'))).toBe(true);
  });

  it('matches aborts and timeouts (our fetchWithTimeout)', () => {
    const abort = new Error('The operation was aborted.'); abort.name = 'AbortError';
    expect(isNetworkError(abort)).toBe(true);
    expect(isNetworkError(new Error('Request timed out'))).toBe(true);
  });

  it('does NOT match genuine server/app errors that should be logged', () => {
    expect(isNetworkError(new Error('HTTP 500'))).toBe(false);
    expect(isNetworkError(new Error('HTTP 404'))).toBe(false);
    expect(isNetworkError(new Error('Inspection has no template type set'))).toBe(false);
    expect(isNetworkError(new Error('Could not load questions.'))).toBe(false);
  });

  it('is null/empty safe', () => {
    expect(isNetworkError(null)).toBe(false);
    expect(isNetworkError(undefined)).toBe(false);
    expect(isNetworkError(new Error(''))).toBe(false);
  });
});
