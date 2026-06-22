import { describe, it, expect } from 'vitest';
import {
  stateOfRegion,
  externalAccessDenial,
  EXTERNAL_VIEW_STATE_BLOCK_MSG,
} from '@/lib/userAccess';

const EXT = 'agent@gmail.com';       // external (non-internal domain)
const INT = 'hwoods@resihome.com';   // internal
const SCOPE = 'pm_scope_rate_card';  // view-only template
const QC = 'pm_turn_reinspect_qc';   // view-only template
const T1099 = 'leasing_agent_1099_property_inspection'; // edit template

describe('stateOfRegion', () => {
  it('takes the prefix before the colon, upper-cased', () => {
    expect(stateOfRegion('GA: Atlanta')).toBe('GA');
    expect(stateOfRegion('fl: Tampa')).toBe('FL');
    expect(stateOfRegion('  TN:Nashville ')).toBe('TN');
  });
  it('returns the whole value (upper) when there is no colon', () => {
    expect(stateOfRegion('Texas')).toBe('TEXAS');
  });
  it('returns empty for blank/nullish', () => {
    expect(stateOfRegion('')).toBe('');
    expect(stateOfRegion(null)).toBe('');
    expect(stateOfRegion(undefined)).toBe('');
  });
});

describe('externalAccessDenial — view state gate', () => {
  it('internal users are never gated', () => {
    expect(externalAccessDenial(INT, SCOPE, {
      status: 'completed', region: 'FL: Tampa', unlockedStates: [],
    })).toBeNull();
  });

  it('blocks a completed Scope in a state the user has not unlocked', () => {
    expect(externalAccessDenial(EXT, SCOPE, {
      status: 'completed', region: 'FL: Tampa', unlockedStates: ['GA'],
    })).toBe(EXTERNAL_VIEW_STATE_BLOCK_MSG);
  });

  it('blocks when the user has unlocked nothing yet (empty array)', () => {
    expect(externalAccessDenial(EXT, QC, {
      status: 'completed', region: 'GA: Atlanta', unlockedStates: [],
    })).toBe(EXTERNAL_VIEW_STATE_BLOCK_MSG);
  });

  it('allows a completed Scope/QC once its state is unlocked', () => {
    expect(externalAccessDenial(EXT, SCOPE, {
      status: 'completed', region: 'FL: Tampa', unlockedStates: ['FL', 'GA'],
    })).toBeNull();
    expect(externalAccessDenial(EXT, QC, {
      status: 'completed', region: 'GA: Atlanta', unlockedStates: ['GA'],
    })).toBeNull();
  });

  it('never gates the user\'s own 1099 template by state', () => {
    expect(externalAccessDenial(EXT, T1099, {
      status: 'in progress', region: 'FL: Tampa', unlockedStates: [],
    })).toBeNull();
  });

  it('does not apply the state gate when unlockedStates is omitted (back-compat)', () => {
    expect(externalAccessDenial(EXT, SCOPE, {
      status: 'completed', region: 'FL: Tampa',
    })).toBeNull();
  });

  it('still rejects a non-completed Scope/QC before reaching the state gate', () => {
    expect(externalAccessDenial(EXT, SCOPE, {
      status: 'in_progress', region: 'FL: Tampa', unlockedStates: ['FL'],
    })).toBe('You can only view completed Scope Rate Card or Re-Inspect inspections.');
  });
});
