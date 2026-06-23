import { describe, it, expect } from 'vitest';
import {
  normalizeApprovalRouting, resolveApprovers, emptyApprovalRouting,
  type ApprovalRoutingConfig,
} from '@/lib/approvalRouting';

function cfg(): ApprovalRoutingConfig {
  return {
    pods: [
      {
        id: 'georgia', name: 'Georgia', channelId: 'CGA',
        rm: { name: 'Rita RM', slackId: 'URM' }, rmNte: 5000,
        regions: [
          { region: 'GA: Atlanta', pms: [{ name: 'Pam PM', slackId: 'UPM' }, { name: 'Pete PM', slackId: 'UPM2' }], pmNte: 1000, srPms: [{ name: 'Sam SrPM', slackId: 'USR' }], srPmNte: 3000 },
          { region: 'GA: Macon', pms: [], pmNte: null, srPms: [], srPmNte: null }, // no PM/SrPM → defaults to RM
        ],
      },
      { id: 'florida', name: 'Florida', channelId: 'CFL', rm: null, rmNte: null, regions: [] },
      { id: 'scattered', name: 'Scattered', channelId: 'CSC', rm: null, rmNte: null, regions: [] },
      { id: 'west', name: 'West', channelId: 'CWE', rm: null, rmNte: null, regions: [] },
    ],
    directors: [{ name: 'Dana Director', slackId: 'UDIR' }],
  };
}

describe('approvalRouting.normalize', () => {
  it('always yields exactly the 4 fixed pods, in order', () => {
    const n = normalizeApprovalRouting({ pods: [{ id: 'georgia' }], directors: [] });
    expect(n.pods.map((p) => p.id)).toEqual(['georgia', 'florida', 'scattered', 'west']);
  });
  it('drops blank users, non-positive NTEs, and duplicate regions; migrates legacy region nte → PM', () => {
    const n = normalizeApprovalRouting({
      pods: [{ id: 'west', rm: { name: '', slackId: '' }, rmNte: -5, regions: [
        { region: 'W: A', nte: 750 }, { region: 'W: A', pmNte: 100 }, // legacy `nte` migrates to pmNte
      ] }],
      directors: [{ name: '', slackId: '' }, { name: 'D', slackId: 'U1' }],
    });
    const west = n.pods.find((p) => p.id === 'west')!;
    expect(west.rm).toBeNull();
    expect(west.rmNte).toBeNull();
    expect(west.channelId).toBe('C087UENA8RF'); // defaulted from DEFAULT_POD_CHANNELS
    expect(west.regions).toHaveLength(1);
    expect(west.regions[0].pms).toEqual([]);
    expect(west.regions[0].pmNte).toBe(750); // migrated from legacy `nte`
    expect(west.regions[0].srPmNte).toBeNull();
    expect(n.directors).toEqual([{ name: 'D', slackId: 'U1' }]);
  });

  it('migrates a legacy single pm/srPm into the lists', () => {
    const n = normalizeApprovalRouting({
      pods: [{ id: 'georgia', regions: [{ region: 'GA: X', pm: { name: 'P', slackId: 'UP' }, srPm: { name: 'S', slackId: 'US' } }] }],
      directors: [],
    });
    const ga = n.pods.find((p) => p.id === 'georgia')!;
    expect(ga.regions[0].pms).toEqual([{ name: 'P', slackId: 'UP' }]);
    expect(ga.regions[0].srPms).toEqual([{ name: 'S', slackId: 'US' }]);
  });
  it('emptyApprovalRouting has 4 pods and no directors', () => {
    const e = emptyApprovalRouting();
    expect(e.pods).toHaveLength(4);
    expect(e.directors).toEqual([]);
  });
});

describe('approvalRouting.resolve', () => {
  it('tags ALL PMs within the PM NTE, on the POD channel', () => {
    const r = resolveApprovers(cfg(), 'GA: Atlanta', 800);
    expect(r.level).toBe('pm');
    expect(r.users.map((u) => u.slackId)).toEqual(['UPM', 'UPM2']);
    expect(r.channelId).toBe('CGA');
  });
  it('escalates to the Sr. PM above the PM NTE but within the Sr. PM NTE', () => {
    const r = resolveApprovers(cfg(), 'GA: Atlanta', 2000);
    expect(r.level).toBe('sr_pm');
    expect(r.users.map((u) => u.slackId)).toEqual(['USR']);
  });
  it('defaults to the RM when no PM/Sr.PM is set', () => {
    const r = resolveApprovers(cfg(), 'GA: Macon', 500);
    expect(r.level).toBe('rm');
    expect(r.users[0].slackId).toBe('URM');
  });
  it('escalates to the RM above the Sr. PM NTE', () => {
    const r = resolveApprovers(cfg(), 'GA: Atlanta', 4000);
    expect(r.level).toBe('rm');
    expect(r.users[0].slackId).toBe('URM');
  });
  it('escalates to the directors above the RM NTE', () => {
    const r = resolveApprovers(cfg(), 'GA: Atlanta', 9000);
    expect(r.level).toBe('director');
    expect(r.users.map((u) => u.slackId)).toEqual(['UDIR']);
  });
  it('falls back to directors for an unmapped region', () => {
    const r = resolveApprovers(cfg(), 'XX: Nowhere', 100);
    expect(r.level).toBe('director');
    expect(r.podId).toBeNull();
  });
});
