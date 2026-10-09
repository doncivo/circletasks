import type { Migration } from '../migrator';
import { CAPTURE_TABLES_V15, SHARED_SETTING_KEYS_V15 } from './0015_sync_tables';

/**
 * Rappels Apple (K-05 à K-07, ADR 0008 §10.2) : deux colonnes publiées sur `task`, quatre réglages partagés, une table locale.
 *
 * - `task.apple_list_id` (liste d'origine ou de destination d'un rappel, résolue en nom par `appleReminders.lists`) et
 *   `task.apple_recurring` (rappel récurrent dans Rappels : badge et refus d'écriture sur les deux appareils) sont **publiées** ;
 *   l'identifiant du rappel est `task.external_id` et l'origine `task.source = 'apple_reminders'`, déjà publiés (pas de colonne
 *   `apple_reminder_id`, ADR 0008 §10.1) ;
 * - `apple_reminder_link` est **locale** (jamais publiée, écrite par l'iPhone seul) : identifiant EventKit, empreinte du dernier passage,
 *   état d'une création ou d'une suppression en cours ;
 * - les déclencheurs de capture de `task` et de `settings` sont recréés depuis une **copie figée du générateur de 0015** (`captureTriggersV18`,
 *   même texte) : celui de 0015 n'est ni exporté ni partagé, car le modifier changerait la somme de contrôle de 0015 et bloquerait le
 *   démarrage des bases existantes.
 *
 * Exécutée sous `sync_guard` : `ADD COLUMN` n'exécute aucun déclencheur et rien n'entre dans `sync_outbox` ; la version publiée (`sv`)
 * devient la dernière migration (18), `sm` reste 1. Un appareil en version 17 range les nouveaux champs dans `sync_unknown` (ADR 0011 §7.2).
 */

/** Copie figée (version 18) des colonnes publiées par table : version 15, où `task` reçoit les deux colonnes avant `created_at` (ordre du catalogue). */
export const CAPTURE_TABLES_V18: readonly (readonly [table: string, key: 'id' | 'key', columns: readonly string[]])[] = CAPTURE_TABLES_V15.map(([table, key, columns]) =>
  table === 'task' ? ([table, key, columns.flatMap((column) => (column === 'created_at' ? ['apple_list_id', 'apple_recurring', column] : [column]))] as const) : ([table, key, columns] as const),
);

/** Copie figée (version 18) des clés de réglage partagées : version 15 et les quatre clés des Rappels Apple, triées. */
export const SHARED_SETTING_KEYS_V18: readonly string[] = [...SHARED_SETTING_KEYS_V15, 'appleReminders.create', 'appleReminders.lastPassAt', 'appleReminders.lists', 'appleReminders.pending'].sort();

const UNGUARDED_V18 = 'NOT EXISTS (SELECT 1 FROM sync_guard)';

/** Déclencheurs d'une table : insertion (`'*'`) et modification (une entrée par colonne publiée qui change). */
function captureTriggersV18(table: string, key: string, columns: readonly string[]): string[] {
  const shared = table === 'settings' ? ` AND NEW.key IN (${SHARED_SETTING_KEYS_V18.map((k) => `'${k}'`).join(', ')})` : '';
  const row = `table_name = '${table}' AND row_id = NEW.${key}`;
  const fieldClock = (field: string): string => `(SELECT hlc FROM sync_field_clock WHERE ${row} AND field = '${field}')`;
  const perColumn = columns.flatMap((column) => [
    `INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
       SELECT '${table}', NEW.${key}, '${column}', NEW.hlc,
         CASE WHEN EXISTS (SELECT 1 FROM sync_outbox WHERE ${row} AND field IN ('${column}', '*'))
           THEN (SELECT base_hlc FROM sync_field_clock WHERE ${row} AND field = '${column}')
           ELSE COALESCE(${fieldClock(column)}, ${fieldClock('*')}, OLD.hlc) END
       WHERE OLD.${column} IS NOT NEW.${column}
       ON CONFLICT (table_name, row_id, field) DO UPDATE SET hlc = excluded.hlc, base_hlc = excluded.base_hlc;`,
    `DELETE FROM sync_outbox WHERE ${row} AND field = '${column}' AND OLD.${column} IS NOT NEW.${column};`,
    `INSERT INTO sync_outbox (table_name, row_id, field) SELECT '${table}', NEW.${key}, '${column}' WHERE OLD.${column} IS NOT NEW.${column};`,
  ]);
  // Restauration (deleted_at non nul → nul) : la ligne entière repart (entrée « + »), car un autre appareil a pu la purger entre-temps
  // (Y-09, restauration hors ligne contre purge) ; il ne peut la recréer qu'avec toutes ses colonnes.
  const restore = columns.includes('deleted_at')
    ? [
        `DELETE FROM sync_outbox WHERE ${row} AND field = '+' AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;`,
        `INSERT INTO sync_outbox (table_name, row_id, field) SELECT '${table}', NEW.${key}, '+' WHERE OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;`,
        // Cible de rappels (tâche, routine, événement) : ses rappels vivants repartent aussi entiers, car un appareil qui a purgé la
        // cible les a purgés avec elle (T-08) ; ceux restaurés avec elle reçoivent leur propre « + » par le déclencheur de `reminder`.
        ...(['task', 'routine', 'event'].includes(table)
          ? [
              `INSERT OR IGNORE INTO sync_outbox (table_name, row_id, field) SELECT 'reminder', r.id, '+' FROM reminder r WHERE r.target_type = '${table}' AND r.target_id = NEW.${key} AND r.deleted_at IS NULL AND OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL;`,
            ]
          : []),
      ]
    : [];
  return [
    // Recréation locale d'un identifiant purgé (jour de routine recoché) : sa propre trace est retirée dans la même transaction.
    `CREATE TRIGGER sync_${table}_ai AFTER INSERT ON ${table} WHEN ${UNGUARDED_V18}${shared} BEGIN
       DELETE FROM sync_tombstone WHERE ${row};
       DELETE FROM sync_outbox WHERE ${row} AND field = '*';
       INSERT INTO sync_outbox (table_name, row_id, field) VALUES ('${table}', NEW.${key}, '*');
     END`,
    `CREATE TRIGGER sync_${table}_au AFTER UPDATE ON ${table} WHEN ${UNGUARDED_V18}${shared} BEGIN
       INSERT INTO sync_field_clock (table_name, row_id, field, hlc, base_hlc)
         SELECT '${table}', NEW.${key}, '*', OLD.hlc, NULL
         WHERE OLD.hlc IS NOT NEW.hlc AND NOT EXISTS (SELECT 1 FROM sync_field_clock WHERE ${row} AND field = '*');
       ${[...perColumn, ...restore].join('\n       ')}
     END`,
  ];
}

const REPLACED_TABLES = ['task', 'settings'] as const;

export const migration0018AppleReminders: Migration = {
  version: 18,
  name: 'apple_reminders',
  statements: [
    'INSERT OR IGNORE INTO sync_guard (id) VALUES (1)',
    'ALTER TABLE task ADD COLUMN apple_list_id TEXT',
    'ALTER TABLE task ADD COLUMN apple_recurring INTEGER NOT NULL DEFAULT 0 CHECK (apple_recurring IN (0, 1))',
    ...REPLACED_TABLES.flatMap((table) => [`DROP TRIGGER IF EXISTS sync_${table}_ai`, `DROP TRIGGER IF EXISTS sync_${table}_au`]),
    ...CAPTURE_TABLES_V18.filter(([table]) => (REPLACED_TABLES as readonly string[]).includes(table)).flatMap(([table, key, columns]) => captureTriggersV18(table, key, columns)),
    `CREATE TABLE apple_reminder_link (
      task_id        TEXT PRIMARY KEY,
      reminder_id    TEXT,
      external_ref   TEXT,
      list_id        TEXT NOT NULL,
      state          TEXT NOT NULL CHECK (state IN ('linked', 'creating', 'deleting')),
      synced         TEXT,
      apple_modified TEXT,
      started_at     TEXT,
      UNIQUE (reminder_id)
    )`,
    'DELETE FROM sync_guard',
  ],
};
