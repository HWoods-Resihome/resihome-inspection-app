// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { render, waitFor, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { PhotoThumb } from '@/components/PhotoThumb';

// jsdom never actually loads images, so simulate a browser-cached image: complete
// with a real intrinsic size. This is exactly the state that fires `load` before
// React attaches onLoad (the bug that left tiles stuck grey on review screens).
function mockCachedImages(cached: boolean) {
  Object.defineProperty(window.HTMLImageElement.prototype, 'complete', {
    configurable: true, get() { return cached; },
  });
  Object.defineProperty(window.HTMLImageElement.prototype, 'naturalWidth', {
    configurable: true, get() { return cached ? 100 : 0; },
  });
}

const REMOTE = 'https://resihome.com/hubfs/inspection_photos/x.jpg';
const getImg = (c: HTMLElement) => c.querySelector('img') as HTMLImageElement | null;

beforeAll(() => {
  // jsdom lacks IntersectionObserver; PhotoThumb treats that as "in view" so tiles
  // still load — assert that fallback holds (no IO polyfill needed).
  expect(typeof (globalThis as any).IntersectionObserver).toBe('undefined');
});

afterEach(() => { cleanup(); });

describe('PhotoThumb cached-image handling', () => {
  it('shows a CACHED image even when onLoad never fires (the grey-tile bug)', async () => {
    mockCachedImages(true);
    const { container } = render(<PhotoThumb url={REMOTE} />);
    // The gate + inView are async; wait for the <img> to mount, then for the
    // complete-check effect to reveal it (opacity 1) WITHOUT any load event.
    await waitFor(() => expect(getImg(container)).not.toBeNull());
    await waitFor(() => expect(getImg(container)!.style.opacity).toBe('1'));
  });

  it('shows an image via onLoad when it is NOT already cached', async () => {
    mockCachedImages(false);
    const { container } = render(<PhotoThumb url={REMOTE} />);
    await waitFor(() => expect(getImg(container)).not.toBeNull());
    const img = getImg(container)!;
    expect(img.style.opacity).toBe('0');        // hidden until it loads
    fireEvent.load(img);
    await waitFor(() => expect(getImg(container)!.style.opacity).toBe('1'));
  });

  it('renders a local blob: draft directly (ungated, no proxy)', async () => {
    mockCachedImages(true);
    const { container } = render(<PhotoThumb url="blob:abc-123" />);
    await waitFor(() => expect(getImg(container)).not.toBeNull());
    expect(getImg(container)!.getAttribute('src')).toBe('blob:abc-123');
  });
});
