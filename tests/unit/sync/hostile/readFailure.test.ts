import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { syncBannerFor } from '../../../../src/domain/syncBanners';
import { isPermanentSyncError, SLOW_RETRY_MS, syncErrorFamily } from '../../../../src/domain/sync/errorFamily';
import { statusLine } from '../../../../src/features/sync/syncText';
import { t } from '../../../../src/i18n';
import { SYNC_ERROR_CODES, SyncPlatformError, type SyncErrorCode, type SyncStatus } from '../../../../src/platform/sync/types';
import type { SyncDeps } from '../../../../src/sync/deps';
import { readDevice, type ReadStatus } from '../../../../src/sync/reader';
import { createSimDevice, pair, setupFirst, syncFolders, warmSimDevices, type SimDevice } from '../../../sim/syncDevice';

/**
 * Y-FIX-03 (B3 de docs/audit-1.0.md, ADR 0011 §31) : une lecture de journal en échec n'est jamais muette. Critères 2 à 12 de la fiche
 * (le critère 1 est le scénario 3 du banc, `scenario3ReadIo.test.ts`, repris tel quel). Panne passagère (`io`) armée par le plan de
 * pannes commun ; pannes permanentes (`bad-header`, `decrypt-failed`) levées par la plateforme simulée elle-même (le plan commun n'accepte
 * que `io` et `cloud-pending`, lus aussi par les deux faux de Rust : voir « Écarts » de la fiche).
 */

const A_ID = '56d4eec1-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'ef50b6f7-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C_ID = '0c3a9d21-cccc-4ccc-8ccc-cccccccccccc';
const DAY = 86_400_000;
const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/sync/fault-plan.json', import.meta.url), 'utf8')) as { readonly plans: readonly { readonly name: string }[] };
const plan = (name: string): unknown => {
  const found = fixture.plans.find((p) => p.name === name);
  if (!found) throw new Error(`plan absent de la fixture : ${name}`);
  return found;
};

let devices: SimDevice[] = [];
beforeAll(warmSimDevices);
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

/** PC (A) et iPhone (B) associés, à jour l'un de l'autre ; C (tablette) en plus si demandé. */
async function setup(withThird = false): Promise<{ a: SimDevice; b: SimDevice; c: SimDevice | null; lastSyncAt: string }> {
  const a = await createSimDevice(A_ID, { name: 'PC' });
  const b = await createSimDevice(B_ID, { name: 'iPhone', clock: a.clock, devicePlatform: 'ios' });
  devices.push(a, b);
  await setupFirst(a);
  await a.createTask('Tâche PC 1');
  await a.cycle();
  await pair(a, b);
  await b.cycle();
  let c: SimDevice | null = null;
  if (withThird) {
    c = await createSimDevice(C_ID, { name: 'Tablette', clock: a.clock });
    devices.push(c);
    syncFolders(devices);
    await pair(a, c);
    syncFolders(devices);
    await c.cycle();
  }
  syncFolders(devices);
  await a.cycle();
  syncFolders(devices);
  const before = await b.cycle();
  expect(statusLine(before, b.clock.nowMs())).toContain('À jour');
  if (before.lastSyncAt === null) throw new Error('lastSyncAt attendu après un cycle complet');
  return { a, b, c, lastSyncAt: before.lastSyncAt };
}

const selfLastSyncAt = async (d: SimDevice): Promise<string | null> => (await d.data.repos.sync.getStates()).find((row) => row.isSelf)?.lastSyncAt ?? null;
const rowOf = async (d: SimDevice, id: string) => (await d.data.repos.sync.getStates()).find((row) => row.deviceId === id);
const eventsSince = (d: SimDevice, mark: number): string[] => d.logger.entries.slice(mark).map((e) => e.event);
const upToDateNow = t('sync.status.upToDate', { age: t('sync.status.ageNow') });

/** Fait échouer chaque lecture du journal de `deviceId` par `b` avec `code` (fichier illisible côté plateforme), tant que `on()` est vrai. */
function failReads(b: SimDevice, deviceId: string, code: SyncErrorCode, on: () => boolean = () => true): void {
  const real = b.platform.readJournal.bind(b.platform);
  b.platform.readJournal = async (r) => {
    if (r.deviceId === deviceId && on()) throw new SyncPlatformError(code);
    return real(r);
  };
}

describe('Y-FIX-03 : lecture passagère en échec (io), critères 2 à 6', () => {
  it('cycle failed io, lastSyncAt gelé en base, publication et lecture des autres appareils faites, entretien sauté puis repris, aucun doublon', async () => {
    const { a, b, c, lastSyncAt } = await setup(true);
    if (!c) throw new Error('troisième appareil attendu');
    a.clock.advance(60_000);
    const late = await a.createTask('Tâche PC 2');
    await a.cycle();
    const fromC = await c.createTask('Tâche tablette');
    await c.cycle();
    syncFolders(devices);
    // Instantané dû chez B (aucun instantané de moins de 7 jours, ni le sien ni celui d'un autre) : l'entretien a quelque chose à faire.
    a.clock.advance(8 * DAY);
    const local = await b.createTask('Tâche iPhone');
    const rowA = await rowOf(b, a.id);
    const filesBefore = b.folder.fileNames(b.id);
    const mark = b.logger.entries.length;
    b.folder.armFaults(plan('scenario-3-lecture-io'));
    const failed = await b.cycle();
    expect(b.folder.faultLog().map((f) => f.id)).toEqual(['read-journal-io']);

    // Critère 2 : cycle en échec avec le code réel ; heure de dernière synchro gelée dans l'état ET dans la base.
    expect(failed.phase).toBe('error');
    expect(failed.errorCode).toBe('io');
    expect(failed.lastSyncAt).toBe(lastSyncAt);
    expect(await selfLastSyncAt(b)).toBe(lastSyncAt);
    expect(statusLine(failed, b.clock.nowMs())).toBe(t('sync.status.errorGeneric'));
    // Critère 3 : publication faite, l'appareil sain lu jusqu'à sa tête.
    expect(await b.data.repos.sync.outboxCount()).toBe(0);
    expect((await b.task(fromC.id))?.title).toBe('Tâche tablette');
    syncFolders(devices);
    await a.cycle();
    expect((await a.task(local.id))?.title).toBe('Tâche iPhone');
    // Critère 4 : entretien sauté (aucun instantané, aucune suppression de fichier propre).
    expect(eventsSince(b, mark)).not.toContain('snapshot-written');
    expect(b.folder.fileNames(b.id).filter((name) => !filesBefore.includes(name) && /\/s-\d+\.cts$/.test(name))).toEqual([]);
    expect(filesBefore.filter((name) => !b.folder.fileNames(b.id).includes(name))).toEqual([]);
    // Critère 5 : curseur et accusé de l'appareil en échec inchangés ; rien de lui appliqué.
    const rowAfter = await rowOf(b, a.id);
    expect({ s: rowAfter?.cursorSegment, r: rowAfter?.cursorRecord, ack: rowAfter?.ackHlc }).toEqual({ s: rowA?.cursorSegment, r: rowA?.cursorRecord, ack: rowA?.ackHlc });
    expect(await b.task(late.id)).toBeNull();
    // Critère 12 : journal `read-failed` existant, identifiant et code seulement.
    expect(b.logger.entries.slice(mark).find((e) => e.event === 'read-failed')?.detail).toEqual({ device: a.id, code: 'io' });

    // Critère 6 : panne consommée, tout est lu, « À jour · à l’instant », compteurs retirés ; entretien dû exécuté.
    a.clock.advance(60_000);
    const mark2 = b.logger.entries.length;
    const ok = await b.cycle();
    expect(ok.phase).toBe('idle');
    expect(ok.errorCode).toBeNull();
    expect(ok.errorStreak).toBeUndefined();
    expect(ok.retryAt).toBeUndefined();
    expect(ok.lastSyncAt).toBe(new Date(b.clock.nowMs()).toISOString());
    expect(await selfLastSyncAt(b)).toBe(ok.lastSyncAt);
    expect(statusLine(ok, b.clock.nowMs())).toBe(upToDateNow);
    expect(eventsSince(b, mark2)).toContain('snapshot-written');
    // Critère 5 (suite) : appliqué une seule fois.
    expect((await b.task(late.id))?.title).toBe('Tâche PC 2');
    const titles = (await b.driver.select<{ title: string }>('SELECT title FROM task')).map((row) => row.title).filter((title) => title === 'Tâche PC 2');
    expect(titles).toEqual(['Tâche PC 2']);
    expect(await rowOf(b, a.id)).toMatchObject({ cursorSegment: (await rowOf(a, a.id))?.headSegment, cursorRecord: (await rowOf(a, a.id))?.headRecord });
  });
});

describe('Y-FIX-03 : panne passagère durable, critère 7', () => {
  it('trois cycles en io : errorStreak 2 puis 3, ralentie au 3e (retryAt à +30 min), planificateur jamais arrêté, lastSyncAt gelé', async () => {
    const { a, b, lastSyncAt } = await setup();
    a.clock.advance(60_000);
    await a.createTask('Tâche PC 2');
    await a.cycle();
    syncFolders(devices);
    b.folder.armFaults(plan('scenario-3-lecture-io-durable'));
    const first = await b.cycle();
    expect(first.phase).toBe('error');
    expect(first.errorStreak).toBeUndefined();
    expect(first.retryAt).toBeUndefined();
    a.clock.advance(5 * 60_000);
    const second = await b.cycle();
    expect(second.errorStreak).toBe(2);
    expect(second.retryAt).toBeUndefined();
    a.clock.advance(5 * 60_000);
    const third = await b.cycle();
    const now = b.clock.nowMs();
    expect(third.errorCode).toBe('io');
    expect(third.errorStreak).toBe(3);
    expect(third.retryAt).toBe(new Date(now + SLOW_RETRY_MS).toISOString());
    const retry = new Date(now + SLOW_RETRY_MS);
    const hhmm = `${String(retry.getHours()).padStart(2, '0')}:${String(retry.getMinutes()).padStart(2, '0')}`;
    expect(statusLine(third, now)).toBe(t('sync.status.errorSlowed', { time: hhmm, code: 'io' }));
    expect(isPermanentSyncError('io')).toBe(false);
    for (const s of [first, second, third]) expect(s.lastSyncAt).toBe(lastSyncAt);
    expect(await selfLastSyncAt(b)).toBe(lastSyncAt);
    expect(b.folder.faultLog().map((f) => f.id)).toEqual(['read-journal-io-always', 'read-journal-io-always', 'read-journal-io-always']);
    // Panne levée : retour à « À jour », compteurs retirés.
    b.folder.disarmFaults();
    const ok = await b.cycle();
    expect(ok.errorStreak).toBeUndefined();
    expect(ok.retryAt).toBeUndefined();
    expect(statusLine(ok, b.clock.nowMs())).toBe(upToDateNow);
  });
});

describe('Y-FIX-03 : lecture permanente en échec (bad-header, decrypt-failed), critères 8, 9, 11', () => {
  it.each(['bad-header', 'decrypt-failed'] as const)('%s : reprise tentée, appareil corrupt, cycle done, lastSyncAt gelé, « Synchro incomplète » et bandeau device-corrupt', async (code) => {
    const { a, b, lastSyncAt } = await setup();
    // Instantané du PC écrit (8 jours), puis une écriture au-delà : la reprise ne couvre pas tout, le journal reste à lire.
    a.clock.advance(8 * DAY);
    await a.cycle();
    a.clock.advance(60_000);
    await a.createTask('Tâche PC 2');
    await a.cycle();
    syncFolders(devices);
    const local = await b.createTask('Tâche iPhone');
    failReads(b, a.id, code);
    const mark = b.logger.entries.length;
    const broken = await b.cycle();
    const events = eventsSince(b, mark);
    // Une reprise depuis l'instantané tentée (une par cycle), sans effet : l'appareil reste illisible.
    expect(events.filter((e) => e === 'resumed-from-snapshot' || e === 'resume-unavailable').length).toBe(1);
    expect(b.logger.entries.slice(mark).filter((e) => e.event === 'read-failed').map((e) => e.detail)).toContainEqual({ device: a.id, code });
    expect(broken.phase).toBe('idle');
    expect(broken.errorCode).toBeNull();
    expect(broken.devices.find((d) => d.deviceId === a.id)?.status).toBe('corrupt');
    expect((await rowOf(b, a.id))?.status).toBe('corrupt');
    expect(broken.lastSyncAt).toBe(lastSyncAt);
    expect(await selfLastSyncAt(b)).toBe(lastSyncAt);
    // Publication faite, entretien sauté.
    expect(await b.data.repos.sync.outboxCount()).toBe(0);
    syncFolders(devices);
    await a.cycle();
    expect((await a.task(local.id))?.title).toBe('Tâche iPhone');
    expect(events).not.toContain('snapshot-written');
    // Critères 9 et 11 : visible dans l'app, d'après l'état produit par le moteur.
    expect(statusLine(broken, b.clock.nowMs())).toBe(t('sync.status.incomplete'));
    const banners = syncBannerFor(broken, { devices: null, blocking: null, readFailed: false, join: null });
    const trouble = banners.troubles.find((x) => x.code === 'device-corrupt');
    expect(trouble && 'device' in trouble ? trouble.device.deviceId : null).toBe(a.id);
    // Tant que l'appareil est `corrupt`, jamais « À jour » (le cycle suivant ne le lit plus).
    a.clock.advance(60_000);
    const next = await b.cycle();
    expect(next.devices.find((d) => d.deviceId === a.id)?.status).toBe('corrupt');
    expect(statusLine(next, b.clock.nowMs())).toBe(t('sync.status.incomplete'));
  });

  it('decrypt-failed sur une seule lecture, instantané du PC couvrant tout : reprise réussie, appareil actif, lastSyncAt gelé ce cycle, « À jour · à l’instant » au suivant', async () => {
    const { a, b, lastSyncAt } = await setup();
    a.clock.advance(8 * DAY);
    const late = await a.createTask('Tâche PC 2');
    await a.cycle();
    syncFolders(devices);
    let left = 1;
    failReads(b, a.id, 'decrypt-failed', () => left-- > 0);
    const mark = b.logger.entries.length;
    const first = await b.cycle();
    expect(eventsSince(b, mark)).toContain('resumed-from-snapshot');
    expect((await b.task(late.id))?.title).toBe('Tâche PC 2');
    expect(first.devices.find((d) => d.deviceId === a.id)?.status).toBe('active');
    // Décision 1 : une lecture a échoué dans ce cycle, `lastSyncAt` n'avance pas (jamais « à l’instant »).
    expect(first.lastSyncAt).toBe(lastSyncAt);
    expect(await selfLastSyncAt(b)).toBe(lastSyncAt);
    expect(statusLine(first, b.clock.nowMs())).not.toBe(upToDateNow);
    a.clock.advance(60_000);
    const ok = await b.cycle();
    expect((await b.task(late.id))?.title).toBe('Tâche PC 2');
    expect(ok.devices.find((d) => d.deviceId === a.id)?.status).not.toBe('corrupt');
    expect(statusLine(ok, b.clock.nowMs())).toBe(upToDateNow);
  });
});

describe('Y-FIX-03 : classement de chaque code levé par readJournal, critère 10', () => {
  /** Traitement propre gardé (critère 13) ; sinon la famille décide : passagère → `error` (cycle failed), autre → `truncated` (corrupt). */
  const OWN: Partial<Record<SyncErrorCode, ReadStatus>> = { 'newer-format': 'newer-major', 'key-mismatch': 'foreign', 'cloud-pending': 'cloud-pending' };
  const expected = (code: SyncErrorCode): ReadStatus => OWN[code] ?? (syncErrorFamily(code) === 'transient' ? 'error' : 'truncated');

  it('tous les codes de SYNC_ERROR_CODES ont une famille connue et un traitement', () => {
    for (const code of SYNC_ERROR_CODES) expect(['transient', 'pairing', 'folder', 'reset', 'update', 'details'], code).toContain(syncErrorFamily(code));
    expect(expected('io')).toBe('error');
    expect(expected('bad-header')).toBe('truncated');
    expect(expected('decrypt-failed')).toBe('truncated');
  });

  it.each([...SYNC_ERROR_CODES])('%s', async (code) => {
    const logged: unknown[] = [];
    const deps = {
      platform: { readJournal: () => Promise.reject(new SyncPlatformError(code)) },
      logger: { log: (event: string, detail: unknown) => logged.push({ event, detail }) },
    } as unknown as SyncDeps;
    const outcome = await readDevice(deps, { deviceId: A_ID as never, epoch: 'e0001-00000000' as never, cursor: { segment: 1, record: 0 }, ackHlc: null, knows: () => true });
    expect(outcome.status).toBe(expected(code));
    expect(outcome.errorCode).toBe(code);
    expect(outcome.records).toBe(0);
    expect(logged).toEqual([{ event: 'read-failed', detail: { device: A_ID, code } }]);
  });
});

/** Critère 9 seul : un appareil `corrupt` (autre que soi) interdit « À jour » en phase idle, quel que soit le chemin qui l'a posé. */
describe('Y-FIX-03 : ligne d’état avec un appareil corrupt, critère 9', () => {
  const base = { phase: 'idle', lastSyncAt: '2026-10-05T08:00:00.000Z', devices: [], pendingFiles: [], errorCode: null } as unknown as SyncStatus;
  const device = (self: boolean, status: string) => ({ deviceId: self ? B_ID : A_ID, self, status, name: self ? 'iPhone' : 'PC' });
  it('autre appareil corrupt : « Synchro incomplète » ; autres appareils actifs : « À jour »', () => {
    const now = Date.parse('2026-10-05T08:00:30.000Z');
    expect(statusLine({ ...base, devices: [device(true, 'active'), device(false, 'corrupt')] } as unknown as SyncStatus, now)).toBe(t('sync.status.incomplete'));
    expect(statusLine({ ...base, devices: [device(true, 'active'), device(false, 'active')] } as unknown as SyncStatus, now)).toBe(upToDateNow);
  });
});
