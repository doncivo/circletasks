import { migrations } from '../../src/db/migrations';
import { migrate, type Migration } from '../../src/db/migrator';
import { reintegrateUnknownFields, type ReintegrationReport, type UnknownCatalogue } from '../../src/db/repositories';
import type { SyncField } from '../../src/domain/sync/format';
import { journalRecordToText, parseJournalRecord } from '../../src/domain/sync/parse';
import { settingKeyScope, syncColumn, syncTable, type SyncColumn, type SyncTable } from '../../src/domain/sync/syncTables';
import type { IsoDateTime } from '../../src/domain/types';
import type { MemorySyncFolder, MemorySyncPlatform } from '../../src/platform/sync/memory';
import { createSyncService } from '../../src/sync';
import { SCHEMA_VERSION, type SimDevice } from './syncDevice';

/**
 * Aides du banc pour deux versions de l'app (Y-07 ; ADR 0011 §7.2, §12) :
 * - un appareil « plus récent » (`sv` supérieur, numéro d'application publié) dont chaque opération sur `task` porte en plus une colonne
 *   que la version locale ignore (`x`), comme une migration additive de la version suivante l'ajouterait ;
 * - la « mise à jour » d'un appareil plus ancien : migration de test qui ajoute la colonne `x` (et son déclencheur de capture, pour
 *   prouver que la réintégration passe sous garde), catalogue étendu de cette colonne, migrations rejouées avec le crochet de fin ;
 * - un appareil de majeure supérieure vu par un autre (en-tête de son `state.ctx` à `sm` 2 dans la copie du dossier de l'autre).
 */

/** Colonne de test ajoutée par la « version suivante ». */
export const TEST_COLUMN = 'x';
export const NEXT_SV = SCHEMA_VERSION + 1;

const xColumn: SyncColumn = { name: TEST_COLUMN, type: 'text', nullable: true, max: 4_096, conflictVisible: true };

/** Catalogue de la version suivante : celui de l'app, `task` étendu de la colonne `x`. */
export function extendedCatalogue(): UnknownCatalogue {
  const task = syncTable('task') as SyncTable;
  const extended: SyncTable = { ...task, columns: [...task.columns, xColumn] };
  return {
    table: (name) => (name === 'task' ? extended : syncTable(name)),
    column: (table, name) => (table === 'task' && name === TEST_COLUMN ? xColumn : syncColumn(table, name)),
    settingScope: settingKeyScope,
  };
}

/**
 * Migration additive de la version suivante : colonne `task.x` et son déclencheur de capture, écrit comme ceux que génère la migration
 * 0015 (`captureTriggers`, partie par colonne) : hors garde, une écriture de `x` pose l'horloge propre du champ (hlc de la ligne ; base =
 * horloge précédente du champ, sinon repli « * », sinon ancien hlc ; base gardée si le champ attend déjà sa publication) et entre dans
 * `sync_outbox`. Une vraie migration additive doit régénérer ces déclencheurs (docs/dettes.md).
 */
export const NEXT_MIGRATION: Migration = {
  version: NEXT_SV,
  name: 'test_task_x',
  statements: [
    `ALTER TABLE task ADD COLUMN ${TEST_COLUMN} TEXT`,
    `CREATE TRIGGER test_capture_task_x AFTER UPDATE OF ${TEST_COLUMN} ON task
     WHEN NOT EXISTS (SELECT 1 FROM sync_guard) AND OLD.${TEST_COLUMN} IS NOT NEW.${TEST_COLUMN}
     BEGIN
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
         SELECT 'task', NEW.id, '${TEST_COLUMN}', NEW.hlc,
           CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field IN ('${TEST_COLUMN}', '*'))
             THEN (SELECT base_hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '${TEST_COLUMN}')
             ELSE COALESCE((SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '${TEST_COLUMN}'),
                           (SELECT hlc FROM sync_field_clock WHERE table_name = 'task' AND row_id = NEW.id AND field = '*'), OLD.hlc) END
         ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;
       DELETE FROM sync_outbox WHERE table_name = 'task' AND row_id = NEW.id AND field = '${TEST_COLUMN}';
       INSERT INTO sync_outbox (table_name, row_id, field) VALUES ('task', NEW.id, '${TEST_COLUMN}');
     END`,
  ],
};

/**
 * Démarrage d'un appareil « mis à jour » (ou redémarré) : migrations de l'app et migration de test rejouées, puis le crochet de fin
 * (`afterApply`) réintègre les champs gardés avec le catalogue étendu, comme `bootstrap.ts` le fait avec celui de l'app.
 */
export async function upgradeDevice(device: SimDevice): Promise<ReintegrationReport> {
  let report: ReintegrationReport | null = null;
  await migrate(device.driver, [...migrations, NEXT_MIGRATION], {
    clock: device.clock,
    afterApply: async (db) => {
      report = await reintegrateUnknownFields(db, { now: new Date(device.clock.nowMs()).toISOString() as IsoDateTime, catalogue: extendedCatalogue() });
    },
  });
  return report as unknown as ReintegrationReport;
}

/**
 * Fait de `device` un appareil de version plus récente : `sv` publié `sv`, numéro d'application `appVersion`, et chaque opération sur
 * `task` qu'il publie porte en plus `x` = `xFor(id)` (même horloge que l'opération). Remplace le service de l'appareil.
 */
export function makeNewerDevice(device: SimDevice, options: { readonly sv?: number; readonly appVersion?: string; readonly xFor?: (taskId: string) => string | null } = {}): void {
  const sv = options.sv ?? NEXT_SV;
  const base = device.platform;
  const platform: MemorySyncPlatform = {
    ...base,
    appendJournal: (r) =>
      base.appendJournal({
        ...r,
        sv,
        records: r.records.map((text) => {
          const record = parseJournalRecord(text);
          if (!record) return text;
          const ops = record.ops.map((op) => {
            const value = options.xFor?.(op.id);
            if (op.t !== 'task' || value === undefined) return op;
            const hlc = [...op.f.values()].map((f) => f[1]).reduce((max, h) => (h > max ? h : max));
            const field: SyncField = [value, hlc, null];
            return { ...op, f: new Map([...op.f, [TEST_COLUMN, field]]) };
          });
          return journalRecordToText({ k: 'ops', sv, ops });
        }),
      }),
  };
  device.platform = platform;
  device.service = createSyncService({
    data: device.data,
    platform,
    hlc: device.hlc,
    clock: device.clock,
    deviceId: device.id,
    sv,
    appVersion: options.appVersion ?? '0.5.0',
    logger: device.logger,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
  });
  device.service.onRemoteChanges((c) => device.changes.push(c));
}

/** Dans le dossier `folder` (la copie vue par un autre appareil), l'état publié de `deviceId` passe à une majeure supérieure. */
export function markNewerMajor(folder: MemorySyncFolder, deviceId: string, sm = 2): void {
  const dir = folder.devices.get(deviceId);
  if (dir?.state) (dir.state.header as { sm: number }).sm = sm;
  for (const epoch of dir?.epochs.values() ?? []) for (const file of [...epoch.segments.values(), ...epoch.snapshots.values()]) (file.header as { sm: number }).sm = sm;
}
