import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FOLDER_WARN_BYTES, MAX_SCAN_ENTRIES_PER_FOLDER, NONCE_WARN_RECORDS } from '../../../src/domain/sync/limits';
import type { DeviceId, IsoDateTime } from '../../../src/domain/types';
import { parseStoredAcks, parseStoredIso, SyncStateUnreadableError } from '../../../src/domain/sync/stored';
import { SyncPlatformError, type FolderScan, type SyncPlatform } from '../../../src/platform/sync/types';
import { knownDevices } from '../../../src/sync/maintenance';
import { readJson } from '../../../src/sync/meta';
import { createMemorySyncLogger } from '../../../src/sync';
import { createSimDevice, pair, setupFirst, syncFolders, warmSimDevices, type SimDevice } from '../../sim/syncDevice';

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
