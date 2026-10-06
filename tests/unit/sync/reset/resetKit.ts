import { expect } from 'vitest';
import type { RestoreMarker } from '../../../../src/platform/sync/types';
import { createSimDevice, pair, setupFirst, syncFolders, type SimDevice } from '../../../sim/syncDevice';

/**
 * Outils des simulations de Y-11 (ADR 0011 §14.3) : appareils complets (base SQLite Wasm, vrai service, plateforme mémoire dans le rôle de
 * Rust), « iCloud » piloté par le test, horloge commune contrôlée (aucun délai réel : jours et mois par l'horloge).
 */

/** UUID ordonnés : A < W < B < C (W : second appareil qui réinitialise, perdant face à A dans les tests de concurrence). */
export const A_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
export const W_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const B_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const C_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const DAY = 86_400_000;

export interface Room {
  readonly devices: SimDevice[];
}

/** A (premier appareil), puis les autres associés à A ; tous synchronisés. */
export async function setupRoom(room: Room, ids: readonly string[]): Promise<SimDevice[]> {
  const a = await createSimDevice(A_ID, { name: 'A' });
  room.devices.push(a);
  await setupFirst(a);
  expect((await a.cycle()).phase).toBe('idle');
  for (const id of ids) {
    const d = await createSimDevice(id, { name: id.slice(0, 1).toUpperCase(), clock: a.clock });
    room.devices.push(d);
    await pair(a, d);
    expect((await d.cycle()).phase).toBe('idle');
    syncFolders(room.devices);
  }
  await settle(room.devices);
  return room.devices;
}

/** Quelques tours : iCloud à jour, puis un cycle de chaque appareil. */
export async function settle(list: readonly SimDevice[], rounds = 3): Promise<void> {
  for (let r = 0; r < rounds; r += 1) {
    for (const d of list) {
      syncFolders(list);
      d.clock.advance(1_000);
      await d.cycle();
    }
  }
}

/** Clé de secours affichée par `owner` (fenêtre `pairing`, instance `show`, confirmation native comprise). */
export async function recoveryOf(owner: SimDevice): Promise<string> {
  await owner.platform.key.openPairing('show');
  const payload = await owner.platform.key.pairingPayload();
  await owner.platform.key.closePairing();
  return payload.recoveryKey;
}

/** `joiner` (déjà associé) importe la nouvelle clé de `owner` par la clé de secours (fenêtre `pairing`, instance `import`). */
export async function reassociate(owner: SimDevice, joiner: SimDevice, everyone: readonly SimDevice[]): Promise<void> {
  syncFolders(everyone);
  const recovery = await recoveryOf(owner);
  await joiner.platform.key.openPairing('import');
  await joiner.platform.key.import({ recoveryKey: recovery });
}

export const titles = async (d: SimDevice): Promise<string[]> => (await d.driver.select<{ title: string }>('SELECT title FROM task WHERE deleted_at IS NULL ORDER BY title')).map((r) => r.title);

export const meta = async (d: SimDevice, key: string): Promise<unknown> => {
  const raw = await d.data.repos.sync.getMeta(key);
  return raw === null ? null : (JSON.parse(raw) as unknown);
};

/** Contenu d'un fichier d'état du dossier (texte clair de la mémoire) : époque, annonce. */
export function publishedState(folderOwner: SimDevice, of: string, file: 'state' | 'next' = 'state'): { epoch: string; reset: unknown; stateSeq: number } | null {
  const dir = folderOwner.folder.devices.get(of);
  const f = file === 'state' ? dir?.state : dir?.nextState;
  return f?.lines[0] ? (JSON.parse(f.lines[0].text) as { epoch: string; reset: unknown; stateSeq: number }) : null;
}

export async function closeAll(room: Room): Promise<void> {
  await Promise.all(room.devices.map((d) => d.close()));
  room.devices.length = 0;
}

export async function backupOf(device: SimDevice): Promise<Map<string, unknown[]>> {
  const tables = await device.driver.select<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'search_index%' AND name NOT LIKE 'sqlite_%'");
  const copy = new Map<string, unknown[]>();
  for (const { name } of tables) copy.set(name, await device.driver.select(`SELECT * FROM ${name}`));
  return copy;
}

/** Restauration P-04 simulée (même méthode que `restore.test.ts`) : base remplacée, dossier, coffre et own.json gardés, marqueur posé. */
export async function restoreBackup(device: SimDevice, copy: Map<string, unknown[]>): Promise<void> {
  await device.driver.execute('PRAGMA foreign_keys = OFF');
  await device.driver.transaction(async (tx) => {
    await tx.execute('INSERT INTO sync_guard (id) VALUES (1)');
    for (const [table, rows] of copy) {
      if (table === 'sync_guard' || table === 'schema_migrations') continue;
      await tx.execute(`DELETE FROM ${table}`);
      for (const row of rows as Record<string, string | number | null>[]) {
        const cols = Object.keys(row);
        await tx.execute(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => row[c] ?? null));
      }
    }
    await tx.execute('DELETE FROM sync_guard');
  });
  await device.driver.execute('PRAGMA foreign_keys = ON');
  const marker: RestoreMarker = { backup: 'circletasks-daily-20261005.db', backupTakenAt: new Date(device.clock.nowMs() - DAY).toISOString() as RestoreMarker['backupTakenAt'], restoredAt: new Date(device.clock.nowMs()).toISOString() as RestoreMarker['restoredAt'], schemaVersion: 17 };
  device.platform.testing.setRestoreMarker(marker);
  await device.restart();
}

