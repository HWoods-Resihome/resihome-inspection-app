import { describe, it, expect } from 'vitest';
import { finalChecklistGap, isFinalChecklistComplete, type FcAnswers, type FcCompletionCtx } from '@/lib/finalChecklist';

const baseCtx: FcCompletionCtx = {
  septicFee: 0,                  // septic hidden → not required
  airQtyPrefill: 2,
  filterOptionsAvailable: false, // can't require sizes when no options → skipped
  filterPrefills: [null, null, null],
};

// A fully-answered checklist (no deficiencies, no add-line prompts triggered).
const complete = (): FcAnswers => ({
  fc_smart_home_device: { value: 'No Smart Devices' },
  fc_garage_remote: { value: 'N/A' },
  fc_mailbox_keys: { value: 'N/A' },
  fc_hvac_functioning: { value: 'Yes' },
  fc_label_stickers: { stickerPhotos: { air_handler: ['u1'], outside_condenser: ['u2'], water_heater: ['u3'] } },
  fc_air_filters_qty: { quantity: 2 },
  fc_electric: { value: 'On' },
  fc_water: { value: 'On' },
  fc_gas: { value: 'On' },
  fc_trash_bins: { value: 'N/A' },
});

describe('finalChecklistGap', () => {
  it('returns null when every required item is answered', () => {
    expect(finalChecklistGap(complete(), baseCtx)).toBeNull();
    expect(isFinalChecklistComplete(complete(), baseCtx)).toBe(true);
  });

  it('flags a missing single-select answer (descriptive)', () => {
    const a = complete(); delete a.fc_hvac_functioning;
    const gap = finalChecklistGap(a, baseCtx);
    expect(gap).toContain('HVAC Functioning');
  });

  it('flags a missing required sticker photo', () => {
    const a = complete();
    a.fc_label_stickers = { stickerPhotos: { air_handler: ['u1'], outside_condenser: ['u2'] } }; // water heater missing
    expect(finalChecklistGap(a, baseCtx)).toContain('Water Heater');
  });

  it('requires accept/decline when a No answer suggests a line', () => {
    const a = complete(); a.fc_garage_remote = { value: 'No' };
    expect(finalChecklistGap(a, baseCtx)).toContain('Garage Remote');
  });

  it('AUTO-SATISFIES the add-line prompt when the line already exists (the lock-out bug fix)', () => {
    const a = complete(); a.fc_garage_remote = { value: 'No' };
    const ctx: FcCompletionCtx = { ...baseCtx, lineExists: (code) => code === 'GADRL1037' };
    expect(finalChecklistGap(a, ctx)).toBeNull();
  });

  it('is satisfied once the prompt is accepted (added) or declined', () => {
    const a1 = complete(); a1.fc_garage_remote = { value: 'No', added: { externalId: 'x', costLabel: '$1' } };
    expect(finalChecklistGap(a1, baseCtx)).toBeNull();
    const a2 = complete(); a2.fc_garage_remote = { value: 'No', declined: true };
    expect(finalChecklistGap(a2, baseCtx)).toBeNull();
  });

  it('requires a photo when present-trash needs one, and a device serial', () => {
    const a = complete(); a.fc_trash_bins = { value: 'Present', count: 2 };
    expect(finalChecklistGap(a, baseCtx)).toContain('Trash Bins'); // photo required

    const b = complete(); b.fc_smart_home_device = { value: 'Bluetooth Lock', device: { status: 'Online' } }; // serial missing
    expect(finalChecklistGap(b, baseCtx)).toContain('Serial');
  });

  it('requires septic only when septic_fee > 0', () => {
    const a = complete(); // no septic answer
    expect(finalChecklistGap(a, baseCtx)).toBeNull(); // hidden when fee 0
    expect(finalChecklistGap(a, { ...baseCtx, septicFee: 50 })).toContain('Septic'); // now required
  });
});
