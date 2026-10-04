import type { Migration } from '../migrator';

/**
 * E-01 : rappel « 1 semaine avant » d'un événement (AjoutEvenement.html), soit 10080 minutes. La colonne `reminder.offset_min`
 * avait une contrainte CHECK limitée aux avances de N-02 (0, 5, 15, 30, 60, 1440) ; SQLite ne sait pas la modifier, la table est
 * donc reconstruite (copie des lignes, mêmes colonnes, mêmes index). Rejouable : la table de travail est supprimée avant d'être créée,
 * et le contenu de `reminder` n'est jamais perdu (copie avant suppression).
 */
export const migration0009EventReminderOffsets: Migration = {
  version: 9,
  name: 'event_reminder_offsets',
  statements: [
    'DROP TABLE IF EXISTS reminder_rebuild',
    `CREATE TABLE reminder_rebuild (
      id          TEXT PRIMARY KEY,
      target_type TEXT NOT NULL CHECK (target_type IN ('task', 'routine', 'event')),
      target_id   TEXT NOT NULL,
      offset_min  INTEGER NOT NULL CHECK (offset_min IN (0, 5, 15, 30, 60, 1440, 10080)),
      fire_at     TEXT NOT NULL,
      delivered   INTEGER NOT NULL DEFAULT 0 CHECK (delivered IN (0, 1)),
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      deleted_at  TEXT,
      device_id   TEXT NOT NULL,
      hlc         TEXT NOT NULL
    )`,
    `INSERT INTO reminder_rebuild (id, target_type, target_id, offset_min, fire_at, delivered, created_at, updated_at, deleted_at, device_id, hlc)
     SELECT id, target_type, target_id, offset_min, fire_at, delivered, created_at, updated_at, deleted_at, device_id, hlc FROM reminder`,
    'DROP TABLE reminder',
    'ALTER TABLE reminder_rebuild RENAME TO reminder',
    'CREATE INDEX idx_reminder_target ON reminder(target_type, target_id)',
    'CREATE INDEX idx_reminder_fire_at ON reminder(fire_at)',
    'CREATE INDEX idx_reminder_deleted_at ON reminder(deleted_at)',
    'CREATE INDEX idx_reminder_hlc ON reminder(hlc)',
    // E-01 : lecture d'une plage d'événements répétés et de l'année affichée.
    'CREATE INDEX IF NOT EXISTS idx_event_start_date ON event(start_date)',
  ],
};
