import { afterEach, describe, expect, it } from 'vitest';
import type { DeviceId } from '../../../../src/domain/types';
import { currentPurgeHorizon } from '../../../../src/sync';
import { armCrash } from '../../../sim/syncCrash';
import { mirrorDeviceFolder, propagate, segmentPath } from '../../../sim/syncCloudSim';
import { createSimDevice, pair, setupFirst, syncFolders, taskSnapshot, type SimDevice } from '../../../sim/syncDevice';

/**
 * Y-10, seconde revue (ADR 0011 §18 points 11 à 13), simulations exigées : (1) instantané plus récent mais non couvrant écarté à
 * l'arrivée ; (2) aucun instantané éligible : arrivée en attente visible, puis terminée ; (3) fantôme revenu avec un trou : reprise,
 * aucun instantané écrit avant sa fin ; (4) oubli annulé avant et après la suppression ; (5) arrêts autour de la condition (h).
 * Appareils complets (base SQLite Wasm, vrai service, plateforme mémoire dans le rôle de Rust), « iCloud » piloté par le test, horloge
 * commune contrôlée : aucun délai réel.
 */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const X_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const N_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const F_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const DAY = 86_400_000;

let devices: SimDevice[] = [];
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

async function first(): Promise<SimDevice> {
  const a = await createSimDevice(A_ID, { name: 'A' });
  devices = [a];
  await setupFirst(a);
  await a.cycle();
  return a;
}

async function join(owner: SimDevice, id: string): Promise<SimDevice> {
  const d = await createSimDevice(id, { name: id.slice(0, 1).toUpperCase(), clock: owner.clock });
  devices.push(d);
  await pair(owner, d);
  await d.cycle();
  return d;
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

const titles = async (d: SimDevice): Promise<string[]> => (await d.driver.select<{ title: string }>('SELECT title FROM task WHERE deleted_at IS NULL ORDER BY title')).map((r) => r.title);
const meta = async (d: SimDevice, key: string): Promise<unknown> => {
  const raw = await d.data.repos.sync.getMeta(key);
  return raw === null ? null : (JSON.parse(raw) as unknown);
};
const events = (d: SimDevice, name: string): Record<string, unknown>[] => d.logger.entries.filter((e) => e.event === name).map((e) => e.detail as Record<string, unknown>);
const lastSegment = (d: SimDevice): string => {
  const [epoch, dir] = [...(d.folder.devices.get(d.id)?.epochs ?? new Map())].at(-1) as [string, { segments: Map<number, unknown> }];
  return segmentPath(epoch, Math.max(...dir.segments.keys()));
};

describe('(1) instantané plus récent mais non couvrant : jamais pris à l’arrivée', () => {
  it('B écrit un instantané avant d’avoir lu X jusqu’à la coupure, plus récent que celui de A ; A supprime X ; N prend celui de A, bases identiques', async () => {
    const a = await first();
    const b = await join(a, B_ID);
    const x = await join(a, X_ID);
    await x.createTask('X1');
    await settle([a, b, x]);
    // X2 n'arrive que chez A.
    await x.createTask('X2');
    await x.cycle();
    propagate(x.folder, a.folder, x.id);
    await a.cycle();
    // Huit jours plus tard, A oublie X : il écrit un instantané couvrant (aucun éligible) ; A écrit aussi A2.
    a.clock.advance(8 * DAY);
    expect(await a.service.forgetDevice(x.id as DeviceId)).toEqual({ kind: 'done' });
    await a.createTask('A2');
    await a.cycle();
    expect(events(a, 'snapshot-written').length).toBeGreaterThan(0);
    // B, qui ne sait rien encore, écrit son instantané de 7 jours (plus récent), avec X1 seulement.
    a.clock.advance(60_000);
    await b.cycle();
    expect(events(b, 'snapshot-written').length).toBe(1);
    // B apprend l'oubli et lit X jusqu'à la coupure ; le segment de A2 n'est pas encore arrivé : B ne finit pas son cycle (aucun nouvel
    // instantané), il accuse la coupure et republie la déclaration.
    propagate(x.folder, b.folder, x.id);
    propagate(a.folder, b.folder, a.id, { drop: [lastSegment(a)] });
    await b.cycle();
    expect(await titles(b)).toEqual(['X1', 'X2']);
    expect(events(b, 'snapshot-written').length).toBe(1);
    // A supprime X (condition (h) : son instantané couvre X).
    propagate(b.folder, a.folder, b.id);
    a.clock.advance(1_000);
    await a.cycle();
    expect(a.folder.devices.has(x.id)).toBe(false);
    // N arrive : dossiers de A (sans X) et de B (instantané plus récent, non couvrant).
    const n = await createSimDevice(N_ID, { name: 'N', clock: a.clock });
    devices.push(n);
    await pair(a, n);
    propagate(b.folder, n.folder, b.id);
    await n.cycle();
    expect(events(n, 'resumed-from-snapshot').map((e) => e['from'])).toEqual([a.id]);
    expect(events(n, 'forget-gap')).toEqual([]);
    expect(await titles(n)).toEqual(['A2', 'X1', 'X2']);
    mirrorDeviceFolder(a.folder, b.folder, x.id);
    await settle([a, b, n]);
    expect(await taskSnapshot(n)).toEqual(await taskSnapshot(a));
    expect(await taskSnapshot(b)).toEqual(await taskSnapshot(a));
  });
});

describe('(2) aucun instantané éligible : arrivée en attente visible', () => {
  it('seul éligible écrit par A, puis A oublié : N attend (join.failure, texte « Aucun instantané à jour »), B écrit un éligible, N termine', async () => {
    const a = await first();
    const b = await join(a, B_ID);
    const x = await join(a, X_ID);
    await x.createTask('X1');
    await settle([a, b, x]);
    // B écrit un instantané (règle des 7 jours) avant X2.
    a.clock.advance(8 * DAY);
    await b.cycle();
    expect(events(b, 'snapshot-written').length).toBe(1);
    await x.createTask('X2');
    await x.cycle();
    propagate(x.folder, a.folder, x.id);
    propagate(x.folder, b.folder, x.id);
    a.clock.advance(1_000);
    await a.cycle();
    expect(await titles(a)).toEqual(['X1', 'X2']);
    // A oublie X et écrit le seul instantané éligible ; B s'arrête avant d'écrire le sien (son état accuse la coupure).
    expect(await a.service.forgetDevice(x.id as DeviceId)).toEqual({ kind: 'done' });
    await a.cycle();
    syncFolders([a, b]);
    const realWrite = b.platform.writeSnapshot;
    (b.platform as { writeSnapshot: typeof realWrite }).writeSnapshot = () => Promise.reject(new Error('arrêt simulé'));
    await b.cycle();
    expect(await titles(b)).toEqual(['X1', 'X2']);
    expect(b.folder.devices.has(x.id)).toBe(true);
    // B oublie A (A perdu) : l'instantané éligible de A ne sert plus.
    expect(await b.service.forgetDevice(a.id as DeviceId)).toEqual({ kind: 'done' });
    await b.cycle();
    // N, associé par B, arrive : aucun instantané éligible (celui de B ne couvre pas X) : attente visible, rien appliqué.
    const n = await createSimDevice(N_ID, { name: 'N', clock: b.clock });
    devices.push(n);
    await pair(b, n);
    propagate(a.folder, n.folder, a.id);
    await n.cycle();
    expect((await meta(n, 'join')) as { failure: string }).toMatchObject({ failure: 'state-mismatch' });
    expect(await titles(n)).toEqual([]);
    // B peut de nouveau écrire : il couvre X, aucun éligible n'existe : il en écrit un sans attendre 7 jours ; N termine.
    (b.platform as { writeSnapshot: typeof realWrite }).writeSnapshot = realWrite;
    b.clock.advance(1_000);
    await b.cycle();
    propagate(b.folder, n.folder, b.id);
    n.clock.advance(1_000);
    await n.cycle();
    expect(await meta(n, 'join')).toBeNull();
    expect(events(n, 'resumed-from-snapshot').map((e) => e['from'])).toEqual([b.id]);
    expect(await titles(n)).toEqual(['X1', 'X2']);
    await settle([b, n]);
    expect(await taskSnapshot(n)).toEqual(await taskSnapshot(b));
  });
});

describe('(3) fantôme revenu avec un trou', () => {
  it('F, jamais vu de A au moment de la suppression, revient avec un curseur sous la coupure : trou, reprise depuis l’éligible, aucun instantané écrit avant sa fin, bases identiques', async () => {
    const a = await first();
    const x = await join(a, X_ID);
    await x.createTask('X1');
    await settle([a, x]);
    // F est associé par A, lit X1, puis disparaît ; son dossier n'atteint jamais A (fantôme).
    const f = await createSimDevice(F_ID, { name: 'F', clock: a.clock });
    devices.push(f);
    await pair(a, f);
    propagate(x.folder, f.folder, x.id);
    await f.cycle();
    expect(await titles(f)).toEqual(['X1']);
    // X2, lu par A ; A oublie X et supprime ses fichiers (F, jamais vu, ne bloque pas).
    await x.createTask('X2');
    await x.cycle();
    propagate(x.folder, a.folder, x.id);
    await a.cycle();
    expect(await a.service.forgetDevice(x.id as DeviceId)).toEqual({ kind: 'done' });
    for (let i = 0; i < 3; i += 1) {
      a.clock.advance(1_000);
      await a.cycle();
    }
    expect(a.folder.devices.has(x.id)).toBe(false);
    // F revient : il apprend l'oubli, le journal de X a disparu, son curseur est sous la coupure : trou, reprise.
    const before = f.logger.entries.length;
    propagate(a.folder, f.folder, a.id);
    mirrorDeviceFolder(a.folder, f.folder, x.id);
    f.clock.advance(1_000);
    await f.cycle();
    const after = f.logger.entries.slice(before).map((e) => e.event);
    expect(after).toContain('forget-gap');
    expect(after).toContain('resumed-from-snapshot');
    expect(after.indexOf('snapshot-written') === -1 || after.indexOf('snapshot-written') > after.indexOf('resumed-from-snapshot')).toBe(true);
    expect(await titles(f)).toEqual(['X1', 'X2']);
    await settle([a, f]);
    expect(await taskSnapshot(f)).toEqual(await taskSnapshot(a));
    expect(f.service.status().forget ?? null).toBeNull();
  });
});

describe('(4) oubli annulé (§18 point 12)', () => {
  it('avant la suppression : X avait oublié A plus tôt (hors ligne) ; C, oublié par A, redevient actif et est relu au-delà de l’ancienne coupure par tous', async () => {
    const a = await first();
    const b = await join(a, B_ID);
    const c = await join(a, C_ID);
    const x = await join(a, X_ID);
    await settle([a, b, c, x]);
    // X oublie A hors ligne (t1) ; plus tard A oublie C (t2 > t1).
    expect(await x.service.forgetDevice(a.id as DeviceId)).toEqual({ kind: 'done' });
    a.clock.advance(5_000);
    expect(await a.service.forgetDevice(c.id as DeviceId)).toEqual({ kind: 'done' });
    await settle([a, b]);
    expect(b.service.status().devices.find((d) => d.deviceId === c.id)?.status).toBe('forgotten');
    // C écrit au-delà de la coupure (personne ne le lit).
    await c.createTask('C au-delà');
    await c.cycle();
    await settle([a, b]);
    expect(await titles(b)).toEqual([]);
    // La déclaration de X arrive : A est oublié, celle de A est sans effet, C redevient actif ; B et X lisent C au-delà de la coupure.
    await settle([b, x, c]);
    for (const d of [b, x]) {
      expect(await titles(d), d.name).toEqual(['C au-delà']);
      expect(d.service.status().devices.find((s) => s.deviceId === c.id)?.status, d.name).not.toBe('forgotten');
    }
    // B avait C oublié : « Oubli annulé » et « oubli en échec » jusqu'à un nouvel oubli ; X n'a jamais appris E (sans effet chez lui).
    expect(b.service.status().forget?.revived ?? []).toContain(c.id);
    expect(x.service.status().forget?.revived ?? []).toEqual([]);
    // A, qui s'est vu oublié, s'arrête pour toujours.
    syncFolders([a, b, x]);
    expect((await a.cycle()).phase).toBe('forgotten');
  });

  it('après la suppression : C terminé, oubli annulé : horizon de purge bloqué, « Oublier » ; nouvel oubli : terminé sans condition de coupure, purges reprises', async () => {
    const a = await first();
    const b = await join(a, B_ID);
    const c = await join(a, C_ID);
    await settle([a, b, c]);
    // F, associé par A puis jamais vu de A ni de B (fantôme : son dossier n'arrive pas), oublie A hors ligne (t1). Après la suppression,
    // ce cas n'arrive que par un fantôme ou par antidatage (§14.2).
    const x = await createSimDevice(F_ID, { name: 'F', clock: a.clock });
    devices.push(x);
    await pair(a, x);
    await x.cycle();
    expect(await x.service.forgetDevice(a.id as DeviceId)).toEqual({ kind: 'done' });
    await x.cycle();
    // Puis A oublie C (t2 > t1) ; A et B suppriment les fichiers de C.
    a.clock.advance(5_000);
    expect(await a.service.forgetDevice(c.id as DeviceId)).toEqual({ kind: 'done' });
    const ab = [a, b];
    for (let r = 0; r < 4; r += 1) {
      for (const d of ab) {
        for (const from of ab) if (from !== d) propagate(from.folder, d.folder, from.id);
        mirrorDeviceFolder(a.folder, d.folder, c.id);
        mirrorDeviceFolder(b.folder, d.folder, c.id);
        d.clock.advance(1_000);
        await d.cycle();
      }
    }
    expect(b.folder.devices.has(c.id)).toBe(false);
    expect(b.platform.testing.forgottenRegistry()?.done).toContain(c.id);
    // La déclaration de F arrive chez B : C (terminé) n'est plus oublié : jamais relu, horizon bloqué, « oubli en échec ».
    propagate(x.folder, b.folder, x.id);
    b.clock.advance(1_000);
    await b.cycle();
    expect(b.service.status().forget?.revived ?? []).toContain(c.id);
    expect((await currentPurgeHorizon(b.data.repos, b.id, b.clock.nowMs())).kind).toBe('blocked');
    // B oublie C de nouveau : C oublié et terminé, sans condition de coupure ; horizon débloqué.
    expect(await b.service.forgetDevice(c.id as DeviceId)).toEqual({ kind: 'done' });
    for (let i = 0; i < 2; i += 1) {
      b.clock.advance(1_000);
      await b.cycle();
    }
    expect(b.service.status().forget?.revived ?? []).not.toContain(c.id);
    expect(b.platform.testing.forgottenRegistry()?.done).toContain(c.id);
    expect(b.service.status().devices.find((d) => d.deviceId === c.id)?.status).toBe('forgotten');
    expect((await currentPurgeHorizon(b.data.repos, b.id, b.clock.nowMs())).kind).not.toBe('blocked');
  });
});

describe('(5) arrêts autour de la condition (h)', () => {
  /** A et X ; X écrit ; A lit ; A oublie X ; les cycles suivants de A écrivent l'instantané couvrant, publient, suppriment. */
  async function scenario(): Promise<[SimDevice, SimDevice]> {
    const a = await first();
    const x = await join(a, X_ID);
    await x.createTask('X1');
    await settle([a, x]);
    await x.createTask('X2');
    await x.cycle();
    propagate(x.folder, a.folder, x.id);
    await a.cycle();
    expect(await a.service.forgetDevice(x.id as DeviceId)).toEqual({ kind: 'done' });
    return [a, x];
  }

  async function finish(a: SimDevice, x: SimDevice): Promise<unknown[]> {
    for (let i = 0; i < 3; i += 1) {
      a.clock.advance(1_000);
      await a.cycle();
    }
    expect(a.folder.devices.has(x.id)).toBe(false);
    const n = await createSimDevice(N_ID, { name: 'N', clock: a.clock });
    devices.push(n);
    await pair(a, n);
    await n.cycle();
    await settle([a, n]);
    expect(await titles(n)).toEqual(['X1', 'X2']);
    expect(await taskSnapshot(n)).toEqual(await taskSnapshot(a));
    return titles(a);
  }

  it('référence sans arrêt, puis arrêt avant chaque écriture de A (instantané, état, suppression, transactions) : rien de perdu', async () => {
    const [a0, x0] = await scenario();
    const probe = armCrash(a0, null);
    a0.clock.advance(1_000);
    await a0.cycle();
    const writes = probe.writes;
    probe.disarm();
    expect(writes).toBeGreaterThanOrEqual(3);
    const reference = await finish(a0, x0);
    await Promise.all(devices.map((d) => d.close()));
    devices = [];
    for (let k = 1; k <= writes; k += 1) {
      const [a, x] = await scenario();
      const crash = armCrash(a, k);
      a.clock.advance(1_000);
      await a.cycle().catch(() => undefined);
      expect(crash.crashed, `arrêt ${String(k)}`).toBe(true);
      crash.disarm();
      await a.restart();
      expect(await finish(a, x), `arrêt ${String(k)}`).toEqual(reference);
      await Promise.all(devices.map((d) => d.close()));
      devices = [];
    }
  });
});

describe('(4) oubli annulé : appareil qui avait fait « Associer de nouveau »', () => {
  it('C, oublié par A, s’est réassocié sous un nouvel identifiant ; l’oubli de A est annulé : l’ancien identifiant est montré chez B, « Oubli annulé », jamais republié', async () => {
    const a = await first();
    const b = await join(a, B_ID);
    const c = await join(a, C_ID);
    await settle([a, b, c]);
    // F (fantôme) oublie A hors ligne, avant que A oublie C.
    const f = await createSimDevice(F_ID, { name: 'F', clock: a.clock });
    devices.push(f);
    await pair(a, f);
    await f.cycle();
    expect(await f.service.forgetDevice(a.id as DeviceId)).toEqual({ kind: 'done' });
    await f.cycle();
    a.clock.advance(5_000);
    expect(await a.service.forgetDevice(c.id as DeviceId)).toEqual({ kind: 'done' });
    await settle([a, b]);
    // C apprend son oubli et se réassocie sous un nouvel identifiant.
    const oldId = c.id;
    for (const d of [a, b]) propagate(d.folder, c.folder, d.id);
    expect((await c.cycle()).phase).toBe('forgotten');
    expect(await c.service.rejoin()).toEqual({ kind: 'restart' });
    const newId = (await c.data.repos.settings.get('device.id')) as DeviceId;
    await c.restartAs(newId);
    await c.platform.folder.choose();
    for (const d of [a, b]) propagate(d.folder, c.folder, d.id);
    await settle([a, b, c]);
    // La déclaration de F arrive chez B : A oublié, celle de A sans effet ; l'ancien identifiant de C n'est plus oublié.
    propagate(f.folder, b.folder, f.id);
    b.clock.advance(1_000);
    await b.cycle();
    const old = b.service.status().devices.find((d) => d.deviceId === oldId);
    expect(old).toBeDefined();
    expect(old?.status).not.toBe('forgotten');
    expect(b.service.status().forget?.revived ?? []).toContain(oldId);
    // L'ancienne identité ne publie plus jamais (arrêt définitif chez Rust).
    expect(c.folder.devices.get(oldId)?.state?.lines[0]?.text ?? '').not.toContain(newId);
  });
});
