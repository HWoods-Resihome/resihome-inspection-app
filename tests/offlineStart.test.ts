import { describe, it, expect, beforeEach } from 'vitest';

// The offline stores are localStorage-backed and guard on `typeof window`.
// Provide a minimal Map-backed localStorage + window before each test.
beforeEach(() => {
  const store = new Map<string, string>();
  (globalThis as any).window = {
    localStorage: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
    },
  };
});

import {
  newLocalIds, isLocalInspectionId, addPendingInspection, getPendingInspection,
  pendingNeedingCreate, markCreating, markCreated, listPendingInspections, type PendingInspection,
} from '@/lib/pendingInspections';
import { enqueue, enqueueAnswers, entriesFor, rekeyInspectionId as rekeyOutbox } from '@/lib/offlineOutbox';
import { enqueuePhotoAttach, countPhotoAttach, rekeyInspectionId as rekeyAttach } from '@/lib/photoAttachOutbox';

function mkPending(tempId: string, externalId: string): PendingInspection {
  return {
    tempId, externalId,
    body: { templateType: 'pm_scope_rate_card', propertyRecordId: 'P1', propertyAddressSnapshot: '1 Main', inspectorName: 'A', bedrooms: 3, bathrooms: 2, externalId },
    display: { inspectionName: 'Rate Card – 1 Main', templateType: 'pm_scope_rate_card', propertyAddress: '1 Main', inspectorName: 'A' },
    status: 'pending', createdAt: 1,
  };
}

describe('pendingInspections', () => {
  it('mints local ids that are recognized as local and carry a stable external id', () => {
    const { tempId, externalId } = newLocalIds(Date.parse('2026-06-29T00:00:00Z'));
    expect(isLocalInspectionId(tempId)).toBe(true);
    expect(isLocalInspectionId('123456')).toBe(false);
    expect(externalId.startsWith('INSP-2026-06-29-')).toBe(true);
  });

  it('tracks lifecycle: add → needing-create → creating → created', () => {
    addPendingInspection(mkPending('local_aaa', 'INSP-1'));
    expect(getPendingInspection('local_aaa')?.status).toBe('pending');
    expect(pendingNeedingCreate().map((p) => p.tempId)).toEqual(['local_aaa']);
    markCreating('local_aaa');
    expect(getPendingInspection('local_aaa')?.status).toBe('creating');
    markCreated('local_aaa', '99001');
    expect(getPendingInspection('local_aaa')?.realId).toBe('99001');
    // A created one no longer needs creation, and is filtered from the visible
    // "not synced" set by the home list (status !== 'created').
    expect(pendingNeedingCreate()).toHaveLength(0);
    expect(listPendingInspections().find((p) => p.tempId === 'local_aaa')?.status).toBe('created');
  });
});

describe('outbox re-key (temp → real)', () => {
  it('rewrites the endpoint, inspectionRecordId, AND any record-id token in the body', () => {
    const temp = 'local_zzz';
    const real = '77002';
    // A line save (endpoint + field) and an answers save whose body embeds a
    // Final-Checklist key derived from the record id.
    enqueue({ inspectionRecordId: temp, endpoint: `/api/inspections/${temp}/rate-card-lines`, method: 'POST', body: { upserts: [{ x: 1 }] }, kind: 'line' });
    enqueueAnswers(temp, `/api/inspections/${temp}/answers`, { upserts: [{ answerProps: { answer_id_external: `FINALCHECKLIST-${temp}` } }] });

    rekeyOutbox(temp, real);

    expect(entriesFor(temp)).toHaveLength(0);
    const real2 = entriesFor(real);
    expect(real2).toHaveLength(2);
    for (const e of real2) {
      expect(e.inspectionRecordId).toBe(real);
      expect(e.endpoint).toBe(`/api/inspections/${real}/${e.kind === 'line' ? 'rate-card-lines' : 'answers'}`);
      // No temp token survives ANYWHERE (incl. the FC key inside the body).
      expect(JSON.stringify(e)).not.toContain(temp);
    }
    const fc = real2.find((e) => e.kind === 'answers');
    expect(fc?.body.upserts[0].answerProps.answer_id_external).toBe(`FINALCHECKLIST-${real}`);
  });

  it('is a no-op when there is nothing for that temp id', () => {
    enqueue({ inspectionRecordId: 'other', endpoint: '/api/inspections/other/answers', method: 'POST', body: {}, kind: 'line' });
    rekeyOutbox('local_absent', '123');
    expect(entriesFor('other')).toHaveLength(1);
  });
});

describe('photo-attach outbox re-key', () => {
  it('moves queued attaches from the temp id to the real id', () => {
    const temp = 'local_ppp';
    const real = '55003';
    enqueuePhotoAttach({ inspectionRecordId: temp, url: 'https://f/1.jpg', target: { kind: 'section', externalId: `${'INSP-1'}_sp_kitchen`, field: 'photo_urls' } });
    enqueuePhotoAttach({ inspectionRecordId: temp, url: 'https://f/2.jpg', target: { kind: 'fc', externalId: `FINALCHECKLIST-${temp}`, fcSlot: 'q1:photo' } });
    expect(countPhotoAttach(temp)).toBe(2);

    rekeyAttach(temp, real);

    expect(countPhotoAttach(temp)).toBe(0);
    expect(countPhotoAttach(real)).toBe(2);
  });
});
