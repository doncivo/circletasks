import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManualClock } from '../../../src/domain/clock';
import type { IsoDateTime } from '../../../src/domain/types';
import type { SyncReason, SyncStatus } from '../../../src/platform/sync/types';
import { INITIAL_STATUS, phaseOf, startSyncScheduler, syncAge } from '../../../src/sync';
import type { CycleFacts } from '../../../src/sync/status';
import { createSimDevice, setupFirst, type SimDevice } from '../../sim/syncDevice';

/** Déclenchement, un seul cycle à la fois, état (ADR 0011, sections 10.1, 10.4 ; Y-02 critères 1, 16, 17 ; Y-03 critères 2 et 3). */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let devices: SimDevice[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

function fakeDocument() {
  const listeners = new Set<() => void>();
  const doc = {
    visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener: (_: string, l: () => void) => listeners.add(l),
    removeEventListener: (_: string, l: () => void) => listeners.delete(l),
    set(state: DocumentVisibilityState) {
      doc.visibilityState = state;
      for (const l of listeners) l();
    },
  };
  return doc;
}

describe('planificateur (Y-02 critère 1)', () => {
  it('ouverture, 4 min 59 s sans cycle, 5 min avec, masquage, rien en arrière-plan', async () => {
    const clock = createManualClock('2026-10-05T08:00:00.000Z');
    const reasons: SyncReason[] = [];
    const doc = fakeDocument();
    const scheduler = startSyncScheduler({ syncNow: async (r) => void reasons.push(r) }, { document: doc as unknown as Document, clock, setInterval: () => 0, clearInterval: () => undefined });
    expect(reasons).toEqual(['open']);
    clock.advance(4 * 60_000 + 59_000);
    await scheduler.tick();
    expect(reasons).toEqual(['open']);
    clock.advance(1_000);
    await scheduler.tick();
    expect(reasons).toEqual(['open', 'timer']);
    doc.set('hidden');
    expect(reasons).toEqual(['open', 'timer', 'hide']);
    clock.advance(30 * 60_000);
    await scheduler.tick();
    expect(reasons).toEqual(['open', 'timer', 'hide']);
    doc.set('visible');
    await Promise.resolve();
    expect(reasons).toEqual(['open', 'timer', 'hide', 'timer']);
    scheduler.dispose();
  });

  it('« Quitter » : un dernier cycle, attendu 5 s au plus, puis on rend la main quoi qu’il arrive', async () => {
    vi.useFakeTimers();
    const doc = fakeDocument();
    const scheduler = startSyncScheduler({ syncNow: (r) => (r === 'quit' ? new Promise<void>(() => undefined) : Promise.resolve()) }, { document: doc as unknown as Document, clock: createManualClock(0), setInterval: () => 0, clearInterval: () => undefined });
    let done = false;
    void scheduler.beforeQuit().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    vi.useRealTimers();
    scheduler.dispose();
  });
});

describe('service (Y-02 critère 1, Y-03 critère 3)', () => {
  it('un seul cycle à la fois ; cinq demandes pendant un cycle en programment un seul de plus ; syncNow ne rejette jamais', async () => {
    const a = await createSimDevice(A_ID);
    devices = [a];
    await setupFirst(a);
    let scans = 0;
    let release: () => void = () => undefined;
    let signalFirstScan: () => void = () => undefined;
    const firstScan = new Promise<void>((resolve) => (signalFirstScan = resolve));
    const real = a.platform.scan.bind(a.platform);
    vi.spyOn(a.platform, 'scan').mockImplementation(async (r) => {
      scans += 1;
      if (scans === 1) {
        const held = new Promise<void>((resolve) => (release = resolve));
        signalFirstScan();
        await held;
      }
      return real(r);
    });
    const first = a.service.syncNow('open');
    const extra = Array.from({ length: 5 }, () => a.service.syncNow('manual'));
    await firstScan;
    expect(scans).toBe(1);
    release();
    await Promise.all([first, ...extra]);
    expect(scans).toBe(2);
    // Y-03 critère 7 : chaque appel journalise sa raison, sans contenu ni chemin.
    await a.service.syncNow('tray');
    expect(a.logger.entries.filter((e) => e.event === 'sync-now').map((e) => e.detail)).toContainEqual({ reason: 'tray' });
    expect(JSON.stringify(a.logger.entries)).not.toMatch(/iCloud Drive|\\\\|\//);
    vi.spyOn(a.platform, 'scan').mockRejectedValue(new Error('panne'));
    await expect(a.service.syncNow('manual')).resolves.toBeUndefined();
    expect(a.service.status().phase).toBe('error');
  });

  it('non configuré, à associer, à jour ; heure de dernière synchro ; conflits de la semaine', async () => {
    const a = await createSimDevice(A_ID);
    devices = [a];
    expect((await a.cycle()).phase).toBe('not-configured');
    await a.platform.folder.choose();
    expect((await a.cycle()).phase).toBe('needs-pairing');
    await a.platform.key.create();
    const status = await a.cycle();
    expect(status.phase).toBe('idle');
    expect(status.lastSyncAt).toBe('2026-10-05T08:00:00.000Z');
    expect(status.folderLabel).toBe('iCloud Drive / CircleTasks');
    expect(status.devices).toEqual([{ deviceId: A_ID, platform: 'windows', self: true, lastReadAt: '2026-10-05T08:00:00.000Z', status: 'active' }]);
    expect(status.conflictsThisWeek).toBe(0);
  });

  it('« syncing » seulement si le cycle lit ou écrit', async () => {
    const a = await createSimDevice(A_ID);
    devices = [a];
    await setupFirst(a);
    await a.cycle();
    const phases: string[] = [];
    a.service.subscribe(() => phases.push(a.service.status().phase));
    await a.cycle();
    expect(phases).not.toContain('syncing');
    await a.createTask('Écriture');
    await a.cycle();
    expect(phases).toContain('syncing');
    expect(a.service.status().phase).toBe('idle');
  });
});

describe('état (Y-02 critère 16)', () => {
  const facts = (extra: Partial<CycleFacts>): CycleFacts => ({ outcome: 'done', errorCode: null, pendingFiles: [], devices: [], keyMismatch: false, ...extra });
  it('phases', () => {
    expect(phaseOf(facts({ outcome: 'not-configured' }))).toBe('not-configured');
    expect(phaseOf(facts({ outcome: 'restore-choice' }))).toBe('restore-choice');
    expect(phaseOf(facts({ outcome: 'failed', errorCode: 'folder-unreachable' }))).toBe('error');
    expect(phaseOf(facts({ outcome: 'failed', errorCode: 'cloud-pending' }))).toBe('waiting-icloud');
    expect(phaseOf(facts({ outcome: 'failed', errorCode: 'key-mismatch' }))).toBe('key-mismatch');
    expect(phaseOf(facts({ pendingFiles: ['x'] }))).toBe('waiting-icloud');
    expect(phaseOf(facts({ devices: [{ deviceId: A_ID as never, platform: 'ios', self: false, lastReadAt: null, status: 'clock-ahead' }] }))).toBe('clock-ahead');
    expect(phaseOf(facts({ devices: [{ deviceId: A_ID as never, platform: 'ios', self: false, lastReadAt: null, status: 'newer-major' }] }))).toBe('update-required');
    expect(phaseOf(facts({}))).toBe('idle');
    const status: SyncStatus = INITIAL_STATUS;
    expect(status.phase).toBe('not-configured');
  });

  it('âge (D2) : à l’instant sous 1 min, puis minutes, heures, jours', () => {
    const at = '2026-10-05T08:00:00.000Z' as IsoDateTime;
    const ms = Date.parse(at);
    expect(syncAge(at, ms + 59_000)).toEqual({ unit: 'now' });
    expect(syncAge(at, ms + 120_000)).toEqual({ unit: 'min', n: 2 });
    expect(syncAge(at, ms + 3 * 3_600_000)).toEqual({ unit: 'h', n: 3 });
    expect(syncAge(at, ms + 49 * 3_600_000)).toEqual({ unit: 'd', n: 2 });
  });
});
