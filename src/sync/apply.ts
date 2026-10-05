import type { ConflictEntry, FieldClock, Repositories, StoredRow } from '../db/repositories';
import type { DeviceId, Hlc, IsoDateTime } from '../domain/types';
import type { SyncField, SyncOp, SyncValue } from '../domain/sync/format';
import { isUnknownName, isUnknownSettingKey } from '../domain/sync/format';
import { deletedWhileModified, mergeField, modifiedWhileDeleted, type FieldConflict, type LocalField } from '../domain/sync/merge';
import { isNaturalId, type NaturalIdTable } from '../domain/sync/naturalIds';
import { hlcDevice } from '../domain/sync/parse';
import { TECHNICAL_COLUMNS, isValidRowId, isValidValue, settingKeyScope, syncColumn, syncTable, type SyncTable } from '../domain/sync/syncTables';
import type { SyncLogger } from './log';

/**
 * Application d'un lot d'opérations reçues (ADR 0011, sections 3.3, 4, 5.4, 7.2 et 8 ; Y-02 critères 2, 6 et 8, Y-09 critères 1 et 4).
 * Appelée dans une transaction **gardée** (`guarded`) : rien de ce qui est écrit ici ne repart dans la file d'envoi.
 *
 * Pour chaque opération : table et colonnes cherchées dans le catalogue seulement (un nom reçu n'atteint jamais le SQL) ; réglages
 * locaux refusés ; champs inconnus rangés dans `sync_unknown` si l'écrivain a une version de schéma plus récente, refusés sinon ;
 * traces de suppression (un hlc inférieur ou égal ne ressuscite rien) ; fusion par champ (`merge.ts`) ; ligne ou parent absent : mise
 * de côté dans `sync_parked`.
 */

export interface ApplyContext {
  /** `schema_version` local et celui de l'écrivain. */
  readonly localSv: number;
  readonly remoteSv: number;
  readonly now: IsoDateTime;
  /** Valeurs d'un instantané (base inconnue, section 5.5). */
  readonly fromSnapshot?: boolean;
  /** Le suppresseur `deleter` avait-il lu l'écriture `hlc` de `device` (accusés publiés) ? */
  readonly knows: (deleter: DeviceId, device: DeviceId, hlc: Hlc) => boolean;
  readonly logger: SyncLogger;
  /** Mise de côté désactivée (rejeu de `sync_parked` : l'opération reste où elle est si elle échoue encore). */
  readonly noPark?: boolean;
}

export type OpOutcome = 'applied' | 'unchanged' | 'parked' | 'rejected' | 'unknown';

export interface ApplyResult {
  /** Lignes touchées par table (`onRemoteChanges`). */
  readonly touched: Map<string, Set<string>>;
  readonly conflicts: number;
  readonly outcomes: OpOutcome[];
}

interface CachedRow {
  exists: boolean;
  values: Map<string, SyncValue>;
  hlc: Hlc | null;
  clocks: Map<string, FieldClock>;
  pending: Set<string>;
}

const opText = (op: SyncOp): string => {
  const f: Record<string, SyncField> = {};
  for (const [name, field] of op.f) f[name] = field;
  return JSON.stringify({ t: op.t, id: op.id, at: op.at, f });
};

const maxOf = (hlcs: readonly Hlc[]): Hlc => hlcs.reduce((a, b) => (b > a ? b : a));

export async function applyOps(repos: Repositories, ops: readonly SyncOp[], ctx: ApplyContext): Promise<ApplyResult> {
  const sync = repos.sync;
  const touched = new Map<string, Set<string>>();
  const outcomes: OpOutcome[] = [];
  const conflicts: ConflictEntry[] = [];
  const cache = new Map<string, CachedRow>();
  const tombstoneCache = new Map<string, Map<string, Hlc>>();

  // Préchargement par table : lignes, horloges, champs en attente, traces.
  const byTable = new Map<SyncTable, string[]>();
  for (const op of ops) {
    const t = syncTable(op.t);
    if (!t) continue;
    const ids = byTable.get(t);
    if (ids) ids.push(op.id);
    else byTable.set(t, [op.id]);
  }
  for (const [t, ids] of byTable) {
    const [rows, clocks, pending, tombs] = await Promise.all([sync.readRows(t, ids), sync.readClocks(t, ids), sync.pendingFields(t, ids), sync.tombstones(t.name, ids)]);
    tombstoneCache.set(t.name, tombs);
    for (const id of ids) {
      const key = `${t.name}\u0000${id}`;
      if (cache.has(key)) continue;
      const row: StoredRow | undefined = rows.get(id);
      cache.set(key, {
        exists: row !== undefined,
        values: new Map(row?.values ?? []),
        hlc: row?.hlc ?? null,
        clocks: clocks.get(id) ?? new Map(),
        pending: pending.get(id) ?? new Set(),
      });
    }
  }

  const reject = (op: SyncOp, reason: string, field?: string): void => {
    ctx.logger.log('apply-rejected', { table: syncTable(op.t)?.name ?? 'unknown-table', reason, ...(field && syncColumn(op.t, field) ? { field } : {}) });
  };

  const keepUnknown = async (op: SyncOp, name: string, field: SyncField): Promise<boolean> => {
    if (ctx.remoteSv <= ctx.localSv || !isUnknownName(op.t) || !isUnknownName(name)) return false;
    await sync.putUnknown({ table: op.t, rowId: op.id, field: name, value: field[0], hlc: field[1], base: field[2], sv: ctx.remoteSv });
    return true;
  };

  const parentsPresent = async (t: SyncTable, values: ReadonlyMap<string, SyncValue>): Promise<'ok' | 'missing' | 'purged'> => {
    for (const parent of t.parents) {
      const value = values.get(parent.column);
      if (typeof value !== 'string') continue;
      const pt = syncTable(parent.table);
      if (!pt) continue;
      const cached = cache.get(`${pt.name}\u0000${value}`);
      if (cached?.exists) continue;
      if ((await sync.existingIds(pt, [value])).has(value)) continue;
      return (await sync.tombstones(pt.name, [value])).has(value) ? 'purged' : 'missing';
    }
    return 'ok';
  };

  for (const op of ops) {
    const t = syncTable(op.t);
    if (!t) {
      let kept = false;
      if (isUnknownName(op.t)) for (const [name, field] of op.f) kept = (await keepUnknown(op, name, field)) || kept;
      if (!kept) reject(op, 'unknown-table');
      outcomes.push(kept ? 'unknown' : 'rejected');
      continue;
    }
    if (!isValidRowId(t, op.id)) {
      reject(op, 'invalid-id');
      outcomes.push('rejected');
      continue;
    }
    if (t.name === 'settings') {
      const scope = settingKeyScope(op.id);
      if (scope === 'local') {
        // Un appareil ne peut pas imposer un réglage local à un autre (audit M5).
        reject(op, 'local-setting');
        outcomes.push('rejected');
        continue;
      }
      if (scope === 'unknown') {
        let kept = false;
        if (isUnknownSettingKey(op.id) && ctx.remoteSv > ctx.localSv) {
          for (const [name, field] of op.f) {
            await sync.putUnknown({ table: 'settings', rowId: op.id, field: name, value: field[0], hlc: field[1], base: field[2], sv: ctx.remoteSv });
            kept = true;
          }
        }
        if (!kept) reject(op, 'unknown-setting');
        outcomes.push(kept ? 'unknown' : 'rejected');
        continue;
      }
    }

    // Colonnes : catalogue seulement ; type et longueur contrôlés.
    let fields = new Map<string, SyncField>();
    for (const [name, field] of op.f) {
      const col = syncColumn(t.name, name);
      if (col && isValidValue(col, field[0])) {
        fields.set(name, field);
        continue;
      }
      const forbidden = (TECHNICAL_COLUMNS as readonly string[]).includes(name) || t.local.includes(name) || name === 'id' || name === 'key';
      if (forbidden || !(await keepUnknown(op, name, field))) reject(op, col ? 'invalid-field' : 'unknown-field', name);
    }
    if (fields.size === 0) {
      outcomes.push('rejected');
      continue;
    }

    const key = `${t.name}\u0000${op.id}`;
    const row = cache.get(key) ?? { exists: false, values: new Map(), hlc: null, clocks: new Map(), pending: new Set() };
    cache.set(key, row);

    // Traces (section 5.4) : seule une écriture plus récente que la suppression purgée passe.
    const tomb = tombstoneCache.get(t.name)?.get(op.id);
    if (tomb !== undefined) {
      fields = new Map([...fields].filter(([, field]) => field[1] > tomb));
      const full = t.columns.every((col) => fields.has(col.name));
      const natural = t.idKind === 'natural' && isNaturalId(t.name as NaturalIdTable, op.id);
      if (fields.size === 0 || row.exists || !natural || !full) {
        if (fields.size > 0 && !row.exists) ctx.logger.log('apply-abandoned', { table: t.name, reason: 'purged' });
        outcomes.push('rejected');
        continue;
      }
      // Recréation complète d'un identifiant naturel : la trace est retirée dans la même transaction.
      await sync.removeTombstone(t.name, op.id);
      tombstoneCache.get(t.name)?.delete(op.id);
    }

    if (!row.exists) {
      // Une ligne créée puis modifiée avant sa publication part en plusieurs opérations (une par horloge de champ) : la création n'est
      // complète qu'avec toutes. Les parties déjà mises de côté pour cette ligne sont recomposées (plus grand hlc par champ).
      let combined: number[] = [];
      if (!t.columns.every((col) => fields.has(col.name))) {
        const prior = await sync.parkedForRow('missing-row', t.name, op.id);
        const union = new Map(fields);
        for (const parked of prior) {
          const raw = JSON.parse(parked.op) as { f: Record<string, SyncField> };
          for (const [name, field] of Object.entries(raw.f)) {
            const current = union.get(name);
            if (syncColumn(t.name, name) && (!current || field[1] > current[1])) union.set(name, field);
          }
        }
        if (t.columns.every((col) => union.has(col.name))) {
          fields = union;
          combined = prior.map((p) => p.id);
        }
      }
      const full = t.columns.every((col) => fields.has(col.name));
      const values = new Map([...fields].map(([name, field]) => [name, field[0]]));
      const parents = full ? await parentsPresent(t, values) : 'ok';
      if (!full || parents !== 'ok') {
        if (parents === 'purged') {
          ctx.logger.log('apply-abandoned', { table: t.name, reason: 'parent-purged' });
          outcomes.push('rejected');
        } else if (ctx.noPark) {
          outcomes.push('parked');
        } else {
          await sync.park(full ? 'missing-parent' : 'missing-row', t.name, op.id, maxOf([...fields.values()].map((f) => f[1])), opText({ ...op, f: fields }), ctx.now);
          outcomes.push('parked');
        }
        continue;
      }
      const rowHlc = maxOf([...fields.values()].map((f) => f[1]));
      await sync.insertRow(t, op.id, values, { hlc: rowHlc, updatedAt: op.at, deviceId: hlcDevice(rowHlc) });
      const clocks = [...fields].filter(([, f]) => f[1] !== rowHlc || f[2] !== null).map(([name, f]) => ({ field: name, hlc: f[1], base: f[2] }));
      if (clocks.length > 0) await sync.writeClocks(t, op.id, clocks);
      if (combined.length > 0) await sync.removeParked(combined);
      row.exists = true;
      row.values = values;
      row.hlc = rowHlc;
      row.clocks = new Map(clocks.map((c) => [c.field, { hlc: c.hlc, base: c.base }]));
      addTouched(touched, t.name, op.id);
      outcomes.push('applied');
      continue;
    }

    // Ligne existante : fusion champ par champ.
    const clockOf = (name: string): FieldClock => row.clocks.get(name) ?? row.clocks.get('*') ?? { hlc: row.hlc as Hlc, base: null };
    const localFields = new Map<string, LocalField>();
    for (const col of t.columns) {
      const clock = clockOf(col.name);
      localFields.set(col.name, { value: row.values.get(col.name) ?? null, hlc: clock.hlc, base: clock.base, pending: row.pending.has(col.name) || row.pending.has('*') });
    }
    const applied = new Map<string, SyncField>();
    const fieldConflicts: { field: string; conflict: FieldConflict }[] = [];
    for (const [name, field] of fields) {
      const decision = mergeField(localFields.get(name) ?? null, field, ctx.fromSnapshot ? { fromSnapshot: true } : {});
      if (decision.apply) applied.set(name, field);
      if (decision.conflict && syncColumn(t.name, name)?.conflictVisible) fieldConflicts.push({ field: name, conflict: decision.conflict });
    }
    // Suppression contre modification (section 4.2).
    const localDeleted = row.values.get('deleted_at') ?? null;
    const remoteDeletion = applied.get('deleted_at');
    if (remoteDeletion && remoteDeletion[0] !== null && localDeleted === null) {
      const deleter = hlcDevice(remoteDeletion[1]);
      const c = deletedWhileModified(remoteDeletion, localFields, (device, hlc) => ctx.knows(deleter, device, hlc));
      if (c) fieldConflicts.push({ field: 'deleted_at', conflict: c });
    } else if (localDeleted !== null && t.columns.some((col) => col.name === 'deleted_at')) {
      const c = modifiedWhileDeleted({ deletedAt: localDeleted, deletedHlc: clockOf('deleted_at').hlc }, [...applied.values()], fields.has('deleted_at'));
      if (c) fieldConflicts.push({ field: 'deleted_at', conflict: c });
    }
    for (const { field, conflict } of fieldConflicts) {
      conflicts.push({
        table: t.name,
        rowId: op.id,
        field,
        keptValue: conflict.kept.value,
        discardedValue: conflict.discarded.value,
        keptDevice: conflict.kept.device,
        discardedDevice: conflict.discarded.device,
        keptHlc: conflict.kept.hlc,
        discardedHlc: conflict.discarded.hlc,
      });
    }
    if (applied.size === 0) {
      outcomes.push('unchanged');
      continue;
    }
    const nextValues = new Map(row.values);
    for (const [name, field] of applied) nextValues.set(name, field[0]);
    if ((await parentsPresent(t, new Map([...applied].map(([n, f]) => [n, f[0]])))) !== 'ok') {
      if (!ctx.noPark) await sync.park('missing-parent', t.name, op.id, maxOf([...applied.values()].map((f) => f[1])), opText({ ...op, f: applied }), ctx.now);
      outcomes.push('parked');
      continue;
    }
    const appliedMax = maxOf([...applied.values()].map((f) => f[1]));
    const oldHlc = row.hlc as Hlc;
    let meta = null;
    const clocks = [...applied].map(([name, f]) => ({ field: name, hlc: f[1], base: f[2] }));
    if (appliedMax > oldHlc) {
      // Repli « * » avant que le hlc de la ligne ne bouge : les champs sans horloge propre gardent l'ancien.
      if (row.clocks.size === 0) clocks.unshift({ field: '*', hlc: oldHlc, base: null });
      meta = { hlc: appliedMax, updatedAt: op.at, deviceId: hlcDevice(appliedMax) };
    }
    await sync.updateRow(t, op.id, new Map([...applied].map(([n, f]) => [n, f[0]])), meta);
    await sync.writeClocks(t, op.id, clocks);
    for (const c of clocks) row.clocks.set(c.field, { hlc: c.hlc, base: c.base });
    // Une écriture locale en attente écrasée par une valeur plus récente ne sera pas publiée.
    const superseded = [...applied.keys()].filter((name) => row.pending.has(name));
    if (superseded.length > 0) {
      await sync.dropOutbox(superseded.map((field) => ({ table: t.name, rowId: op.id, field })));
      for (const name of superseded) row.pending.delete(name);
    }
    row.values = nextValues;
    if (meta) row.hlc = meta.hlc;
    addTouched(touched, t.name, op.id);
    outcomes.push('applied');
  }

  if (conflicts.length > 0) await sync.insertConflicts(conflicts, ctx.now);
  return { touched, conflicts: conflicts.length, outcomes };
}

function addTouched(touched: Map<string, Set<string>>, table: string, id: string): void {
  const set = touched.get(table) ?? new Set<string>();
  set.add(id);
  touched.set(table, set);
}

export function mergeTouched(into: Map<string, Set<string>>, from: ReadonlyMap<string, ReadonlySet<string>>): void {
  for (const [table, ids] of from) for (const id of ids) addTouched(into, table, id);
}
