import { afterEach, describe, expect, it } from 'vitest';
import { epochId, type PublishedDeviceState } from '../../../../src/domain/sync/format';
import { hlcDevice } from '../../../../src/domain/sync/parse';
import type { DeviceId, TaskId } from '../../../../src/domain/types';
import type { StateFileCopy } from '../../../../src/platform/sync/memory';
import { SyncPlatformError } from '../../../../src/platform/sync/types';
import { FORGET_META } from '../../../../src/sync/forget';
import { mirrorDeviceFolder, propagate } from '../../../sim/syncCloudSim';
import { createSimDevice, pair, setupFirst, syncFolders, type SimDevice } from '../../../sim/syncDevice';

/**
 * Y-10 critères 8, 9, 10, 13, 15, 16 et 17 (ADR 0011 §14.2) par simulation : appareils complets (base SQLite Wasm, vrai service, plateforme
 * mémoire dans le rôle de Rust), « iCloud » piloté par le test. Horloge commune contrôlée : aucun délai réel, 30 jours par l'horloge.
 */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const X_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const DAY = 86_400_000;

let devices: SimDevice[] = [];
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

/** A (premier appareil), puis les autres associés à A ; tous synchronisés. */
async function setup(ids: readonly string[]): Promise<SimDevice[]> {
  const a = await createSimDevice(A_ID, { name: 'A' });
  devices = [a];
  await setupFirst(a);
  expect((await a.cycle()).phase).toBe('idle');
  for (const id of ids) {
    const d = await createSimDevice(id, { name: id.slice(0, 1).toUpperCase(), clock: a.clock });
    devices.push(d);
    await pair(a, d);
    expect((await d.cycle()).phase).toBe('idle');
    syncFolders(devices);
  }
  await settle(devices);
  return devices;
}

/** Quelques tours : iCloud à jour, puis un cycle de chaque appareil. */
async function settle(list: readonly SimDevice[], rounds = 3): Promise<void> {
  for (let r = 0; r < rounds; r += 1) {
    for (const d of list) {
      syncFolders(list);
      d.clock.advance(1_000);
      await d.cycle();
    }
  }
}

const titles = async (d: SimDevice): Promise<string[]> => (await d.driver.select<{ title: string }>('SELECT title FROM task ORDER BY title')).map((r) => r.title);
const meta = async (d: SimDevice, key: string): Promise<unknown> => {
  const raw = await d.data.repos.sync.getMeta(key);
  return raw === null ? null : (JSON.parse(raw) as unknown);
};
const publishedForgotten = (from: SimDevice, of: SimDevice): string[] => {
  const file = from.folder.devices.get(of.id)?.state;
  const state = file ? (JSON.parse(file.lines[0]?.text ?? '{}') as { forgotten?: { deviceId: string }[] }) : {};
  return (state.forgotten ?? []).map((f) => f.deviceId);
};
/** Suppression faite par `from` : iCloud la propage à tous les autres dossiers. */
const mirrorDeletion = (from: SimDevice, id: string): void => {
  for (const d of devices) if (d !== from) mirrorDeviceFolder(from.folder, d.folder, id);
};

describe('coupure au maximum des accusés, à trois appareils actifs (critère 8)', () => {
  it('B avait lu X plus loin que A ; A oublie X ; A, B et C finissent avec exactement les mêmes écritures de X ; puis ses fichiers sont supprimés', async () => {
    const [a, b, c, x] = (await setup([B_ID, C_ID, X_ID])) as [SimDevice, SimDevice, SimDevice, SimDevice];
    await x.createTask('X1');
    await x.cycle();
    for (const d of [a, b, c]) propagate(x.folder, d.folder, x.id);
    for (const d of [a, b, c]) await d.cycle();
    // X écrit deux tâches, seul B les reçoit (A et C sont hors ligne pour X).
    await x.createTask('X2');
    await x.createTask('X3');
    x.clock.advance(1_000);
    await x.cycle();
    propagate(x.folder, b.folder, x.id);
    await b.cycle();
    expect(await titles(b)).toEqual(['X1', 'X2', 'X3']);
    expect(await titles(a)).toEqual(['X1']);

    // A oublie X (boîte de l'app, puis confirmation native acceptée) sans avoir vu l'accusé de B.
    expect(await a.service.forgetDevice(x.id as DeviceId)).toEqual({ kind: 'done' });
    expect(publishedForgotten(a, a)).toEqual([x.id]);
    expect(a.service.status().devices.find((d) => d.deviceId === x.id)?.status).toBe('forgotten');
    // Suppression en attente : la ligne nomme un appareil actif qui n'a pas encore accusé.
    const pendingLine = a.service.status().forget?.deletions.find((d) => d.deviceId === x.id);
    expect(pendingLine?.state).toBe('waiting');
    expect([b.id, c.id]).toContain(pendingLine?.waitingFor);

    // X, qui ne sait rien encore, écrit encore et publie partout.
    await x.createTask('X4');
    x.clock.advance(1_000);
    await x.cycle();
    for (const d of [a, b, c]) propagate(x.folder, d.folder, x.id);
    // B apprend l'oubli : il s'arrête à sa position (X3), jamais X4.
    propagate(a.folder, b.folder, a.id);
    await b.cycle();
    expect(await titles(b)).toEqual(['X1', 'X2', 'X3']);
    // A et C apprennent l'accusé de B : la coupure monte jusqu'à X3, jamais au-delà.
    await settle([a, b, c]);
    for (const d of [a, b, c]) expect(await titles(d), d.name).toEqual(['X1', 'X2', 'X3']);

    // Tous ont accusé la coupure et l'état de A : un appareil actif supprime les fichiers de X (aucune boîte), iCloud propage.
    await settle([a, b, c]);
    const deleter = [a, b, c].find((d) => !d.folder.devices.has(x.id)) as SimDevice;
    expect(deleter).toBeDefined();
    mirrorDeletion(deleter, x.id);
    await settle([a, b, c]);
    for (const d of [a, b, c]) {
      expect(d.folder.devices.has(x.id), d.name).toBe(false);
      expect(d.service.status().forget?.deletions ?? [], d.name).toEqual([]);
      expect(d.service.status().devices.find((s) => s.deviceId === x.id)?.status, d.name).toBe('forgotten');
    }
  });
});

describe('déclarations authentifiées seulement (critère 9, D5)', () => {
  it('un faux state.ctx étranger qui prétend oublier A et B n’oublie personne et ne coupe personne', async () => {
    const [a, b] = (await setup([B_ID])) as [SimDevice, SimDevice];
    const fake: StateFileCopy = {
      deviceId: C_ID,
      file: {
        header: { f: 'ct-state', sm: 1, kid: '0123456789abcdef', dev: C_ID as DeviceId, e: epochId(1, a.id), n: 9 },
        lines: [{ sm: 1, sv: 17, text: JSON.stringify({ deviceId: C_ID, forgotten: [{ deviceId: a.id, at: `001790000000000-0000-${C_ID}`, lastAck: null }] }), bytes: 4_200, corrupt: false }],
        partialTail: false,
        availability: 'local',
        extraBytes: 0,
      } as never,
    };
    for (const d of [a, b]) d.folder.putState(fake);
    await b.createTask('B1');
    await settle([a, b]);
    for (const d of [a, b]) {
      expect(d.service.status().phase, d.name).not.toBe('forgotten');
      expect(d.service.status().devices.filter((s) => s.status === 'forgotten'), d.name).toEqual([]);
    }
    expect(await titles(a)).toEqual(['B1']);
  });
});

describe('effets chez tous les appareils (critère 10)', () => {
  it('la trace d’une suppression que X n’avait pas lue est purgée dès que les autres l’ont lue et 30 jours écoulés, sans attendre 180 jours', async () => {
    const [a, b, x] = (await setup([B_ID, X_ID])) as [SimDevice, SimDevice, SimDevice];
    const task = await a.createTask('À supprimer');
    await settle([a, b, x]);
    // X est perdu : plus aucune recopie vers lui ni depuis lui.
    await a.deleteTask(task.id);
    await settle([a, b]);
    a.clock.advance(31 * DAY);
    await settle([a, b]);
    const rows = async (): Promise<number> => (await a.driver.select('SELECT id FROM task WHERE id = ?', [task.id])).length;
    expect(await rows()).toBe(1);
    expect(await a.service.forgetDevice(x.id as DeviceId)).toEqual({ kind: 'done' });
    await settle([a, b]);
    expect(await rows()).toBe(0);
  });

  it('le bandeau « Mettez à jour l’app » de Y-07 disparaît pour un appareil oublié', async () => {
    const [a, b, x] = (await setup([B_ID, X_ID])) as [SimDevice, SimDevice, SimDevice];
    // X publie un état d'une majeure plus récente : lecture suspendue, « Mettez à jour l'app ».
    const copy = x.folder.takeState(x.id);
    const newer = copy.file as unknown as { header: { sm: number } };
    newer.header.sm = 2;
    for (const d of [a, b]) d.folder.putState(copy);
    await a.cycle();
    expect(a.service.status().phase).toBe('update-required');
    expect(await a.service.forgetDevice(x.id as DeviceId)).toEqual({ kind: 'done' });
    expect(a.service.status().phase).not.toBe('update-required');
    expect(a.service.status().devices.find((d) => d.deviceId === x.id)?.status).toBe('forgotten');
  });
});

describe('un oubli ne s’annule pas', () => {
  it('ancien état de X rejoué, ou état de A devenu illisible : X reste oublié partout (déclarations gardées)', async () => {
    const [a, b, x] = (await setup([B_ID, X_ID])) as [SimDevice, SimDevice, SimDevice];
    const oldX = x.folder.takeState(x.id);
    await x.createTask('X1');
    await settle([a, b, x]);
    expect(await a.service.forgetDevice(x.id as DeviceId)).toEqual({ kind: 'done' });
    await settle([a, b]);
    for (const d of [a, b]) d.folder.putState(oldX);
    // L'état de A qui porte la déclaration est remplacé par un tiers chez B.
    b.folder.putState({ deviceId: a.id, file: null });
    await settle([b], 2);
    await settle([a], 1);
    for (const d of [a, b]) expect(d.service.status().devices.find((s) => s.deviceId === x.id)?.status, d.name).toBe('forgotten');
  });
});

describe('aucun échec silencieux (critère 15)', () => {
  it('boîte refusée : « annulé », rien d’écrit ni gardé ; pas au premier plan : échec persistant, visible après redémarrage, effacé à la réussite', async () => {
    const [a, , x] = (await setup([B_ID, X_ID])) as [SimDevice, SimDevice, SimDevice];
    a.platform.testing.setConsent(false);
    expect(await a.service.forgetDevice(x.id as DeviceId)).toEqual({ kind: 'cancelled' });
    expect(await meta(a, FORGET_META.failure)).toBeNull();
    expect(await meta(a, FORGET_META.publish)).toBeNull();
    expect(a.platform.testing.forgottenDeclarations()).toEqual([]);
    a.platform.testing.setConsent(true);
    a.clock.advance(10 * 60_000);
    a.platform.testing.setForeground(false);
    expect(await a.service.forgetDevice(x.id as DeviceId)).toEqual({ kind: 'failed', code: 'not-foreground' });
    expect(a.service.status().forget?.failure).toMatchObject({ deviceId: x.id, code: 'not-foreground', step: 'declare' });
    await a.restart();
    await a.cycle();
    expect(a.service.status().forget?.failure).toMatchObject({ deviceId: x.id, code: 'not-foreground' });
    expect(JSON.stringify(await meta(a, FORGET_META.failure))).not.toMatch(/[\\/]|CircleTasks/);
    a.platform.testing.setForeground(true);
    expect(await a.service.forgetDevice(x.id as DeviceId)).toEqual({ kind: 'done' });
    expect(a.service.status().forget?.failure ?? null).toBeNull();
  });

  it('suppression refusée par « Rust » (dossier injoignable) : échec gardé et visible, sans arrêter le cycle, effacé à la réussite', async () => {
    // Deux appareils : A seul actif après l'oubli, la suppression est possible dès la publication de la déclaration.
    const [a, x] = (await setup([X_ID])) as [SimDevice, SimDevice];
    const real = a.platform.forget.deleteFiles;
    (a.platform.forget as { deleteFiles: typeof real }).deleteFiles = () => Promise.reject(new SyncPlatformError('folder-unreachable'));
    expect(await a.service.forgetDevice(x.id as DeviceId)).toEqual({ kind: 'done' });
    expect(a.service.status().forget?.failure).toMatchObject({ deviceId: x.id, code: 'folder-unreachable', step: 'delete' });
    expect(a.service.status().phase).toBe('idle');
    await a.restart();
    await a.cycle();
    expect(a.service.status().forget?.failure).toMatchObject({ deviceId: x.id, code: 'folder-unreachable', step: 'delete' });
    expect(a.folder.devices.has(x.id)).toBe(true);
    (a.platform.forget as { deleteFiles: typeof real }).deleteFiles = real;
    await a.cycle();
    expect(a.service.status().forget ?? null).toBeNull();
    expect(a.folder.devices.has(x.id)).toBe(false);
  });
});

describe('appareil oublié qui revient (critères 16 et 17)', () => {
  it('X apprend son oubli : il ne lit ni ne publie plus, garde sa base et sa file ; « Associer de nouveau » publie ses écritures sous un nouvel identifiant, jamais sous l’ancien', async () => {
    const [a, b, x] = (await setup([B_ID, X_ID])) as [SimDevice, SimDevice, SimDevice];
    await x.createTask('X avant');
    await settle([a, b, x]);
    expect(await a.service.forgetDevice(x.id as DeviceId)).toEqual({ kind: 'done' });
    await settle([a, b]);
    // Hors ligne, X a publié une écriture que personne ne lira (au-delà de la coupure), et en garde une autre non publiée.
    const ignored = await x.createTask('X ignorée');
    await x.cycle();
    for (const d of [a, b]) propagate(x.folder, d.folder, x.id);
    await settle([a, b]);
    expect(await titles(a)).not.toContain('X ignorée');
    const queued = await x.createTask('X en file');
    const xFiles = x.folder.fileNames(x.id);
    // X reçoit le dossier : il apprend son oubli.
    for (const d of [a, b]) propagate(d.folder, x.folder, d.id);
    const status = await x.cycle();
    expect(status.phase).toBe('forgotten');
    x.clock.advance(1_000);
    expect((await x.cycle()).phase).toBe('forgotten');
    expect(x.folder.fileNames(x.id)).toEqual(xFiles);
    expect(await x.data.repos.sync.outboxCount()).toBeGreaterThan(0);
    expect(await titles(x)).toEqual(['X avant', 'X en file', 'X ignorée']);

    // « Associer de nouveau » : nouvel identifiant, dossier délié (clé gardée), relance, dossier choisi de nouveau, fusion.
    const oldId = x.id;
    expect(await x.service.rejoin()).toEqual({ kind: 'restart' });
    const newId = (await x.data.repos.settings.get('device.id')) as DeviceId;
    expect(newId).not.toBe(oldId);
    expect(await x.platform.folder.info()).toMatchObject({ configured: false });
    expect(await x.platform.key.status()).toMatchObject({ present: true });
    await x.restartAs(newId);
    await x.platform.folder.choose();
    for (const d of [a, b]) propagate(d.folder, x.folder, d.id);
    expect((await x.cycle()).phase).not.toBe('forgotten');
    await settle([a, b, x]);
    for (const d of [a, b, x]) expect(await titles(d), d.name).toEqual(['X avant', 'X en file', 'X ignorée']);
    // Les écritures de X au-delà de la coupure arrivent par le journal du nouvel identifiant, rattachées à lui ; l'ancien reste oublié.
    const clock = await a.driver.select<{ hlc: string }>("SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = ? AND field = 'title'", [ignored.id]);
    const rowHlc = await a.driver.select<{ hlc: string }>('SELECT hlc FROM task WHERE id = ?', [queued.id]);
    expect([...clock, ...rowHlc].every((r) => hlcDevice(r.hlc as never) === newId)).toBe(true);
    const journalOf = (id: string): string => JSON.stringify([...(a.folder.devices.get(id)?.epochs.values() ?? [])].flatMap((e) => [...e.segments.values()].flatMap((s) => s.lines.map((l) => l.text))));
    expect(journalOf(newId)).toContain(queued.id);
    expect(publishedForgotten(a, a)).toEqual([oldId]);
    expect(a.service.status().devices.find((d) => d.deviceId === oldId)?.status).toBe('forgotten');
    expect(a.service.status().devices.find((d) => d.deviceId === newId)?.status).toBe('active');
    const xNew = (await x.data.repos.sync.getStates()).find((r) => r.isSelf);
    expect(xNew?.deviceId).toBe(newId);
    expect((await x.task(ignored.id as TaskId))?.title).toBe('X ignorée');
  });
});

describe('oublis croisés (critère 7, simulation)', () => {
  it('A et X s’oublient l’un l’autre hors ligne : seule la plus ancienne déclaration compte, même résultat sur tous les appareils', async () => {
    const [a, b, x] = (await setup([B_ID, X_ID])) as [SimDevice, SimDevice, SimDevice];
    // X déclare le premier (plus ancien), A ensuite sans avoir vu la déclaration de X.
    expect(await x.service.forgetDevice(a.id as DeviceId)).toEqual({ kind: 'done' });
    x.clock.advance(60_000);
    expect(await a.service.forgetDevice(x.id as DeviceId)).toEqual({ kind: 'done' });
    await settle([a, b, x]);
    expect(a.service.status().phase).toBe('forgotten');
    for (const d of [b, x]) {
      expect(d.service.status().phase, d.name).not.toBe('forgotten');
      expect(d.service.status().devices.find((s) => s.deviceId === a.id)?.status, d.name).toBe('forgotten');
      expect(d.service.status().devices.find((s) => s.deviceId === x.id && !s.self)?.status ?? 'active', d.name).toBe('active');
    }
  });
});

describe('aucun échec silencieux : chemins d’erreur de forget.ts (critère 15 c)', () => {
  it('chaque catch de forget.ts écrit forgetFailure, rend un échec ou relance ; aucun console.*, aucun catch vide', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../../../../src/sync/forget.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/console\./);
    expect(source).not.toMatch(/catch\s*(\([^)]*\))?\s*\{\s*\}/);
    // Corps de chaque `catch (…) { … }` (accolades équilibrées).
    const blocks: string[] = [];
    for (const m of source.matchAll(/\bcatch\s*(?:\([^)]*\))?\s*\{/g)) {
      let depth = 1;
      let i = (m.index ?? 0) + m[0].length;
      const start = i;
      while (depth > 0 && i < source.length) {
        if (source[i] === '{') depth += 1;
        if (source[i] === '}') depth -= 1;
        i += 1;
      }
      blocks.push(source.slice(start, i - 1));
    }
    expect(blocks.length).toBeGreaterThanOrEqual(5);
    for (const body of blocks) {
      const handled = /recordFailure|kind: 'failed'|kind: 'cancelled'|throw |return \{ kind/.test(body) || /accusés illisibles/.test(body);
      expect(handled, body).toBe(true);
    }
    // Promesses : un échec n'est jamais avalé sans trace (seul l'enregistrement d'un échec déjà rendu peut l'être).
    for (const m of source.matchAll(/\.catch\(([^)]*\)[^)]*)\)/g)) expect(m[0], m[0]).toMatch(/\.catch\(\(\) => undefined\)/);
    expect([...source.matchAll(/\.catch\(\(\) => undefined\)/g)].length).toBeLessThanOrEqual(1);
  });
});

describe('journaux sans contenu (critère 19)', () => {
  it('événements forget-declared, forget-applied, forgotten-delete : identifiants d’appareil, codes et nombres seulement', async () => {
    const [a, x] = (await setup([X_ID])) as [SimDevice, SimDevice];
    await x.createTask('Titre secret de X');
    await settle([a, x]);
    expect(await a.service.forgetDevice(x.id as DeviceId)).toEqual({ kind: 'done' });
    await settle([a]);
    const events = a.logger.entries.filter((e) => /forget|forgotten/.test(e.event));
    expect(events.map((e) => e.event)).toEqual(expect.arrayContaining(['forget-declared', 'forget-applied', 'forgotten-delete']));
    for (const e of events) {
      for (const value of Object.values(e.detail)) {
        expect(value === null || typeof value === 'number' || typeof value === 'boolean' || /^[0-9a-f-]{36}$|^[a-z-]{1,32}$/.test(String(value)), `${e.event} : ${String(value)}`).toBe(true);
      }
    }
    expect(JSON.stringify(a.logger.entries)).not.toMatch(/Titre secret|CircleTasks|[\\]/);
  });
});

describe('table de cas de l’état publié', () => {
  it('l’état publié par A porte sa déclaration une seule fois, même après plusieurs cycles et un redémarrage', async () => {
    const [a, , x] = (await setup([B_ID, X_ID])) as [SimDevice, SimDevice, SimDevice];
    await a.service.forgetDevice(x.id as DeviceId);
    await a.restart();
    await settle([a]);
    const state = JSON.parse(a.folder.devices.get(a.id)?.state?.lines[0]?.text ?? '{}') as Pick<PublishedDeviceState, 'forgotten'>;
    expect(state.forgotten.map((f) => f.deviceId)).toEqual([x.id]);
  });
});
