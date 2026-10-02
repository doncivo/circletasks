import type { Migration } from '../migrator';

/**
 * R-04 critère 5, R-05 : historique des pauses d'une routine. Une ligne par période (`from_date` incluse, `to_date` incluse, NULL tant
 * que la pause est ouverte) avec les colonnes de synchro (ADR 0004, avenant R-05). `routine.paused` reste, cohérent avec la période
 * ouverte. Reprise : les routines déjà en pause reçoivent une période ouverte datée de leur dernière modification.
 */
export const migration0006RoutinePause: Migration = {
  version: 6,
  name: 'routine_pause',
  statements: [
    `CREATE TABLE routine_pause (
      id         TEXT PRIMARY KEY,
      routine_id TEXT NOT NULL REFERENCES routine(id),
      from_date  TEXT NOT NULL,
      to_date    TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      device_id  TEXT NOT NULL,
      hlc        TEXT NOT NULL
    )`,
    'CREATE INDEX idx_routine_pause_routine_id ON routine_pause(routine_id)',
    'CREATE INDEX idx_routine_pause_deleted_at ON routine_pause(deleted_at)',
    'CREATE INDEX idx_routine_pause_hlc ON routine_pause(hlc)',
    `INSERT INTO routine_pause (id, routine_id, from_date, to_date, created_at, updated_at, deleted_at, device_id, hlc)
     SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-8' ||
            substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6))),
            id, substr(updated_at, 1, 10), NULL, updated_at, updated_at, NULL, device_id, hlc
     FROM routine WHERE paused = 1 AND deleted_at IS NULL`,
  ],
};
