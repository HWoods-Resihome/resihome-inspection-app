import { describe, it, expect } from 'vitest';
import { decideBackAction } from '@/lib/nativeBridge';

describe('decideBackAction — Android back gesture', () => {
  it('closes an open overlay first, whatever the page', () => {
    expect(decideBackAction({ pathname: '/', overlayOpen: true, canGoBack: true })).toBe('overlay');
    expect(decideBackAction({ pathname: '/inspection/123', overlayOpen: true, canGoBack: true })).toBe('overlay');
  });

  it('leaves the app from the home/root screen', () => {
    expect(decideBackAction({ pathname: '/', overlayOpen: false, canGoBack: true })).toBe('minimize');
    expect(decideBackAction({ pathname: '/', overlayOpen: false, canGoBack: false })).toBe('minimize');
  });

  it('does a history back from inside an inspection (clean history → lands home)', () => {
    expect(decideBackAction({ pathname: '/inspection/123', overlayOpen: false, canGoBack: true })).toBe('back');
    expect(decideBackAction({ pathname: '/inspection/new', overlayOpen: false, canGoBack: true })).toBe('back');
  });

  it('does ordinary history back on other routes (minimize when nothing left)', () => {
    expect(decideBackAction({ pathname: '/insights', overlayOpen: false, canGoBack: true })).toBe('back');
    expect(decideBackAction({ pathname: '/inspection/abc', overlayOpen: false, canGoBack: false })).toBe('minimize');
    expect(decideBackAction({ pathname: '/admin/forms', overlayOpen: false, canGoBack: false })).toBe('minimize');
  });
});
