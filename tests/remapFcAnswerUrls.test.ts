import { describe, it, expect } from 'vitest';
import { remapFcAnswerUrls, type FcAnswers } from '@/lib/finalChecklist';

const HS = 'https://resihome.com/hubfs/inspection_photos';
const BLOB = 'https://x.public.blob.vercel-storage.com/inspections/1/x';

describe('remapFcAnswerUrls', () => {
  it('swaps photoUrls and stickerPhotos, leaves other answer data intact', () => {
    const a: FcAnswers = {
      fc_garage_remote: { value: 'yes', note: 'keep me', photoUrls: [`${HS}/a.jpg`, `${HS}/b.jpg`] },
      fc_smart_lock: { device: { type: 'x' }, stickerPhotos: { serial: [`${HS}/c.jpg`], model: [`${HS}/d.jpg`] } },
    };
    const map = new Map([
      [`${HS}/a.jpg`, `${BLOB}/a.jpg`],
      [`${HS}/b.jpg`, `${BLOB}/b.jpg`],
      [`${HS}/c.jpg`, `${BLOB}/c.jpg`],
      [`${HS}/d.jpg`, `${BLOB}/d.jpg`],
    ]);
    const { answers, swapped } = remapFcAnswerUrls(a, map);
    expect(swapped).toBe(4);
    expect(answers.fc_garage_remote.photoUrls).toEqual([`${BLOB}/a.jpg`, `${BLOB}/b.jpg`]);
    expect(answers.fc_smart_lock.stickerPhotos!.serial).toEqual([`${BLOB}/c.jpg`]);
    expect(answers.fc_smart_lock.stickerPhotos!.model).toEqual([`${BLOB}/d.jpg`]);
    // untouched fields preserved
    expect(answers.fc_garage_remote.value).toBe('yes');
    expect(answers.fc_garage_remote.note).toBe('keep me');
    expect(answers.fc_smart_lock.device).toEqual({ type: 'x' });
    // input not mutated
    expect(a.fc_garage_remote.photoUrls).toEqual([`${HS}/a.jpg`, `${HS}/b.jpg`]);
  });

  it('matches ignoring query string and preserves the #v= video fragment', () => {
    const a: FcAnswers = { fc_x: { photoUrls: [`${HS}/v.jpg?t=1#v=${HS}/v.mp4`] } };
    const map = new Map([[`${HS}/v.jpg`, `${BLOB}/v.jpg`]]);
    const { answers, swapped } = remapFcAnswerUrls(a, map);
    expect(swapped).toBe(1);
    expect(answers.fc_x.photoUrls![0]).toBe(`${BLOB}/v.jpg#v=${HS}/v.mp4`);
  });

  it('leaves URLs not in the map alone (already-Blob / unknown)', () => {
    const a: FcAnswers = { fc_x: { photoUrls: [`${BLOB}/already.jpg`, `${HS}/gone.jpg`] } };
    const map = new Map([[`${HS}/gone.jpg`, `${BLOB}/gone.jpg`]]);
    const { answers, swapped } = remapFcAnswerUrls(a, map);
    expect(swapped).toBe(1);
    expect(answers.fc_x.photoUrls).toEqual([`${BLOB}/already.jpg`, `${BLOB}/gone.jpg`]);
  });

  it('is safe on empty/missing structures', () => {
    expect(remapFcAnswerUrls({}, new Map()).swapped).toBe(0);
    const a: FcAnswers = { fc_x: { value: 'no' } };
    const { answers, swapped } = remapFcAnswerUrls(a, new Map([[`${HS}/z.jpg`, `${BLOB}/z.jpg`]]));
    expect(swapped).toBe(0);
    expect(answers.fc_x.value).toBe('no');
  });
});
