import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FOLDER_WARN_BYTES, MAX_SCAN_ENTRIES_PER_FOLDER, NONCE_WARN_RECORDS } from '../../../src/domain/sync/limits';
import type { DeviceId, IsoDateTime } from '../../../src/domain/types';
import type { DeviceAck, EpochId, PublishedDeviceState } from '../../../src/domain/sync/format';
import { parseStoredAcks, parseStoredIso, SyncStateUnreadableError } from '../../../src/domain/sync/stored';
import { SyncPlatformError, type FolderScan, type SyncPlatform } from '../../../src/platform/sync/types';
import { knownDevices, maintain } from '../../../src/sync/maintenance';
import { META, readJson, writeJson } from '../../../src/sync/meta';
import { createMemorySyncLogger } from '../../../src/sync';
import { propagate } from '../../sim/syncCloudSim';
import { createSimDevice, pair, SCHEMA_VERSION, setupFirst, syncFolders, warmSimDevices, type SimDevice } from '../../sim/syncDevice';

/**
 * Y-TECH-02 (revue d'ensemble de fin d'ordre 4) : avertissements du scan rendus visibles, échecs qui étaient avalés (abonnés, lectures de
 * l'état local, code réel d'un cycle en échec, vérification de la fenêtre de restauration, suppressions de ses fichiers), accusés stockés
 * illisibles (une seule analyse, `state-unreadable`). Horloge manuelle, aucun délai réel.
 */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' as DeviceId;
const DAY = 86_400_000;

let devices: SimDevice[] = [];
beforeAll(() => warmSimDevices());
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

async function first(): Promise<SimDevice> {
  const a = await createSimDevice(A_ID);
  devices.push(a);
  await setupFirst(a);
  await a.cycle();
  return a;
}

const events = (d: SimDevice, name: string) => d.logger.entries.filter((e) => e.event === name).map((e) => e.detail);

/** Remplace une méthode de la plateforme partagée par le service (même objet). */
function patchScan(d: SimDevice, extra: (scan: FolderScan) => FolderScan): void {
  const platform = d.platform as unknown as SyncPlatform & Record<string, unknown>;
  const real = platform.scan.bind(platform);
  platform['scan'] = async (r: Parameters<SyncPlatform['scan']>[0]) => extra(await real(r));
}

describe('point 1 : avertissements du scan dans SyncStatus', () => {
  it('budget de nonces, dossier de plus de 1 Gio, plus de 16 dossiers, scan incomplet : avertissements rendus, dans l’ordre d’urgence', async () => {
    const a = await first();
    expect(a.service.status().warnings ?? []).toEqual([]);
    a.platform.testing.setSealedRecords(NONCE_WARN_RECORDS + 1);
    a.folder.padFolder(FOLDER_WARN_BYTES);
    patchScan(a, (scan) => ({ ...scan, incomplete: true, tooManyDevices: true }));
    const status = await a.cycle();
    expect(status.phase).toBe('idle');
    expect(status.warnings).toEqual(['nonce-budget', 'folder-large', 'too-many-devices', 'scan-incomplete']);
  });

  it('un cycle qui échoue avant le scan garde les avertissements connus ; un scan sans avertissement les retire', async () => {
    const a = await first();
    a.platform.testing.setSealedRecords(NONCE_WARN_RECORDS + 1);
    expect((await a.cycle()).warnings).toEqual(['nonce-budget']);
    const platform = a.platform as unknown as Record<string, unknown>;
    const realScan = platform['scan'];
    platform['scan'] = () => Promise.reject(new SyncPlatformError('cloud-error'));
    const failed = await a.cycle();
    expect(failed.phase).toBe('error');
    expect(failed.warnings).toEqual(['nonce-budget']);
    platform['scan'] = realScan;
    a.platform.testing.setSealedRecords(0);
    expect((await a.cycle()).warnings ?? []).toEqual([]);
  });

  it('memory.ts : folderLarge au-delà de 1 Gio, nonceWarning au-delà du seuil (même règle que Rust)', async () => {
    const a = await first();
    const before = await a.platform.scan({ keep: [] });
    expect([before.folderLarge, before.nonceWarning]).toEqual([false, false]);
    a.folder.padFolder(FOLDER_WARN_BYTES - before.totalBytes);
    expect((await a.platform.scan({ keep: [] })).folderLarge).toBe(false);
    a.folder.padFolder(1);
    expect((await a.platform.scan({ keep: [] })).folderLarge).toBe(true);
    a.platform.testing.setSealedRecords(NONCE_WARN_RECORDS);
    expect((await a.platform.scan({ keep: [] })).nonceWarning).toBe(false);
    a.platform.testing.setSealedRecords(NONCE_WARN_RECORDS + 1);
    expect((await a.platform.scan({ keep: [] })).nonceWarning).toBe(true);
  });
});

describe('point 3 : échecs avalés', () => {
  it('abonné de onRemoteChanges qui lève : journalisé sans contenu, les autres abonnés prévenus, la synchro continue', async () => {
    const a = await first();
    const b = await createSimDevice(B_ID, { clock: a.clock });
    devices.push(b);
    await pair(a, b);
    await b.cycle();
    await b.createTask('B1');
    await b.cycle();
    syncFolders([a, b]);
    const seen: number[] = [];
    a.service.onRemoteChanges(() => {
      throw new Error('écran cassé');
    });
    a.service.onRemoteChanges(() => seen.push(1));
    const status = await a.cycle();
    expect(status.phase).toBe('idle');
    expect(seen.length).toBeGreaterThan(0);
    expect(events(a, 'remote-listener-failed').length).toBe(seen.length);
    expect(JSON.stringify(a.logger.entries)).not.toContain('écran cassé');
  });

  it('lecture de l’état local en échec en fin de cycle : state-unreadable visible et journalisé, retiré à la lecture réussie suivante', async () => {
    const a = await first();
    const sync = a.data.repos.sync as unknown as Record<string, unknown>;
    const real = sync['countConflictsSince'];
    sync['countConflictsSince'] = () => Promise.reject(new Error('base occupée'));
    const status = await a.cycle();
    expect(status.stateUnreadable).toBe(true);
    expect(events(a, 'state-read-failed').length).toBeGreaterThan(0);
    sync['countConflictsSince'] = real;
    expect((await a.cycle()).stateUnreadable ?? false).toBe(false);
  });

  it('relecture de l’oubli en échec après une déclaration refusée : state-unreadable visible', async () => {
    const a = await first();
    const sync = a.data.repos.sync as unknown as Record<string, unknown>;
    const realGet = sync['getMeta'] as (key: string) => Promise<string | null>;
    const forget = a.platform.forget as unknown as Record<string, unknown>;
    forget['device'] = () => {
      sync['getMeta'] = () => Promise.reject(new Error('base occupée'));
      return Promise.reject(new SyncPlatformError('consent-denied'));
    };
    expect(await a.service.forgetDevice(C_ID)).toEqual({ kind: 'cancelled' });
    sync['getMeta'] = realGet;
    expect(a.service.status().stateUnreadable).toBe(true);
    expect(events(a, 'state-read-failed').length).toBeGreaterThan(0);
  });

  it('cycle interrompu par une erreur hors des étapes gardées : code réel, jamais « io » par défaut', async () => {
    const a = await first();
    const sync = a.data.repos.sync as unknown as Record<string, unknown>;
    sync['getStates'] = () => Promise.reject(new SyncPlatformError('vault-unavailable'));
    const status = await a.cycle();
    expect(status.phase).toBe('error');
    expect(status.errorCode).toBe('vault-unavailable');
    expect(events(a, 'cycle-crashed')).toEqual([{ code: 'vault-unavailable' }]);
  });

  it('fenêtre de restauration, scan en échec : journalisé, vérification signalée, « Appliquer partout » retiré par prudence', async () => {
    const a = await first();
    a.platform.testing.setRestoreMarker({ backup: 'b', backupTakenAt: '2026-10-05T07:00:00.000Z' as IsoDateTime, restoredAt: '2026-10-05T07:30:00.000Z' as IsoDateTime, schemaVersion: 1 });
    (a.platform as unknown as Record<string, unknown>)['scan'] = () => Promise.reject(new SyncPlatformError('cloud-error'));
    const context = await a.service.restoreContext();
    expect(context?.options).toEqual(['keep-synced']);
    expect(context?.notice).toBe('scan-failed');
    expect(events(a, 'restore-scan-failed')).toEqual([{ code: 'cloud-error' }]);
  });

  it('suppression de ses anciens instantanés en échec : journalisée (plus de .catch(() => 0))', async () => {
    const a = await first();
    (a.platform as unknown as Record<string, unknown>)['deleteOwn'] = () => Promise.reject(new SyncPlatformError('cloud-error'));
    for (let i = 0; i < 3; i += 1) {
      a.clock.advance(8 * DAY);
      await a.cycle();
    }
    expect(events(a, 'snapshot-written').length).toBeGreaterThanOrEqual(2);
    expect(events(a, 'delete-own-failed')).toContainEqual({ kind: 's', code: 'cloud-error' });
  });

  it('suppression de ses anciennes époques en échec : journalisée (plus de .catch(() => 0))', async () => {
    const a = await first();
    a.platform.testing.setRestoreMarker({ backup: 'b', backupTakenAt: '2026-10-05T07:00:00.000Z' as IsoDateTime, restoredAt: '2026-10-05T07:30:00.000Z' as IsoDateTime, schemaVersion: 1 });
    (a.platform as unknown as Record<string, unknown>)['deleteOwn'] = () => Promise.reject(new SyncPlatformError('cloud-error'));
    await a.service.chooseRestoreOption('apply-everywhere');
    await a.cycle();
    expect(events(a, 'delete-own-failed')).toContainEqual({ kind: 'epoch', code: 'cloud-error' });
    expect(events(a, 'old-epochs-deleted')).toEqual([]);
  });
});

describe('point 7 : memory.ts aligné sur Rust', () => {
  it('fichiers attendus plafonnés à 10 000 par dossier, scan incomplet au-delà (store.rs)', async () => {
    const a = await first();
    await a.createTask('A1');
    await a.cycle();
    const b = await createSimDevice(B_ID, { clock: a.clock });
    devices.push(b);
    await pair(a, b);
    // Tête authentifiée très éloignée du plus ancien segment listé : 10 004 segments annoncés et absents (état lu par B pour la première fois).
    const dir = b.folder.devices.get(a.id) as unknown as { state: { lines: { text: string }[] } };
    const line = dir.state.lines[0] as { text: string };
    const json = JSON.parse(line.text) as { head: { segment: number } };
    dir.state.lines[0] = { ...line, text: JSON.stringify({ ...json, head: { ...json.head, segment: 10_005 } }) };
    const scan = await b.platform.scan({ keep: [] });
    const scanned = scan.devices.find((d) => d.deviceId === a.id);
    expect(scanned?.stateStatus).toBe('ok');
    expect(scanned?.pending).toHaveLength(MAX_SCAN_ENTRIES_PER_FOLDER);
    expect(scan.incomplete).toBe(true);
  });
});

describe('point 4 : accusés et valeurs stockés illisibles', () => {
  it('une seule analyse (repository) : JSON corrompu ou forme invalide → SyncStateUnreadableError journalisée', () => {
    const logger = createMemorySyncLogger();
    expect(() => parseStoredAcks('{pas du json', 'sync_state.last_acks', logger)).toThrow(SyncStateUnreadableError);
    expect(() => parseStoredAcks('[1]', 'sync_state.last_acks', logger)).toThrow(SyncStateUnreadableError);
    expect(logger.entries.map((e) => e.event)).toEqual(['state-unreadable', 'state-unreadable']);
    expect(JSON.stringify(logger.entries)).not.toContain('pas du json');
    expect(parseStoredAcks('{}', 'sync_state.last_acks', logger).size).toBe(0);
  });

  it('knownDevices (purge) et readJson (sync_meta) ne lisent plus une valeur illisible comme « aucune »', async () => {
    const a = await first();
    await a.data.repos.sync.saveState(C_ID, { status: 'active', lastAcks: '{pas du json' });
    const rows = await a.data.repos.sync.getStates();
    expect(() => knownDevices(rows, a.logger)).toThrow(SyncStateUnreadableError);
    await a.data.repos.sync.setMeta('epoch', '{pas du json');
    await expect(readJson(a.data.repos, 'epoch')).rejects.toThrow(SyncStateUnreadableError);
  });

  it('cycle : accusés d’un appareil illisibles → state-unreadable, jamais « aucun accusé »', async () => {
    const a = await first();
    await a.data.repos.sync.saveState(C_ID, { status: 'active', lastAcks: '{pas du json' });
    const status = await a.cycle();
    expect(status.stateUnreadable).toBe(true);
    expect(events(a, 'state-unreadable').length).toBeGreaterThan(0);
  });

  it('« Associer de nouveau » : accusés illisibles → échec visible, rien n’est republié', async () => {
    const a = await first();
    await a.data.repos.sync.saveState(C_ID, { status: 'active', lastAcks: '{pas du json' });
    const outcome = await a.service.rejoin();
    expect(outcome.kind).toBe('failed');
    expect(await a.data.repos.settings.get('device.id')).toBe(A_ID);
  });
});

describe('revue, point 1 : fenêtre de restauration, état local illisible', () => {
  const marker = { backup: 'b', backupTakenAt: '2026-10-05T07:00:00.000Z' as IsoDateTime, restoredAt: '2026-10-05T07:30:00.000Z' as IsoDateTime, schemaVersion: 1 };
  it('sync_meta.purgeHorizon corrompu : restoreContext rejette (jamais « aucun marqueur »), journalisé, state-unreadable ; le choix échoue de façon visible', async () => {
    const a = await first();
    a.platform.testing.setRestoreMarker(marker);
    await a.data.repos.sync.setMeta('purgeHorizon', '{pas du json');
    await expect(a.service.restoreContext()).rejects.toThrow(SyncStateUnreadableError);
    expect(events(a, 'restore-context-failed')).toEqual([{ code: 'io' }]);
    expect(a.service.status().stateUnreadable).toBe(true);
    await a.service.chooseRestoreOption('keep-synced');
    expect(a.service.status().phase).toBe('error');
    expect(events(a, 'restore-choice-failed')).toEqual([{ option: 'keep-synced', code: 'io' }]);
  });

  it('marqueur illisible (plateforme en échec) : phase d’erreur avec le code réel, pas state-unreadable', async () => {
    const a = await first();
    const marker = a.platform.restoreMarker as unknown as Record<string, unknown>;
    marker['get'] = () => Promise.reject(new SyncPlatformError('vault-unavailable'));
    await expect(a.service.restoreContext()).rejects.toMatchObject({ code: 'vault-unavailable' });
    expect(a.service.status()).toMatchObject({ phase: 'error', errorCode: 'vault-unavailable' });
    expect(a.service.status().stateUnreadable ?? false).toBe(false);
  });
});

describe('seconde revue, point 6 : début de l’attente d’iCloud', () => {
  it('posé au premier cycle en attente, gardé (même après un redémarrage), retiré quand l’attente cesse', async () => {
    const a = await first();
    expect(a.service.status().waitingSince ?? null).toBeNull();
    const platform = a.platform as unknown as Record<string, unknown>;
    const realScan = platform['scan'];
    const waitOn = (): void => patchScan(a, (scan) => ({ ...scan, devices: scan.devices.map((d) => ({ ...d, pending: [{ file: 'state.ctx', availability: 'cloud' as const }] })) }));
    const startedAt = a.clock.nowMs();
    waitOn();
    expect((await a.cycle()).phase).toBe('waiting-icloud');
    expect(a.service.status().waitingSince).toBe(new Date(startedAt).toISOString());
    a.clock.advance(60_000);
    await a.restart();
    await a.cycle();
    expect(a.service.status().waitingSince, 'gardé après un redémarrage').toBe(new Date(startedAt).toISOString());
    platform['scan'] = realScan;
    expect((await a.cycle()).phase).toBe('idle');
    expect(a.service.status().waitingSince ?? null).toBeNull();
  });
});

describe('troisième revue, point M1 : début de l’attente d’iCloud stocké invalide', () => {
  it('analyse du domaine : date ISO valide lue, toute autre valeur illisible (journalisée, jamais lue comme absente)', () => {
    const logger = createMemorySyncLogger();
    expect(parseStoredIso(null, 'w', logger)).toBeNull();
    expect(parseStoredIso(JSON.stringify('2026-10-06T08:00:00.000Z'), 'w', logger)).toBe('2026-10-06T08:00:00.000Z');
    for (const raw of [JSON.stringify('pas une date'), JSON.stringify('2026-13-45T99:00:00.000Z'), '42', 'null', '{pas du json']) {
      expect(() => parseStoredIso(raw, 'w', logger), raw).toThrow(SyncStateUnreadableError);
    }
    expect(logger.entries.every((e) => e.event === 'state-unreadable')).toBe(true);
  });

  it('valeur non ISO pendant l’attente : state-unreadable visible et journalisé, valeur remplacée, retiré au cycle suivant', async () => {
    const a = await first();
    await a.data.repos.sync.setMeta('waitingSince', JSON.stringify('pas une date'));
    patchScan(a, (scan) => ({ ...scan, devices: scan.devices.map((d) => ({ ...d, pending: [{ file: 'state.ctx', availability: 'cloud' as const }] })) }));
    const status = await a.cycle();
    expect(status.phase).toBe('waiting-icloud');
    expect(status.stateUnreadable).toBe(true);
    expect(events(a, 'state-unreadable')).toContainEqual({ where: 'sync_meta.waitingSince' });
    const now = new Date(a.clock.nowMs()).toISOString();
    expect(await readJson<string>(a.data.repos, 'waitingSince')).toBe(now);
    const next = await a.cycle();
    expect(next.stateUnreadable ?? false).toBe(false);
    expect(Number.isNaN(Date.parse(next.waitingSince ?? ''))).toBe(false);
  });

  it('valeur non ISO hors attente : state-unreadable visible, valeur effacée, retiré au cycle suivant', async () => {
    const a = await first();
    await a.data.repos.sync.setMeta('waitingSince', '42');
    const status = await a.cycle();
    expect(status.phase).toBe('idle');
    expect(status.stateUnreadable).toBe(true);
    expect(await a.data.repos.sync.getMeta('waitingSince')).toBeNull();
    expect((await a.cycle()).stateUnreadable ?? false).toBe(false);
  });
});

describe('seconde revue, point 5 : analyse des valeurs stockées importée du domaine seulement', () => {
  it('le repository ne réexporte plus l’analyse (une seule porte : src/domain/sync/stored.ts)', async () => {
    const repository = await import('../../../src/db/repositories/syncRepository');
    for (const name of ['parseStoredAcks', 'parseStoredJson', 'isSyncStateUnreadable', 'SyncStateUnreadableError']) expect(name in repository, name).toBe(false);
  });
});

describe('troisième revue, point 2 : segment absent, preuve par l’état accepté de l’écrivain ; époque des accusés dans la purge', () => {
  /** Le prochain ajout de `d` est refusé une fois (`segment-full`) : le moteur ouvre le segment suivant. */
  function refuseNextAppend(d: SimDevice): void {
    const real = d.platform.appendJournal.bind(d.platform);
    let refused = false;
    d.platform.appendJournal = async (request) => {
      if (!refused) {
        refused = true;
        throw new SyncPlatformError('segment-full');
      }
      return real(request);
    };
  }
  /** Segments de `d` dans chacune de ses époques, tels que son dossier les liste. */
  const ownSegments = (d: SimDevice): number[][] => [...(d.folder.devices.get(d.id)?.epochs.values() ?? [])].map((dir) => [...dir.segments.keys()]);
  const titlesOf = async (d: SimDevice): Promise<string[]> => (await d.driver.select<{ title: string }>('SELECT title FROM task WHERE deleted_at IS NULL ORDER BY title')).map((r) => r.title);
  const resumes = (d: SimDevice, from: number): number => d.logger.entries.slice(from).filter((e) => e.event === 'resumed-from-snapshot').length;

  async function couple(): Promise<[SimDevice, SimDevice]> {
    const a = await createSimDevice(A_ID, { name: 'A' });
    devices.push(a);
    await setupFirst(a);
    await a.cycle();
    const b = await createSimDevice(B_ID, { name: 'B', clock: a.clock });
    devices.push(b);
    await pair(a, b);
    await b.cycle();
    return [a, b];
  }
  const settle = async (list: readonly SimDevice[], rounds = 2): Promise<void> => {
    for (let r = 0; r < rounds; r += 1) {
      for (const d of list) {
        syncFolders(list);
        d.clock.advance(1_000);
        await d.cycle();
      }
    }
  };
  /** A passe à j-2 (T2), puis cycles hebdomadaires : instantané couvrant, purge de j-1 si aucun lecteur ne la retient. */
  async function rotateAndAge(a: SimDevice, title: string): Promise<void> {
    refuseNextAppend(a);
    await a.createTask(title);
    await a.cycle();
    for (let i = 0; i < 3; i += 1) {
      a.clock.advance(DAY);
      await a.cycle();
    }
  }

  it('état de B jamais arrivé chez A : A purge j-1 ; dernier hlc lu de plus de 30 jours → B reprend au cycle suivant, jamais d’attente sans fin', async () => {
    const [a, b] = await couple();
    await a.createTask('T1');
    await a.cycle();
    propagate(a.folder, b.folder, a.id);
    expect((await b.cycle()).phase).toBe('idle');
    // Les fichiers de B n'arrivent jamais chez A : A ne le connaît pas.
    a.clock.advance(40 * DAY);
    await rotateAndAge(a, 'T2');
    expect(ownSegments(a)).toEqual([[2]]);
    propagate(a.folder, b.folder, a.id);
    const before = b.logger.entries.length;
    expect((await b.cycle()).phase).toBe('idle');
    expect(resumes(b, before)).toBe(1);
    expect(await titlesOf(b)).toEqual(['T1', 'T2']);
    expect((await b.cycle()).phase).toBe('idle');
    expect(resumes(b, before)).toBe(1);
  });

  it('A a accepté un état de B puis rien pendant plus de 180 jours : A expire B et purge j-1 → B reprend', async () => {
    const [a, b] = await couple();
    await a.createTask('T1');
    await b.createTask('TB');
    await settle([a, b]);
    expect(await titlesOf(a)).toEqual(['T1', 'TB']);
    // B reste actif (il lit A), mais ses fichiers n'arrivent plus chez A.
    a.clock.advance(170 * DAY);
    propagate(a.folder, b.folder, a.id);
    expect((await b.cycle()).phase).toBe('idle');
    a.clock.advance(15 * DAY);
    await rotateAndAge(a, 'T2');
    expect(ownSegments(a)).toEqual([[2]]);
    propagate(a.folder, b.folder, a.id);
    const before = b.logger.entries.length;
    expect((await b.cycle()).phase).toBe('idle');
    expect(resumes(b, before)).toBe(1);
    expect(await titlesOf(b)).toEqual(['T1', 'T2', 'TB']);
  });

  it('A connaît B (accusé récent), j-1 arrive en retard alors que le dernier hlc lu a 40 jours : B attend, puis lit tout sans reprise', async () => {
    const [a, b] = await couple();
    await a.createTask('T1');
    await settle([a, b]);
    a.clock.advance(40 * DAY);
    await b.createTask('TB');
    await b.cycle();
    propagate(b.folder, a.folder, b.id);
    await a.cycle();
    await a.createTask('T2');
    await a.cycle();
    refuseNextAppend(a);
    await a.createTask('T3');
    await a.cycle();
    expect(ownSegments(a)).toEqual([[1, 2]]);
    const [epoch] = [...(a.folder.devices.get(a.id)?.epochs.keys() ?? [])];
    expect(a.folder.devices.get(a.id)?.epochs.get(epoch as never)?.snapshots.size, 'instantané annoncé : seule la preuve retient la reprise').toBeGreaterThan(0);
    propagate(a.folder, b.folder, a.id, { drop: [`${String(epoch)}/j-00000001.ctj`] });
    const before = b.logger.entries.length;
    for (let i = 0; i < 3; i += 1) {
      expect((await b.cycle()).phase, `cycle ${String(i)}`).toBe('waiting-icloud');
      expect(await titlesOf(b)).toEqual(['T1', 'TB']);
    }
    propagate(a.folder, b.folder, a.id);
    expect((await b.cycle()).phase).toBe('idle');
    expect(await titlesOf(b)).toEqual(['T1', 'T2', 'T3', 'TB']);
    expect(resumes(b, before)).toBe(0);
  });

  it('réinitialisation : accusé de B figé dans l’époque antérieure au-delà de k → A ne purge jamais j-k de la nouvelle époque', async () => {
    const [a, b] = await couple();
    await settle([a, b]);
    await a.createTask('T0');
    await a.cycle();
    for (const title of ['T1', 'T2', 'T3']) {
      refuseNextAppend(a);
      await a.createTask(title);
      await a.cycle();
    }
    await settle([a, b]);
    await b.createTask('TB');
    await b.cycle();
    await settle([a, b]);
    a.clock.advance(11 * 60_000);
    expect((await a.service.resetSync()).kind).toBe('started');
    syncFolders([a, b]);
    expect((await b.cycle()).phase).toBe('reset-required');
    syncFolders([a, b]);
    await a.cycle();
    await a.createTask('N1');
    await a.cycle();
    refuseNextAppend(a);
    await a.createTask('N2');
    await a.cycle();
    expect(ownSegments(a).at(-1)).toEqual([1, 2]);
    // Accusé de B sur A : époque antérieure, segment 4 (> 1).
    const row = (await a.data.repos.sync.getStates()).find((r) => r.deviceId === b.id);
    expect(row?.lastAcks).toMatch(/"epoch":"e0001-[^"]+","segment":4/);
    for (let i = 0; i < 6; i += 1) {
      a.clock.advance(7 * DAY);
      syncFolders([a, b]);
      await a.cycle();
    }
    expect(events(a, 'snapshot-written').length).toBeGreaterThan(0);
    expect(ownSegments(a).at(-1), 'j-1 de la nouvelle époque, jamais lu par B : gardé').toEqual([1, 2]);
  });
});

describe('quatrième revue, point C : covered ne compte que les accusés de l’époque courante des lecteurs actifs (ADR 0011 §5.3)', () => {
  function refuseNextAppend(d: SimDevice): void {
    const real = d.platform.appendJournal.bind(d.platform);
    let refused = false;
    d.platform.appendJournal = async (request) => {
      if (!refused) {
        refused = true;
        throw new SyncPlatformError('segment-full');
      }
      return real(request);
    };
  }
  const ownSegments = (d: SimDevice): number[] => [...([...(d.folder.devices.get(d.id)?.epochs.values() ?? [])].at(-1)?.segments.keys() ?? [])];

  /** A seul, segments 1 à 5, dernier enregistrement de chacun vieux de plus de 30 jours, aucun instantané à lui retenu. */
  async function aged(): Promise<{ a: SimDevice; epoch: EpochId; run: (accepted: Map<DeviceId, PublishedDeviceState>) => Promise<void> }> {
    const a = await first();
    await a.createTask('T0');
    await a.cycle();
    for (let i = 1; i <= 4; i += 1) {
      refuseNextAppend(a);
      await a.createTask(`T${String(i)}`);
      await a.cycle();
    }
    expect(ownSegments(a)).toEqual([1, 2, 3, 4, 5]);
    a.clock.advance(31 * DAY);
    // Son instantané ne compte pas (non éligible) : seule la règle des accusés peut couvrir.
    await writeJson(a.data.repos, META.snapshot, null);
    const head = (await readJson<DeviceAck>(a.data.repos, META.head)) as DeviceAck;
    const epoch = head.epoch;
    const deps = { data: a.data, platform: a.platform, hlc: a.hlc, clock: a.clock, deviceId: a.id, devicePlatform: 'windows' as const, appVersion: '0.4.0', sv: SCHEMA_VERSION, logger: a.logger };
    const run = async (accepted: Map<DeviceId, PublishedDeviceState>): Promise<void> => {
      const scan = await a.platform.scan({ keep: [...accepted.keys()] });
      await maintain(deps, { epoch, head, accepted, ownScan: scan.devices.find((d) => d.deviceId === a.id) ?? null, rows: await a.data.repos.sync.getStates() });
    };
    return { a, epoch, run };
  }
  const stateOf = (epoch: EpochId, acks: [DeviceId, DeviceAck][]): PublishedDeviceState => ({ epoch, acks: new Map(acks) }) as unknown as PublishedDeviceState;

  it('sans lecteur actif, état d’un appareil expiré avec un accusé d’une époque antérieure au segment 50 : rien n’est purgé', async () => {
    const { a, epoch, run } = await aged();
    const older = 'e0001-cccccccc-cccc-4ccc-8ccc-cccccccccccc' as EpochId;
    await a.data.repos.sync.saveState(C_ID, { epoch, status: 'expired', lastSeenHlc: `${String(a.clock.nowMs() - 200 * DAY).padStart(15, '0')}-0000-${C_ID}` as never });
    await run(new Map([[C_ID, stateOf(epoch, [[a.id, { epoch: older, segment: 50, record: 0, hlc: null, stateSeq: 1 }]])]]));
    expect(ownSegments(a)).toEqual([1, 2, 3, 4, 5]);
  });

  it('accusé de l’époque courante venant d’un lecteur actif : segments au-delà desquels il a lu purgés', async () => {
    const { a, epoch, run } = await aged();
    const ack: DeviceAck = { epoch, segment: 4, record: 0, hlc: null, stateSeq: 1 };
    await a.data.repos.sync.saveState(C_ID, { epoch, status: 'active', lastSeenHlc: `${String(a.clock.nowMs() - DAY).padStart(15, '0')}-0000-${C_ID}` as never, lastAcks: JSON.stringify({ [a.id]: ack }) });
    await run(new Map([[C_ID, stateOf(epoch, [[a.id, ack]])]]));
    expect(ownSegments(a)).toEqual([4, 5]);
  });
});

describe('quatrième revue, point A : entrée de l’auteur dans covers (ADR 0011 §5.1)', () => {
  it('reprise de C depuis l’instantané hebdomadaire de A : curseur sur A à la tête de A, jamais à 0', async () => {
    const a = await first();
    await a.createTask('T1');
    await a.cycle();
    await a.createTask('T2');
    await a.cycle();
    a.clock.advance(8 * DAY);
    await a.cycle();
    expect(events(a, 'snapshot-written').length).toBe(1);
    const head = (await readJson<DeviceAck>(a.data.repos, META.head)) as DeviceAck;
    expect(head.segment).toBeGreaterThan(0);
    const c = await createSimDevice(C_ID, { name: 'C', clock: a.clock });
    devices.push(c);
    await pair(a, c);
    await c.cycle();
    expect(events(c, 'resumed-from-snapshot')).toHaveLength(1);
    const row = (await c.data.repos.sync.getStates()).find((r) => r.deviceId === a.id);
    expect([row?.cursorSegment, row?.cursorRecord, row?.ackHlc]).toEqual([head.segment, head.record, head.hlc]);
  });

  it('auteur sans aucune écriture publiée (tête sans hlc) : aucune entrée de l’auteur', async () => {
    const a = await first();
    a.clock.advance(8 * DAY);
    await a.cycle();
    expect(events(a, 'snapshot-written').length).toBe(1);
    const meta = await readJson<{ covers: Record<string, unknown> }>(a.data.repos, META.snapshot);
    expect(meta?.covers ?? {}).not.toHaveProperty(a.id);
  });
});

describe('quatrième revue, point D : preuve datée par l’état de nous accepté par l’écrivain (ADR 0011 §5.5, condition 3)', () => {
  function refuseNextAppend(d: SimDevice): void {
    const real = d.platform.appendJournal.bind(d.platform);
    let refused = false;
    d.platform.appendJournal = async (request) => {
      if (!refused) {
        refused = true;
        throw new SyncPlatformError('segment-full');
      }
      return real(request);
    };
  }
  const ownSegments = (d: SimDevice): number[] => [...([...(d.folder.devices.get(d.id)?.epochs.values() ?? [])].at(-1)?.segments.keys() ?? [])];
  const titlesOf = async (d: SimDevice): Promise<string[]> => (await d.driver.select<{ title: string }>('SELECT title FROM task WHERE deleted_at IS NULL ORDER BY title')).map((r) => r.title);

  it('nos journaux arrivent chez A, plus notre état : attente tant que l’état accepté a moins de 180 jours, puis A nous expire, purge j-1, et B reprend', async () => {
    const a = await first();
    const b = await createSimDevice(B_ID, { name: 'B', clock: a.clock });
    devices.push(b);
    await pair(a, b);
    await b.cycle();
    await a.createTask('T1');
    for (let r = 0; r < 2; r += 1) {
      syncFolders([a, b]);
      await a.cycle();
      await b.cycle();
    }
    expect(await titlesOf(b)).toEqual(['T1']);
    const accepted = a.clock.nowMs();
    // Désormais, l'état de B n'arrive plus chez A (iCloud lui garde l'ancien) ; ses journaux, si.
    const bToA = (): void => propagate(b.folder, a.folder, b.id, { staleState: true });
    let n = 0;
    const exchange = async (): Promise<void> => {
      n += 1;
      await b.createTask(`B${String(n)}`);
      await b.cycle();
      bToA();
      await a.cycle();
    };
    // 100 jours de synchro complète des deux côtés (B lit tout de A).
    for (let day = 0; day < 100; day += 20) {
      a.clock.advance(20 * DAY);
      await exchange();
      propagate(a.folder, b.folder, a.id);
      expect((await b.cycle()).phase).toBe('idle');
    }
    // A passe à j-2 ; j-1 n'arrive plus chez B (curseur de B dans j-1, dernier hlc lu de A vieux de 100 jours).
    refuseNextAppend(a);
    await a.createTask('T2');
    await a.cycle();
    const [epoch] = [...(a.folder.devices.get(a.id)?.epochs.keys() ?? [])];
    const toB = (): void => propagate(a.folder, b.folder, a.id, { drop: [`${String(epoch)}/j-00000001.ctj`] });
    toB();
    const before = b.logger.entries.length;
    expect((await b.cycle()).phase, 'état de B accepté par A il y a 100 jours : A ne peut pas avoir purgé j-1').toBe('waiting-icloud');
    // Jusqu'à 180 jours (moins la marge) après l'état accepté : attente, sans reprise.
    while (a.clock.nowMs() + 10 * DAY < accepted + 180 * DAY) {
      a.clock.advance(10 * DAY);
      await exchange();
      toB();
      expect((await b.cycle()).phase).toBe('waiting-icloud');
    }
    expect(b.logger.entries.slice(before).filter((e) => e.event === 'resumed-from-snapshot')).toHaveLength(0);
    // Au-delà : A expire B et purge j-1 ; B, sans preuve, applique la règle des 30 jours et reprend.
    a.clock.advance(15 * DAY);
    await exchange();
    expect(ownSegments(a)).not.toContain(1);
    toB();
    expect((await b.cycle()).phase).toBe('idle');
    expect(b.logger.entries.slice(before).filter((e) => e.event === 'resumed-from-snapshot')).toHaveLength(1);
    expect(await titlesOf(b)).toContain('T2');
  });
});

describe('quatrième revue, point D : repères illisibles', () => {
  it('sync_meta.ownStateHlcs illisible : journalisé sans contenu, réécrit à la prochaine écriture de l’état', async () => {
    const a = await first();
    await a.data.repos.sync.setMeta(META.ownStateHlcs, '{pas du json');
    await a.createTask('T1');
    await a.cycle();
    expect(events(a, 'state-unreadable')).toContainEqual({ where: 'sync_meta.ownStateHlcs' });
    const marks = await readJson<[number, string][]>(a.data.repos, META.ownStateHlcs);
    expect(marks).toHaveLength(1);
    expect(marks?.[0]?.[0]).toBeGreaterThan(0);
  });
});

describe('cinquième revue, point 5 : repères illisibles lus au début du cycle', () => {
  it('sync_meta.ownStateHlcs illisible : stateUnreadable au premier cycle, réécrit vide dans ce cycle, second cycle propre', async () => {
    const a = await first();
    await a.data.repos.sync.setMeta(META.ownStateHlcs, '{pas du json');
    const status = await a.cycle();
    expect(status.stateUnreadable).toBe(true);
    expect(events(a, 'state-unreadable')).toContainEqual({ where: 'sync_meta.ownStateHlcs' });
    expect(await readJson<unknown[]>(a.data.repos, META.ownStateHlcs)).toEqual(expect.any(Array));
    expect((await a.cycle()).stateUnreadable ?? false).toBe(false);
  });
});
