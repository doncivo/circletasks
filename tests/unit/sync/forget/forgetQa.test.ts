import { afterEach, describe, expect, it } from 'vitest';
import type { DeviceId } from '../../../../src/domain/types';
import { forgetDeletionLine } from '../../../../src/features/sync/forgetText';
import { SyncPlatformError } from '../../../../src/platform/sync/types';
import { FORGET_META, readForgetStatus } from '../../../../src/sync/forget';
import { armCrash } from '../../../sim/syncCrash';
import { mirrorDeviceFolder, propagate } from '../../../sim/syncCloudSim';
import { createSimDevice, pair, setupFirst, syncFolders, type SimDevice } from '../../../sim/syncDevice';

/**
 * Y-10, QA (critères 7 à 17, 20) : scénarios à deux, trois et quatre appareils simulés (base SQLite Wasm, vrai service, plateforme
 * mémoire dans le rôle de Rust, « iCloud » piloté par le test). Horloge commune contrôlée : aucun délai réel, aucun `setTimeout`.
 */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const X_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const GHOST = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

let devices: SimDevice[] = [];
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

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
const statusOf = (viewer: SimDevice, id: string): string | undefined => viewer.service.status().devices.find((d) => d.deviceId === id && !d.self)?.status;
const forgottenSet = (viewer: SimDevice): string[] =>
  viewer.service
    .status()
    .devices.filter((d) => d.status === 'forgotten')
    .map((d) => d.deviceId)
    .sort();
const mirrorDeletion = (from: SimDevice, id: string): void => {
  for (const d of devices) if (d !== from) mirrorDeviceFolder(from.folder, d.folder, id);
};

describe('faux dossier devices/<uuid> et appareil seulement cité : la suppression attend, visiblement (critère 13, exigence d’Ali)', () => {
  it('un dossier sans état bloque la suppression sans fin : l’attente est écrite, nomme ce dossier, survit au redémarrage et ne produit aucun échec', async () => {
    const [a, , x] = (await setup([B_ID, X_ID])) as [SimDevice, SimDevice, SimDevice];
    a.folder.addDeviceFolder(GHOST);
    expect(await a.service.forgetDevice(x.id as DeviceId)).toEqual({ kind: 'done' });
    for (let i = 0; i < 4; i += 1) {
      a.clock.advance(1_000);
      await a.cycle();
    }
    const waiting = a.service.status().forget?.deletions.find((d) => d.deviceId === x.id);
    expect(waiting).toEqual({ deviceId: x.id, state: 'waiting', waitingFor: GHOST });
    expect(a.service.status().forget?.failure ?? null).toBeNull();
    expect(a.folder.devices.has(x.id)).toBe(true);
    await a.restart();
    // Avant le premier cycle, l'attente est déjà lisible dans la base (bandeau de démarrage, A-09) ; Réglages la montre après le premier cycle.
    expect((await readForgetStatus(a.data.repos))?.deletions.find((d) => d.deviceId === x.id)?.waitingFor).toBe(GHOST);
    await a.cycle();
    expect(a.service.status().forget?.deletions.find((d) => d.deviceId === x.id)?.waitingFor).toBe(GHOST);
    await a.cycle();
    expect(a.service.status().forget?.deletions.find((d) => d.deviceId === x.id)?.state).toBe('waiting');
  });

  // QA-1 (gravité moyenne) : le faux dossier n'est PAS dans APPAREILS (aucune ligne, donc aucun « Oublier cet appareil »), alors que
  // Rust accepterait de l'oublier (`sync_forget_qa.rs`). L'utilisateur lit « en attente de PC eeee » (nom inventé : plateforme « PC » par
  // défaut) sans aucun moyen d'agir : blocage sans fin. it.fails : passera au vert (et devra être retiré) quand la ligne existera.
  it.fails('QA-1 : l’appareil attendu par la suppression a une ligne dans APPAREILS (l’utilisateur peut l’oublier)', async () => {
    const [a, , x] = (await setup([B_ID, X_ID])) as [SimDevice, SimDevice, SimDevice];
    a.folder.addDeviceFolder(GHOST);
    await a.service.forgetDevice(x.id as DeviceId);
    const waitingFor = a.service.status().forget?.deletions.find((d) => d.deviceId === x.id)?.waitingFor;
    expect(waitingFor).toBe(GHOST);
    expect(a.service.status().devices.map((d) => d.deviceId)).toContain(GHOST);
  });

  // Même défaut avec un faux dossier dont le state.ctx est présent mais illisible (copie abîmée) : ni ligne dans APPAREILS, ni action.
  it.fails('QA-1 : un faux dossier à state.ctx illisible a, lui aussi, une ligne dans APPAREILS', async () => {
    const [a, b, x] = (await setup([B_ID, X_ID])) as [SimDevice, SimDevice, SimDevice];
    const copy = a.folder.devices.get(b.id);
    expect(copy).toBeDefined();
    a.folder.devices.set(GHOST, structuredClone(copy) as NonNullable<typeof copy>);
    a.folder.corruptRecord(GHOST, 'state.ctx', 0);
    await a.service.forgetDevice(x.id as DeviceId);
    for (let i = 0; i < 4; i += 1) {
      a.clock.advance(1_000);
      await a.cycle();
    }
    expect(a.service.status().forget?.deletions.find((d) => d.deviceId === x.id)?.waitingFor).toBe(GHOST);
    expect(a.service.status().devices.map((d) => d.deviceId)).toContain(GHOST);
  });

  it('QA-1 : la ligne dit « en attente de PC eeee » pour un appareil absent de APPAREILS (nom de repli)', async () => {
    const [a, , x] = (await setup([B_ID, X_ID])) as [SimDevice, SimDevice, SimDevice];
    a.folder.addDeviceFolder(GHOST);
    await a.service.forgetDevice(x.id as DeviceId);
    const line = forgetDeletionLine(a.service.status().forget?.deletions.find((d) => d.deviceId === x.id), a.service.status().devices);
    expect(line).toContain('PC eeee');
  });

  it('un appareil dont le dossier a disparu mais qui a une ligne dans APPAREILS : l’attente le nomme, et l’oublier débloque la suppression', async () => {
    const [a, , y, x] = (await setup([B_ID, C_ID, X_ID])) as [SimDevice, SimDevice, SimDevice, SimDevice];
    // C (ici « y ») a disparu : un tiers supprime son dossier dans iCloud, chez tous.
    for (const d of devices) d.folder.devices.delete(y.id);
    expect(await a.service.forgetDevice(x.id as DeviceId)).toEqual({ kind: 'done' });
    await settle([a]);
    const waiting = a.service.status().forget?.deletions.find((d) => d.deviceId === x.id);
    expect(waiting?.state).toBe('waiting');
    expect([y.id, B_ID]).toContain(waiting?.waitingFor);
    if (waiting?.waitingFor === y.id) {
      expect(a.service.status().devices.map((d) => d.deviceId)).toContain(y.id);
      expect(statusOf(a, y.id)).not.toBe('forgotten');
      // Rien n'est supprimé, rien n'est en échec ; l'oublier est possible depuis APPAREILS.
      expect(a.folder.devices.has(x.id)).toBe(true);
      expect(await a.service.forgetDevice(y.id as DeviceId)).toEqual({ kind: 'done' });
      await settle([a]);
    }
  });
});

describe('oublis croisés à quatre appareils (critère 7)', () => {
  /** A, B, C, X ; chacun déclare hors ligne : X oublie A, puis B oublie X, puis C oublie B. */
  async function crossed(order: readonly number[]): Promise<{ viewerC: string[]; byDevice: Record<string, string[]> }> {
    const [a, b, c, x] = (await setup([B_ID, C_ID, X_ID])) as [SimDevice, SimDevice, SimDevice, SimDevice];
    expect(await x.service.forgetDevice(a.id as DeviceId)).toEqual({ kind: 'done' });
    a.clock.advance(60_000);
    expect(await b.service.forgetDevice(x.id as DeviceId)).toEqual({ kind: 'done' });
    a.clock.advance(60_000);
    expect(await c.service.forgetDevice(b.id as DeviceId)).toEqual({ kind: 'done' });
    const all = [a, b, c, x];
    const sequence = order.map((i) => all[i] as SimDevice);
    for (let r = 0; r < 4; r += 1) {
      for (const d of sequence) {
        syncFolders(all);
        d.clock.advance(1_000);
        await d.cycle();
      }
    }
    return { viewerC: forgottenSet(c), byDevice: Object.fromEntries(all.map((d) => [d.name, forgottenSet(d)])) };
  }

  it('seules les déclarations d’auteurs non oubliés comptent : A (par X) puis X (par B) puis B (par C) ; même résultat quel que soit l’ordre de lecture', async () => {
    const first = await crossed([0, 1, 2, 3]);
    // Ordre total par hlc : X→A (valide), B→X (valide : B actif), C→B (valide : C actif) : A, X et B sont oubliés, C reste.
    expect(first.viewerC).toEqual([A_ID, B_ID, X_ID].sort());
    await Promise.all(devices.map((d) => d.close()));
    devices = [];
    const second = await crossed([3, 2, 1, 0]);
    expect(second.viewerC).toEqual(first.viewerC);
    await Promise.all(devices.map((d) => d.close()));
    devices = [];
    const third = await crossed([2, 0, 3, 1]);
    expect(third.viewerC).toEqual(first.viewerC);
  });
});

describe('suppression des fichiers faite par un autre appareil actif (critère 13)', () => {
  it('chaque appareil actif supprime de son côté (même moment, dossiers séparés) sans aucune erreur', async () => {
    const [a, b, c, x] = (await setup([B_ID, C_ID, X_ID])) as [SimDevice, SimDevice, SimDevice, SimDevice];
    expect(await a.service.forgetDevice(x.id as DeviceId)).toEqual({ kind: 'done' });
    await settle([a, b, c]);
    await settle([a, b, c]);
    // Chacun décide dans son propre dossier : un ou plusieurs suppriment, aucun n'échoue ; iCloud propage ensuite les suppressions.
    const deleters = [a, b, c].filter((d) => !d.folder.devices.has(x.id));
    expect(deleters.length).toBeGreaterThanOrEqual(1);
    for (const d of [a, b, c]) expect(d.service.status().forget?.failure ?? null, d.name).toBeNull();
    for (const d of deleters) mirrorDeletion(d, x.id);
    await settle([a, b, c]);
    for (const d of [a, b, c]) {
      expect(d.folder.devices.has(x.id), d.name).toBe(false);
      expect(d.service.status().forget?.failure ?? null, d.name).toBeNull();
      expect((d.service.status().forget?.deletions ?? []).filter((l) => l.state !== 'done'), d.name).toEqual([]);
    }
  });

  it('A hors ligne : B supprime les fichiers de X ; quand iCloud propage la suppression à A, la ligne d’attente de A disparaît sans échec', async () => {
    const [a, b, c, x] = (await setup([B_ID, C_ID, X_ID])) as [SimDevice, SimDevice, SimDevice, SimDevice];
    expect(await a.service.forgetDevice(x.id as DeviceId)).toEqual({ kind: 'done' });
    // A reste hors ligne après sa déclaration ; B et C lisent, accusent ; B supprime.
    for (let r = 0; r < 4; r += 1) {
      for (const d of [b, c]) {
        propagate(a.folder, d.folder, a.id);
        propagate(b.folder, c.folder, b.id);
        propagate(c.folder, b.folder, c.id);
        propagate(x.folder, d.folder, x.id);
        d.clock.advance(1_000);
        await d.cycle();
      }
    }
    // A n'a rien supprimé : B et C attendent l'accusé de A sur l'état qui porte la déclaration, qu'ils lui doivent. A lit leurs accusés.
    for (const d of [b, c]) propagate(d.folder, a.folder, d.id);
    a.clock.advance(1_000);
    await a.cycle();
    for (const d of [b, c]) propagate(a.folder, d.folder, a.id);
    for (const d of [b, c]) {
      d.clock.advance(1_000);
      await d.cycle();
    }
    const deleter = [b, c].find((d) => !d.folder.devices.has(x.id));
    expect(deleter, 'B ou C a supprimé').toBeDefined();
    // A voit encore la ligne d'attente ; iCloud lui apporte la suppression : plus de ligne, aucun échec.
    mirrorDeviceFolder((deleter as SimDevice).folder, a.folder, x.id);
    a.clock.advance(1_000);
    await a.cycle();
    expect(a.folder.devices.has(x.id)).toBe(false);
    const line = a.service.status().forget?.deletions.find((d) => d.deviceId === x.id);
    expect(line === undefined || line.state === 'done').toBe(true);
    expect(a.service.status().forget?.failure ?? null).toBeNull();
    expect(statusOf(a, x.id)).toBe('forgotten');
    expect(await meta(a, FORGET_META.failure)).toBeNull();
  });
});

describe('appareil oublié qui revient (critères 16 et 17), quatre appareils', () => {
  it('X (hors ligne pendant l’oubli, avec des écritures au-delà de la coupure) revient : ses écritures arrivent chez A, B et C sous le nouvel identifiant, jamais sous l’ancien', async () => {
    const [a, b, c, x] = (await setup([B_ID, C_ID, X_ID])) as [SimDevice, SimDevice, SimDevice, SimDevice];
    await x.createTask('X lue');
    await settle([a, b, c, x]);
    expect(await a.service.forgetDevice(x.id as DeviceId)).toEqual({ kind: 'done' });
    // X écrit hors ligne, publie vers un iCloud qui n'a rien relivré aux autres, et en garde une autre en file.
    const beyond = await x.createTask('X au-delà');
    await x.cycle();
    for (const d of [a, b, c]) propagate(x.folder, d.folder, x.id);
    await settle([a, b, c]);
    for (const d of [a, b, c]) expect(await titles(d), d.name).not.toContain('X au-delà');
    const queued = await x.createTask('X en file');
    for (const d of [a, b, c]) propagate(d.folder, x.folder, d.id);
    expect((await x.cycle()).phase).toBe('forgotten');
    const oldId = x.id;
    expect(await x.service.rejoin()).toEqual({ kind: 'restart' });
    const newId = (await x.data.repos.settings.get('device.id')) as DeviceId;
    await x.restartAs(newId);
    await x.platform.folder.choose();
    for (const d of [a, b, c]) propagate(d.folder, x.folder, d.id);
    await settle([a, b, c, x]);
    await settle([a, b, c, x]);
    for (const d of [a, b, c, x]) expect(await titles(d), d.name).toEqual(['X au-delà', 'X en file', 'X lue']);
    const journalOf = (viewer: SimDevice, id: string): string =>
      JSON.stringify([...(viewer.folder.devices.get(id)?.epochs.values() ?? [])].flatMap((e) => [...e.segments.values()].flatMap((s) => s.lines.map((l) => l.text))));
    // Jamais sous l'ancien : ce que l'ancien identifiant a publié avant l'oubli ne contient pas les écritures rattachées.
    expect(journalOf(c, oldId)).not.toContain(queued.id);
    expect(journalOf(c, newId)).toContain(queued.id);
    expect(journalOf(c, newId)).toContain(beyond.id);
    for (const d of [a, b, c]) {
      expect(statusOf(d, oldId), d.name).toBe('forgotten');
      expect(statusOf(d, newId), d.name).toBe('active');
    }
  });

  it('X reçoit la suppression de ses propres fichiers avant d’avoir lu son oubli : il ne perd rien, ne publie rien d’inattendu et finit « oublié »', async () => {
    const [a, b, x] = (await setup([B_ID, X_ID])) as [SimDevice, SimDevice, SimDevice];
    await x.createTask('X avant');
    await settle([a, b, x]);
    expect(await a.service.forgetDevice(x.id as DeviceId)).toEqual({ kind: 'done' });
    await settle([a, b]);
    await settle([a, b]);
    expect([a, b].some((d) => !d.folder.devices.has(x.id)), 'les fichiers de X ont été supprimés').toBe(true);
    // iCloud supprime d'abord les fichiers de X chez X lui-même ; il n'a pas encore reçu l'état de A.
    x.folder.devices.delete(x.id);
    await x.createTask('X écrit après');
    const status = await x.cycle();
    // Sans rien savoir, X republie ses fichiers (son dossier a disparu chez lui) : ses écritures au-delà de la coupure ne sont lues par personne,
    // et les fichiers qui réapparaissent sont supprimés de nouveau, sans échec chez A ni chez B.
    expect(status.phase).toBe('idle');
    expect(x.folder.devices.has(x.id)).toBe(true);
    for (const d of [a, b]) propagate(x.folder, d.folder, x.id);
    for (const d of [a, b]) {
      d.clock.advance(1_000);
      await d.cycle();
    }
    for (const d of [a, b]) {
      expect(await titles(d), d.name).toEqual(['X avant']);
      expect(d.service.status().forget?.failure ?? null, d.name).toBeNull();
    }
    for (let i = 0; i < 3; i += 1) {
      for (const d of [a, b]) {
        d.clock.advance(1_000);
        await d.cycle();
      }
      syncFolders([a, b]);
    }
    expect([a, b].some((d) => !d.folder.devices.has(x.id))).toBe(true);
    for (const d of [a, b]) expect(await titles(d), d.name).toEqual(['X avant']);
    // À la réception de l'état de A, X apprend son oubli et garde tout.
    for (const d of [a, b]) propagate(d.folder, x.folder, d.id);
    x.clock.advance(1_000);
    expect((await x.cycle()).phase).toBe('forgotten');
    expect(await titles(x)).toEqual(['X avant', 'X écrit après']);
  });
});

describe('arrêt brutal pendant « Associer de nouveau » (critère 14, D2)', () => {
  const REJOIN_REFERENCE = ['X avant', 'X en file'];

  /** A, X ; X apprend son oubli et a une écriture non publiée ; renvoie A et X prêts à « Associer de nouveau ». */
  async function forgottenX(): Promise<[SimDevice, SimDevice]> {
    const [a, x] = (await setup([X_ID])) as [SimDevice, SimDevice];
    await x.createTask('X avant');
    await settle([a, x]);
    expect(await a.service.forgetDevice(x.id as DeviceId)).toEqual({ kind: 'done' });
    await settle([a]);
    propagate(a.folder, x.folder, a.id);
    expect((await x.cycle()).phase).toBe('forgotten');
    await x.createTask('X en file');
    return [a, x];
  }

  /** Reprise : redémarrage sous l'identité de la base, un cycle (reprend un « Associer de nouveau » interrompu), puis fin du parcours. */
  async function finish(a: SimDevice, x: SimDevice, oldId: string): Promise<void> {
    const current = (await x.data.repos.settings.get('device.id')) as DeviceId;
    await x.restartAs(current);
    x.clock.advance(1_000);
    await x.cycle();
    if (current === oldId && (await x.data.repos.sync.getMeta(FORGET_META.rejoin)) === null) {
      // Rien n'avait été enregistré : l'utilisateur recommence.
      expect(await x.service.rejoin()).toEqual({ kind: 'restart' });
    }
    const fresh = (await x.data.repos.settings.get('device.id')) as DeviceId;
    await x.restartAs(fresh);
    await x.platform.folder.choose();
    propagate(a.folder, x.folder, a.id);
    await settle([a, x]);
    await settle([a, x]);
  }

  it('référence : sans arrêt, écritures comptées, X finit sous un nouvel identifiant avec ses données', async () => {
    const [a, x] = await forgottenX();
    const oldId = x.id;
    const probe = armCrash(x, null);
    expect(await x.service.rejoin()).toEqual({ kind: 'restart' });
    probe.disarm();
    expect(probe.writes).toBeGreaterThan(0);
    await finish(a, x, oldId);
    expect(await titles(x)).toEqual(REJOIN_REFERENCE);
    expect(await titles(a)).toEqual(REJOIN_REFERENCE);
    expect(statusOf(a, oldId)).toBe('forgotten');
  });

  it('arrêt avant chacune des écritures de « Associer de nouveau » : reprise sans perte, un seul nouvel identifiant, état final identique', async () => {
    // Nombre d'écritures mesuré sur une exécution sans arrêt.
    const [a0, x0] = await forgottenX();
    const probe = armCrash(x0, null);
    await x0.service.rejoin();
    probe.disarm();
    const writes = probe.writes;
    await Promise.all(devices.map((d) => d.close()));
    devices = [];
    expect(writes).toBeGreaterThan(0);
    void a0;
    for (let n = 1; n <= writes; n += 1) {
      const [a, x] = await forgottenX();
      const oldId = x.id;
      const crash = armCrash(x, n);
      await x.service.rejoin();
      expect(crash.crashed, `écriture ${String(n)}`).toBe(true);
      crash.disarm();
      await finish(a, x, oldId);
      expect(await titles(x), `arrêt avant l'écriture ${String(n)}`).toEqual(REJOIN_REFERENCE);
      expect(await titles(a), `arrêt avant l'écriture ${String(n)}`).toEqual(REJOIN_REFERENCE);
      expect(x.id).not.toBe(oldId);
      expect(statusOf(a, oldId), `ancien identifiant, écriture ${String(n)}`).toBe('forgotten');
      expect(statusOf(a, x.id), `nouvel identifiant, écriture ${String(n)}`).toBe('active');
      expect(await meta(x, FORGET_META.failure), `échec gardé, écriture ${String(n)}`).toBeNull();
      expect(await meta(x, FORGET_META.rejoin), `intention soldée, écriture ${String(n)}`).toBeNull();
      await Promise.all(devices.map((d) => d.close()));
      devices = [];
    }
  });

  it('la délie échoue après la transaction : l’échec est écrit, visible après redémarrage, et le cycle suivant reprend sans nouvel identifiant', async () => {
    const [a, x] = await forgottenX();
    const oldId = x.id;
    const real = x.platform.folder.forget;
    (x.platform.folder as { forget: typeof real }).forget = () => Promise.reject(new SyncPlatformError('folder-unreachable'));
    expect(await x.service.rejoin()).toEqual({ kind: 'failed', code: 'folder-unreachable' });
    const afterFailure = (await x.data.repos.settings.get('device.id')) as DeviceId;
    expect(x.service.status().forget?.failure).toMatchObject({ code: 'folder-unreachable', step: 'rejoin' });
    await x.restartAs(afterFailure);
    expect((await readForgetStatus(x.data.repos))?.failure).toMatchObject({ code: 'folder-unreachable', step: 'rejoin' });
    (x.platform.folder as { forget: typeof real }).forget = real;
    x.clock.advance(1_000);
    await x.cycle();
    expect(await meta(x, FORGET_META.rejoin)).toBeNull();
    expect(x.service.status().forget?.failure ?? null).toBeNull();
    expect((await x.data.repos.settings.get('device.id')) as DeviceId).toBe(afterFailure);
    expect(afterFailure).not.toBe(oldId);
    void a;
  });
});
