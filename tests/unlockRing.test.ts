import { describe, it, expect } from 'vitest';
import { lockRingFromProperty } from '@/components/UnlockButton';

describe('lockRingFromProperty', () => {
  it('returns null (no ring) when the device type is unknown/empty', () => {
    expect(lockRingFromProperty(null, null, null)).toBe(null);
    expect(lockRingFromProperty('', 'Online', 'Online')).toBe(null);
    expect(lockRingFromProperty('   ', null, null)).toBe(null);
  });

  it('a known, non-hub device is online (green) regardless of the hub/lock statuses', () => {
    expect(lockRingFromProperty('Bluetooth Lock', null, null)).toBe('online');
    expect(lockRingFromProperty('Bluetooth Lock', 'Offline', 'Offline')).toBe('online');
    expect(lockRingFromProperty('Z-Wave Lock', '', '')).toBe('online');
  });

  it('a Smart Home Hub is online only when BOTH hub and lock statuses are Online', () => {
    expect(lockRingFromProperty('Smart Home Hub', 'Online', 'Online')).toBe('online');
    // case/space insensitive
    expect(lockRingFromProperty('smart home hub', ' online ', 'ONLINE')).toBe('online');
  });

  it('a Smart Home Hub is offline (red) if either status is not Online', () => {
    expect(lockRingFromProperty('Smart Home Hub', 'Online', 'Offline')).toBe('offline');
    expect(lockRingFromProperty('Smart Home Hub', 'Offline', 'Online')).toBe('offline');
    expect(lockRingFromProperty('Smart Home Hub', null, null)).toBe('offline');
    expect(lockRingFromProperty('Smart Home Hub', 'Online', '')).toBe('offline');
  });
});
