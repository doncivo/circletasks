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

  // Parents cités par le lot : existence lue par table en une passe (au lieu d'une requête par opération).
  const presentParents = new Set<string>();
  const parentIds = new Map<SyncTable, Set<string>>();
  for (const op of ops) {
    const t = syncTable(op.t);
    if (!t) continue;
    for (const parent of t.parents) {
      const value = op.f.get(parent.column)?.[0];
      const pt = syncTable(parent.table);
      if (typeof value !== 'string' || !pt) continue;
      const set = parentIds.get(pt) ?? new Set<string>();
      set.add(value);
      parentIds.set(pt, set);
    }
  }
  for (const [pt, ids] of parentIds) for (const id of await sync.existingIds(pt, [...ids])) presentParents.add(`${pt.name}\u0000${id}`);

  /**
   * Cible d'un rappel restaurée ici (horloge `deleted_at` fondée sur une suppression : base non nulle), et trace du rappel couverte :
   * soit par cette base (rappel purgé avec sa cible : trace = hlc de suppression de la cible), soit par le rappel lui-même (rappel
   * modifié après la suppression de sa cible : trace = son propre hlc, que l'opération porte). Une suppression du rappel plus récente
   * que les deux l'emporte (refus).
   */
  const reminderTargetRestored = async (fields: ReadonlyMap<string, SyncField>, tomb: Hlc): Promise<'restored' | 'pending' | 'no'> => {
    const type = fields.get('target_type')?.[0];
    const targetId = fields.get('target_id')?.[0];
    const tt = typeof type === 'string' ? syncTable(type) : undefined;
    if (!tt || typeof targetId !== 'string') return 'no';
    const target = (await sync.readRows(tt, [targetId])).get(targetId);
    if (target) {
      if (target.values.get('deleted_at') !== null) return 'no';
      const base = (await sync.readClocks(tt, [targetId])).get(targetId)?.get('deleted_at')?.base ?? null;
      let opMax: Hlc | null = null;
      for (const field of fields.values()) if (opMax === null || field[1] > opMax) opMax = field[1];
      return base !== null && (base >= tomb || (opMax !== null && opMax >= tomb)) ? 'restored' : 'no';
    }
    return (await sync.tombstones(tt.name, [targetId])).has(targetId) ? 'pending' : 'no';
  };

  /** Cache d'une ligne relu après une écriture locale faite ici (rattachement) : les opérations suivantes du lot fusionnent contre elle. */
  const refreshRow = async (t: SyncTable, id: string, row: CachedRow): Promise<void> => {
    const fresh = (await sync.readRowsWithClocks(t, [id])).get(id);
    if (!fresh) return;
    row.values = new Map(fresh.values);
    row.hlc = fresh.hlc;
    row.clocks = new Map(fresh.clocks);
    row.pending = new Set([...row.pending, '+']);
  };

  const reject = (op: SyncOp, reason: string, field?: string): void => {
    ctx.logger.log('apply-rejected', { table: syncTable(op.t)?.name ?? 'unknown-table', reason, ...(field && syncColumn(op.t, field) ? { field } : {}) });
  };

  const keepUnknown = async (op: SyncOp, name: string, field: SyncField): Promise<boolean> => {
    if (ctx.remoteSv <= ctx.localSv || !isUnknownName(op.t) || !isUnknownName(name)) return false;
    await sync.putUnknown({ table: op.t, rowId: op.id, field: name, value: field[0], hlc: field[1], base: field[2], sv: ctx.remoteSv });
    return true;
  };

  /** Premier parent purgé (trace) d'une ligne : sa colonne, pour le rattachement de la décision (c). */
  let purgedColumn: string | null = null;
  const parentsPresent = async (t: SyncTable, values: ReadonlyMap<string, SyncValue>): Promise<'ok' | 'missing' | 'purged'> => {
    purgedColumn = null;
    for (const parent of t.parents) {
      const value = values.get(parent.column);
      if (typeof value !== 'string') continue;
      const pt = syncTable(parent.table);
      if (!pt) continue;
      const cached = cache.get(`${pt.name}\u0000${value}`);
      if (cached?.exists) continue;
      // Parents présents lus d'avance pour tout le lot (une requête par table) ; un parent n'est jamais supprimé par l'application.
      if (presentParents.has(`${pt.name}\u0000${value}`)) continue;
      if ((await sync.existingIds(pt, [value])).has(value)) {
        presentParents.add(`${pt.name}\u0000${value}`);
        continue;
      }
      if ((await sync.tombstones(pt.name, [value])).has(value)) {
        purgedColumn = parent.column;
        return 'purged';
      }
      return 'missing';
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
    let clearTomb = false;
    /** Restauration fondée sur la trace, éventuellement en plusieurs parties (grosse ligne découpée champ par champ). */
    let restoring = false;
    if (tomb !== undefined) {
      const restoreField = fields.get('deleted_at');
      const complete = t.columns.every((col) => fields.has(col.name));
      // Restauration de la suppression purgée (Y-09, restauration hors ligne contre purge) : `deleted_at` remis à nul par une écriture
      // plus récente que la trace et **fondée sur elle** (base au moins égale au hlc purgé). Elle l'emporte : la ligne est recréée avec
      // toutes ses colonnes, identifiant UUID compris, et la trace retirée. Une ligne trop grosse pour un enregistrement arrive en
      // plusieurs parties qui portent chacune ce `deleted_at` : elles sont mises de côté (missing-row) et recomposées avant la règle.
      // Une opération ancienne ou sans cette base ne ressuscite jamais rien.
      const restoreShaped = !row.exists && restoreField !== undefined && restoreField[0] === null && restoreField[1] > tomb && restoreField[2] !== null && restoreField[2] >= tomb;
      if (restoreShaped) {
        restoring = true;
        clearTomb = true;
        if (complete) ctx.logger.log('apply-restored-purged', { table: t.name });
      } else if (t.name === 'reminder' && !row.exists && complete && restoreField !== undefined && restoreField[0] === null) {
        // Rappel vivant republié avec sa cible restaurée : accepté si la cible est revenue ici par une restauration fondée sur une
        // trace au moins aussi récente que celle du rappel (purgé avec elle) ; mis de côté tant que la cible est encore une trace.
        const verdict = await reminderTargetRestored(fields, tomb);
        if (verdict === 'pending') {
          if (!ctx.noPark) await sync.park('missing-parent', t.name, op.id, maxOf([...fields.values()].map((f) => f[1])), opText({ ...op, f: fields }), ctx.now);
          outcomes.push('parked');
          continue;
        }
        if (verdict === 'no') {
          ctx.logger.log('apply-abandoned', { table: t.name, reason: 'purged' });
          outcomes.push('rejected');
          continue;
        }
        ctx.logger.log('apply-restored-with-target', { table: t.name });
        clearTomb = true;
      } else {
        fields = new Map([...fields].filter(([, field]) => field[1] > tomb));
        const natural = t.idKind === 'natural' && isNaturalId(t.name as NaturalIdTable, op.id);
        if (fields.size === 0 || row.exists || !natural) {
          if (fields.size > 0 && !row.exists) ctx.logger.log('apply-abandoned', { table: t.name, reason: 'purged' });
          outcomes.push('rejected');
          continue;
        }
        // Identifiant naturel : une recréation complète retire la trace (même transaction) ; une opération partielle plus récente est
        // mise de côté (missing-row) et recomposée à l'arrivée de la recréation, comme sans trace.
        clearTomb = true;
      }
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
            if (tomb !== undefined && !restoring && field[1] <= tomb) continue;
            if (syncColumn(t.name, name) && (!current || field[1] > current[1])) union.set(name, field);
          }
        }
        if (t.columns.every((col) => union.has(col.name))) {
          fields = union;
          combined = prior.map((p) => p.id);
          if (restoring) ctx.logger.log('apply-restored-purged', { table: t.name });
        }
      }
      const full = t.columns.every((col) => fields.has(col.name));
      let values = new Map([...fields].map(([name, field]) => [name, field[0]]));
      let parents = full ? await parentsPresent(t, values) : 'ok';
      // Décision (c) : parent d'une colonne facultative purgé ici (projet) : la ligne reçue est rattachée à « Sans projet » par une
      // écriture locale publiée entière (« + ») au lieu d'être abandonnée ; un événement est journalisé.
      const detached: string[] = [];
      while (full && parents === 'purged' && purgedColumn !== null && syncColumn(t.name, purgedColumn)?.nullable) {
        const column: string = purgedColumn;
        detached.push(column);
        values = new Map(values).set(column, null);
        parents = await parentsPresent(t, values);
      }
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
      if (clearTomb) {
        await sync.removeTombstone(t.name, op.id);
        tombstoneCache.get(t.name)?.delete(op.id);
      }
      // Repli « * » toujours écrit (hlc de la ligne) : une écriture locale ultérieure d'un autre champ ne déplace pas l'horloge des champs
      // sans entrée propre (sinon une écriture distante plus ancienne sur ces champs serait refusée d'un seul côté).
      const clocks: { field: string; hlc: Hlc; base: Hlc | null }[] = [
        { field: '*', hlc: rowHlc, base: null },
        ...[...fields].filter(([, f]) => f[1] !== rowHlc || f[2] !== null).map(([name, f]) => ({ field: name, hlc: f[1], base: f[2] })),
      ];
      await sync.writeClocks(t, op.id, clocks);
      if (combined.length > 0) await sync.removeParked(combined);
      for (const column of detached) {
        await sync.detachField(t, op.id, column);
        ctx.logger.log('children-reattached', { table: t.name, parent: column, count: 1 });
      }
      row.exists = true;
      row.values = values;
      row.hlc = rowHlc;
      row.clocks = new Map(clocks.map((c) => [c.field, { hlc: c.hlc, base: c.base }]));
      if (detached.length > 0) await refreshRow(t, op.id, row);
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
    // Décision (c), ligne existante : un parent d'une colonne facultative purgé ici n'est pas appliqué ; la ligne est rattachée à
    // « Sans projet » après la mise à jour (écriture locale publiée « + »), comme à l'insertion.
    const detachedOnUpdate: string[] = [];
    let updateParents = await parentsPresent(t, new Map([...applied].map(([n, f]) => [n, f[0]])));
    while (updateParents === 'purged' && purgedColumn !== null && syncColumn(t.name, purgedColumn)?.nullable && applied.has(purgedColumn)) {
      const column: string = purgedColumn;
      applied.delete(column);
      detachedOnUpdate.push(column);
      updateParents = await parentsPresent(t, new Map([...applied].map(([n, f]) => [n, f[0]])));
    }
    if (updateParents !== 'ok') {
      if (!ctx.noPark) await sync.park('missing-parent', t.name, op.id, maxOf([...applied.values()].map((f) => f[1])), opText({ ...op, f: applied }), ctx.now);
      outcomes.push('parked');
      continue;
    }
    if (applied.size === 0) {
      for (const column of detachedOnUpdate) {
        await sync.detachField(t, op.id, column);
        ctx.logger.log('children-reattached', { table: t.name, parent: column, count: 1 });
      }
      outcomes.push(detachedOnUpdate.length > 0 ? 'applied' : 'unchanged');
      if (detachedOnUpdate.length > 0) {
        await refreshRow(t, op.id, row);
        addTouched(touched, t.name, op.id);
      }
      continue;
    }
    const appliedMax = maxOf([...applied.values()].map((f) => f[1]));
    const oldHlc = row.hlc as Hlc;
    let meta = null;
    const clocks = [...applied].map(([name, f]) => ({ field: name, hlc: f[1], base: f[2] }));
    // Repli « * » dès qu'il manque (la ligne reçoit des horloges de champ) : les champs sans horloge propre gardent l'ancien hlc de la ligne.
    if (!row.clocks.has('*')) clocks.unshift({ field: '*', hlc: oldHlc, base: null });
    if (appliedMax > oldHlc) {
      meta = { hlc: appliedMax, updatedAt: op.at, deviceId: hlcDevice(appliedMax) };
    }
    await sync.updateRow(t, op.id, new Map([...applied].map(([n, f]) => [n, f[0]])), meta);
    await sync.writeClocks(t, op.id, clocks);
    for (const c of clocks) row.clocks.set(c.field, { hlc: c.hlc, base: c.base });
    for (const column of detachedOnUpdate) {
      await sync.detachField(t, op.id, column);
      ctx.logger.log('children-reattached', { table: t.name, parent: column, count: 1 });
    }
    // Une écriture locale en attente écrasée par une valeur plus récente ne sera pas publiée.
    const superseded = [...applied.keys()].filter((name) => row.pending.has(name));
    if (superseded.length > 0) {
      await sync.dropPending(superseded.map((field) => ({ table: t.name, rowId: op.id, field })));
      for (const name of superseded) row.pending.delete(name);
    }
    row.values = nextValues;
    if (meta) row.hlc = meta.hlc;
    if (detachedOnUpdate.length > 0) await refreshRow(t, op.id, row);
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
