import { describe, it, expect } from 'vitest';
import { rebrandUrl, rebrandEntry, rebrandDelimitedList, rebrandJsonBlob, hasBlobUrl } from '@/lib/rebrandUrls';

const ORIGIN = 'https://resiwalk.com';
const BLOB = 'https://7imh0yfpshxqifte.public.blob.vercel-storage.com/photos/proof_carol7-20.pdf';
const BRANDED = 'https://resiwalk.com/m/photos/proof_carol7-20.pdf';

describe('rebrandUrl', () => {
  it('rewrites a raw blob URL to the branded /m path', () => {
    expect(rebrandUrl(BLOB, ORIGIN)).toBe(BRANDED);
  });
  it('preserves query/fragment', () => {
    expect(rebrandUrl(BLOB + '?x=1', ORIGIN)).toBe(BRANDED + '?x=1');
  });
  it('leaves non-blob URLs untouched (HubSpot / short links / app URLs)', () => {
    for (const u of ['https://x.hubspotusercontent-na1.net/a.jpg', 'https://resiwalk.com/d/123/photos/sig', 'https://resiwalk.com/inspection/9', '']) {
      expect(rebrandUrl(u, ORIGIN)).toBe(u);
    }
  });
  it('is idempotent — a branded URL is not re-rewritten', () => {
    expect(rebrandUrl(BRANDED, ORIGIN)).toBe(BRANDED);
  });
  it('trims a trailing slash on origin', () => {
    expect(rebrandUrl(BLOB, 'https://resiwalk.com/')).toBe(BRANDED);
  });
});

describe('rebrandEntry (video #v= form)', () => {
  it('rebrands both poster and embedded video URL', () => {
    const poster = 'https://7imh0yfpshxqifte.public.blob.vercel-storage.com/photos/p.jpg';
    const video = 'https://7imh0yfpshxqifte.public.blob.vercel-storage.com/photos/v.mp4';
    const entry = `${poster}#v=${encodeURIComponent(video)}`;
    const out = rebrandEntry(entry, ORIGIN);
    expect(out).toBe(`https://resiwalk.com/m/photos/p.jpg#v=${encodeURIComponent('https://resiwalk.com/m/photos/v.mp4')}`);
  });
});

describe('rebrandDelimitedList', () => {
  it('rewrites a newline list (services) and re-joins with newline', () => {
    const v = `${BLOB}\nhttps://7imh0yfpshxqifte.public.blob.vercel-storage.com/photos/b.jpg`;
    const r = rebrandDelimitedList(v, '\n', ORIGIN);
    expect(r.changed).toBe(true);
    expect(r.value).toBe(`${BRANDED}\nhttps://resiwalk.com/m/photos/b.jpg`);
  });
  it('rewrites a semicolon list (answers) and re-joins with semicolon', () => {
    const v = `${BLOB};https://7imh0yfpshxqifte.public.blob.vercel-storage.com/photos/b.jpg`;
    const r = rebrandDelimitedList(v, ';', ORIGIN);
    expect(r.value).toBe(`${BRANDED};https://resiwalk.com/m/photos/b.jpg`);
  });
  it('no-op (changed=false) when there is no blob URL', () => {
    const v = 'https://x.hubspotusercontent-na1.net/a.jpg;https://x.hubspotusercontent-na1.net/b.jpg';
    expect(rebrandDelimitedList(v, ';', ORIGIN).changed).toBe(false);
  });
});

describe('rebrandJsonBlob', () => {
  it('rewrites the proof scalar and *__photos arrays inside answers_json', () => {
    const answers = { svc_completed: 'yes', proof_of_service_url: BLOB, q1__photos: [BLOB, 'https://x.hubspotusercontent-na1.net/keep.jpg'] };
    const r = rebrandJsonBlob(JSON.stringify(answers), ORIGIN);
    expect(r.changed).toBe(true);
    const out = JSON.parse(r.value);
    expect(out.proof_of_service_url).toBe(BRANDED);
    expect(out.q1__photos[0]).toBe(BRANDED);
    expect(out.q1__photos[1]).toBe('https://x.hubspotusercontent-na1.net/keep.jpg');
    expect(out.svc_completed).toBe('yes');
  });
  it('rewrites each value of a vendor-urls JSON object', () => {
    const map = { 'Vendor A': BLOB, 'Vendor B': 'https://x.hubspotusercontent-na1.net/v.pdf' };
    const out = JSON.parse(rebrandJsonBlob(JSON.stringify(map), ORIGIN).value);
    expect(out['Vendor A']).toBe(BRANDED);
    expect(out['Vendor B']).toBe('https://x.hubspotusercontent-na1.net/v.pdf');
  });
  it('leaves a plain-text (non-JSON) note untouched', () => {
    const note = 'see the file';
    expect(rebrandJsonBlob(note, ORIGIN)).toEqual({ value: note, changed: false });
  });
  it('no-op when JSON has no blob URL', () => {
    expect(rebrandJsonBlob(JSON.stringify({ a: 1, b: 'hi' }), ORIGIN).changed).toBe(false);
  });
});

describe('hasBlobUrl', () => {
  it('detects the blob host anywhere', () => {
    expect(hasBlobUrl(`x ${BLOB} y`)).toBe(true);
    expect(hasBlobUrl('nothing here')).toBe(false);
  });
});
