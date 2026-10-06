import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeviceId } from '../../../../src/domain/types';
import { SyncPlatformError } from '../../../../src/platform/sync/types';
import { currentPurgeHorizon } from '../../../../src/sync';
import { FORGET_META } from '../../../../src/sync/forget';
import { mirrorDeviceFolder, propagate } from '../../../sim/syncCloudSim';
import { createSimDevice, pair, setupFirst, syncFolders, taskSnapshot, type SimDevice } from '../../../sim/syncDevice';

/**
 * Y-10, revue et audit (ADR 0011 §18 points 3 à 10, tranché par l'architecte) par simulation du moteur : liste maître republiée par tous
 * (« X oublie Z, A oublie X, suppression de X »), accusés retirés des terminés, appareil associé ensuite, variantes (état de X supprimé
 * par un tiers, registre de A effacé, Z qui revient), plus aucun cycle après « Associer de nouveau » sans relance (revue point 2),
 * intention de publication restaurée (point 7), échec effacé quand la cible n'a plus de dossier (point 4). Aucun délai réel.
 */

const A_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const N_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const X_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const Z_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let devices: SimDevice[] = [];
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

async function setup(ids: readonly string[]): Promise<SimDevice[]> {
  const a = await createSimDevice(A_ID, { name: 'A' });
  devices = [a];
  await setupFirst(a);
  await a.cycle();
  for (const id of ids) {
    const d = await createSimDevice(id, { name: id.slice(0, 1).toUpperCase(), clock: a.clock });
    devices.push(d);
    await pair(a, d);
    await d.cycle();
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

const statusOf = (viewer: SimDevice, id: string): string | undefined => viewer.service.status().devices.find((d) => d.deviceId === id && !d.self)?.status;
const publishedAcks = (d: SimDevice): string[] => Object.keys((JSON.parse(d.folder.devices.get(d.id)?.state?.lines[0]?.text ?? '{}') as { acks?: object }).acks ?? {});
const publishedForgotten = (d: SimDevice): string[] =>
  ((JSON.parse(d.folder.devices.get(d.id)?.state?.lines[0]?.text ?? '{}') as { forgotten?: { deviceId: string }[] }).forgotten ?? []).map((f) => f.deviceId);

/** A, X, Z ; X écrit ; X oublie Z, A et X lisent ; A oublie X ; A seul actif : fichiers de X et de Z supprimés. */
async function xForgetsZThenAForgetsX(): Promise<[SimDevice, SimDevice, SimDevice]> {
  const [a, x, z] = (await setup([X_ID, Z_ID])) as [SimDevice, SimDevice, SimDevice];
  await x.createTask('X1');
  await settle([a, x, z]);
  expect(await x.service.forgetDevice(z.id as DeviceId)).toEqual({ kind: 'done' });
  await settle([a, x]);
  expect(publishedForgotten(a)).toEqual([z.id]);
  expect(await a.service.forgetDevice(x.id as DeviceId)).toEqual({ kind: 'done' });
  await settle([a]);
  return [a, x, z];
}

describe('X oublie Z, A oublie X, suppression de X (§18 point 10)', () => {
  it('chez le moteur de A : Z et X oubliés, fichiers supprimés, plus aucun accusé publié sur eux une fois terminés', async () => {
    const [a, x, z] = await xForgetsZThenAForgetsX();
    expect(a.folder.devices.has(x.id)).toBe(false);
    expect(a.folder.devices.has(z.id)).toBe(false);
    expect(statusOf(a, x.id)).toBe('forgotten');
    expect(statusOf(a, z.id)).toBe('forgotten');
    expect(publishedForgotten(a).sort()).toEqual([x.id, z.id].sort());
    expect(a.platform.testing.forgottenRegistry()?.done.slice().sort()).toEqual([x.id, z.id].sort());
    expect(publishedAcks(a)).not.toContain(x.id);
    expect(publishedAcks(a)).not.toContain(z.id);
    expect(a.service.status().forget ?? null).toBeNull();
  });

  it('un appareil N associé ensuite par A apprend Z et X oubliés à son premier scan, ne lit aucun d’eux ; bases et horizons de purge identiques', async () => {
    const [a, x, z] = await xForgetsZThenAForgetsX();
    const n = await createSimDevice(N_ID, { name: 'N', clock: a.clock });
    devices.push(n);
    await pair(a, n);
    await n.cycle();
    await settle([a, n]);
    // N n'a jamais vu X ni Z (aucun état accepté : pas de ligne dans APPAREILS) ; ils sont oubliés dans sa base, jamais lus.
    const rows = await n.data.repos.sync.getStates();
    for (const id of [x.id, z.id]) {
      expect(rows.find((r) => r.deviceId === id)?.status, id).toBe('forgotten');
      expect(rows.find((r) => r.deviceId === id)?.cursorSegment ?? 0).toBe(0);
    }
    expect(publishedForgotten(n).sort()).toEqual([x.id, z.id].sort());
    expect(await taskSnapshot(n)).toEqual(await taskSnapshot(a));
    const now = a.clock.nowMs();
    expect((await currentPurgeHorizon(n.data.repos, n.id, now)).kind).toBe((await currentPurgeHorizon(a.data.repos, a.id, now)).kind);
  });

  it('variante : le registre de A est effacé (dossier de configuration perdu) : reconstruit depuis son état (cas i), Z et X restent oubliés', async () => {
    const [a, x, z] = await xForgetsZThenAForgetsX();
    a.platform.testing.dropForgottenFile();
    await a.restart();
    await settle([a]);
    expect(statusOf(a, x.id)).toBe('forgotten');
    expect(statusOf(a, z.id)).toBe('forgotten');
    expect(publishedForgotten(a).sort()).toEqual([x.id, z.id].sort());
  });

  it('variante : le state.ctx de X est supprimé par un tiers sans clé avant l’oubli de X : Z reste oublié (déjà republié)', async () => {
    const [a, b, x, z] = (await setup([B_ID, X_ID, Z_ID])) as [SimDevice, SimDevice, SimDevice, SimDevice];
    expect(await x.service.forgetDevice(z.id as DeviceId)).toEqual({ kind: 'done' });
    await settle([a, b, x]);
    for (const d of devices) d.folder.putState({ deviceId: x.id, file: null });
    await settle([a, b]);
    expect(statusOf(a, z.id)).toBe('forgotten');
    expect(publishedForgotten(b)).toContain(z.id);
  });

  it('variante : Z revient avec la clé : il voit son oubli dans l’état de A et cesse de publier', async () => {
    const [a, , z] = await xForgetsZThenAForgetsX();
    await z.createTask('Z hors ligne');
    propagate(a.folder, z.folder, a.id);
    expect((await z.cycle()).phase).toBe('forgotten');
    expect(z.folder.devices.get(z.id)?.epochs.size ?? 0).toBeLessThanOrEqual(1);
    expect(await z.data.repos.sync.outboxCount()).toBeGreaterThan(0);
  });
});

describe('revue Y-10 : points 2, 4 et 7', () => {
  it('point 2 : après « Associer de nouveau », l’ancienne instance ne fait plus aucun cycle (jamais l’ancien identifiant lié au dossier choisi de nouveau)', async () => {
    const [a, x] = (await setup([X_ID])) as [SimDevice, SimDevice];
    expect(await a.service.forgetDevice(x.id as DeviceId)).toEqual({ kind: 'done' });
    propagate(a.folder, x.folder, a.id);
    expect((await x.cycle()).phase).toBe('forgotten');
    expect(await x.service.rejoin()).toEqual({ kind: 'restart' });
    // L'utilisateur rechoisit le dossier mais l'app n'est pas relancée : le planificateur lance un cycle avec l'ancienne identité.
    await x.platform.folder.choose();
    const bind = vi.spyOn(x.platform, 'bindDevice');
    expect((await x.cycle()).phase).toBe('forgotten');
    expect(bind).not.toHaveBeenCalled();
    // « Associer de nouveau » de nouveau, toujours sans relance : rien n'est refait (aucune troisième identité).
    const second = String(await x.data.repos.settings.get('device.id'));
    expect(await x.service.rejoin()).toEqual({ kind: 'restart' });
    expect(await x.data.repos.settings.get('device.id')).toBe(second);
  });

  it('point 7 : une déclaration pas encore publiée garde son intention si une nouvelle demande échoue ou est annulée', async () => {
    const [a, b, x] = (await setup([B_ID, X_ID])) as [SimDevice, SimDevice, SimDevice];
    await a.data.repos.sync.setMeta(FORGET_META.publish, 'true');
    a.platform.testing.setConsent(false);
    expect(await a.service.forgetDevice(x.id as DeviceId)).toEqual({ kind: 'cancelled' });
    expect(await a.data.repos.sync.getMeta(FORGET_META.publish)).toBe('true');
    a.platform.testing.setConsent(true);
    a.clock.advance(10 * 60_000);
    a.platform.testing.setForeground(false);
    expect((await a.service.forgetDevice(b.id as DeviceId)).kind).toBe('failed');
    expect(await a.data.repos.sync.getMeta(FORGET_META.publish)).toBe('true');
  });

  it('point 4 : un échec de suppression est effacé quand la cible n’a plus de dossier (supprimé par un autre appareil)', async () => {
    const [a, b, x] = (await setup([B_ID, X_ID])) as [SimDevice, SimDevice, SimDevice];
    const real = a.platform.forget.deleteFiles;
    // Dossier de X injoignable pour A tant qu'il existe ; une fois disparu, « Rust » constate la fin (sans erreur).
    (a.platform.forget as { deleteFiles: typeof real }).deleteFiles = (id) => (a.folder.devices.has(id) ? Promise.reject(new SyncPlatformError('folder-unreachable')) : real(id));
    expect(await a.service.forgetDevice(x.id as DeviceId)).toEqual({ kind: 'done' });
    await settle([a, b]);
    expect(a.service.status().forget?.failure).toMatchObject({ deviceId: x.id, step: 'delete' });
    // B supprime ; iCloud propage la suppression à A.
    for (let i = 0; i < 3 && b.folder.devices.has(x.id); i += 1) await settle([b, a], 1);
    expect(b.folder.devices.has(x.id)).toBe(false);
    mirrorDeviceFolder(b.folder, a.folder, x.id);
    a.clock.advance(1_000);
    await a.cycle();
    expect(a.service.status().forget?.failure ?? null).toBeNull();
    expect(a.service.status().forget?.deletions ?? []).toEqual([]);
  });
});
