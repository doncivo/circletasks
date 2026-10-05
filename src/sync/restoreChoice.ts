import { SYNC_FORMAT_MAJOR, compareEpochs, type DeviceAck, type EpochId, type PublishedDeviceState } from '../domain/sync/format';
import { folderEpoch, maxEpoch, nextEpoch, openingCover, restoreOptions } from '../domain/sync/epoch';
import type { DeviceId, Hlc } from '../domain/types';
import type { RestoreContext, RestoreMarker } from '../platform/sync/types';
import type { SyncDeps } from './deps';
import { META, readJson, writeJson } from './meta';
import { snapshotPages } from './snapshot';

/**
 * Choix après une restauration P-04 (ADR 0010 règles 1 à 4, ADR 0011 section 9 ; Y-02 critères 13 à 15, Y-09 critère 8).
 *
 * - « Appliquer cette version sur tous mes appareils » : règle 1, ouverture de l'époque `n+1` par cet appareil, instantané complet de la
 *   base restaurée (`covers[B]` = maximum de ce que la base restaurée et le dernier état publié savaient de B), file vidée, nouvel état.
 * - « Garder les données synchronisées » : reprise depuis l'instantané en fusion (cycle forcé par le service) ; la copie
 *   `circletasks-pre-restore-…` reste disponible.
 * Le marqueur n'est effacé qu'après application complète du choix (par le service).
 */

export type { RestoreContext };

/** Lit les états publiés pour décider des options (règle 4). */
export async function restoreContext(deps: SyncDeps, marker: RestoreMarker): Promise<RestoreContext> {
  let horizons: (Hlc | null)[] = [];
  try {
    const scan = await deps.platform.scan({ keep: [] });
    horizons = scan.devices.filter((d) => d.stateStatus === 'ok' && d.state).map((d) => (d.state as PublishedDeviceState).purgeHorizon);
  } catch {
    // dossier injoignable : les horizons connus en base suffisent
  }
  for (const row of await deps.data.repos.sync.getStates()) horizons.push(row.purgeHorizon);
  horizons.push(await readJson<Hlc>(deps.data.repos, META.purgeHorizon));
  return { marker, options: restoreOptions(marker.backupTakenAt, horizons) };
}

/**
 * « Appliquer partout » : ouvre l'époque suivante avec un instantané complet de la base restaurée. Renvoie l'époque ouverte.
 * Les numéros publiés ne sont jamais réutilisés (règle 1) : `stateSeq` = maximum (base, état publié, accusés des autres) + 1.
 */
export async function applyEverywhere(deps: SyncDeps): Promise<EpochId> {
  const { data, platform, deviceId: self } = deps;
  const scan = await platform.scan({ keep: [] });
  await platform.bindDevice(self);
  const states = scan.devices.filter((d) => d.stateStatus === 'ok' && d.state).map((d) => d.state as PublishedDeviceState);
  const own = states.find((s) => s.deviceId === self) ?? null;
  const localEpoch = await readJson<EpochId>(data.repos, META.epoch);
  const current = maxEpoch([localEpoch, folderEpoch(states), ...states.map((s) => s.epoch)]);
  const target = nextEpoch(current, self);
  // Contrôle avant toute écriture (instantané, état, base) : une époque non croissante ne laisse aucune trace.
  if (current !== null && compareEpochs(target, current) <= 0) throw new Error('époque non croissante');
  // covers[B] : maximum de la base restaurée et du dernier état publié avant la restauration.
  const covers = new Map<DeviceId, DeviceAck>();
  const rows = await data.repos.sync.getStates();
  for (const row of rows) {
    if (row.isSelf || row.epoch === null) continue;
    const restored: DeviceAck = { epoch: row.epoch as EpochId, segment: row.cursorSegment, record: row.cursorRecord, hlc: row.ackHlc, stateSeq: row.stateSeq };
    const cover = openingCover(restored, own?.acks.get(row.deviceId as DeviceId) ?? null);
    if (cover) covers.set(row.deviceId as DeviceId, cover);
  }
  for (const [id, ack] of own?.acks ?? []) if (!covers.has(id)) covers.set(id, ack);
  const localSeq = (await readJson<number>(data.repos, META.stateSeq)) ?? 0;
  const acksOnSelf = states.filter((s) => s.deviceId !== self).map((s) => s.acks.get(self)?.stateSeq ?? 0);
  const stateSeq = Math.max(localSeq, own?.stateSeq ?? 0, ...acksOnSelf) + 1;

  const maxSeq = await data.repos.sync.maxOutboxSeq();
  const endHlc = deps.hlc.now();
  await platform.writeSnapshot({ epoch: target, seq: 1, sv: deps.sv, records: snapshotPages(data.repos, target, covers, deps.sv) });
  const head: DeviceAck = { epoch: target, segment: 0, record: 0, hlc: null, stateSeq };
  await platform.writeState({
    sv: deps.sv,
    state: {
      deviceId: self,
      platform: deps.devicePlatform,
      appVersion: deps.appVersion,
      sm: SYNC_FORMAT_MAJOR,
      sv: deps.sv,
      epoch: target,
      stateSeq,
      head,
      acks: new Map<DeviceId, DeviceAck>(),
      snapshot: { seq: 1, endHlc },
      purgeHorizon: await readJson<Hlc>(data.repos, META.purgeHorizon),
      lastSyncHlc: deps.hlc.now(),
      ...(own?.pairedBy ? { pairedBy: own.pairedBy } : {}),
      forgotten: [],
      reset: null,
    },
  });
  await data.transaction(async (tx) => {
    await tx.sync.clearOutbox(maxSeq);
    for (const row of await tx.sync.getStates()) await tx.sync.saveState(row.deviceId, { epoch: target, cursorSegment: 0, cursorRecord: 0, ackHlc: null });
    await writeJson(tx, META.epoch, target);
    await writeJson(tx, META.head, { epoch: target, segment: 0, record: 0, hlc: null, stateSeq: 0 } satisfies DeviceAck);
    await writeJson(tx, META.stateSeq, stateSeq);
    await writeJson(tx, META.snapshot, { epoch: target, seq: 1, endHlc, coveredSegment: 0 });
    await writeJson(tx, META.segments, null);
    await writeJson(tx, META.resume, null);
    await writeJson(tx, META.epochSwitch, null);
    await writeJson(tx, META.inflight, null);
    await writeJson(tx, META.lastState, null);
  });
  deps.logger.log('restore-applied-everywhere', { epoch: target, previous: current ?? 'none' });
  return target;
}

/** « Garder les données synchronisées » : curseurs remis à zéro et reprise demandée (le cycle forcé l'exécute). */
export async function prepareKeepSynced(deps: SyncDeps): Promise<void> {
  await deps.data.transaction(async (tx) => {
    for (const row of await tx.sync.getStates()) await tx.sync.saveState(row.deviceId, { cursorSegment: 0, cursorRecord: 0, ackHlc: null });
    await writeJson(tx, META.resume, true);
    await writeJson(tx, META.inflight, null);
    await writeJson(tx, META.lastState, null);
  });
}
