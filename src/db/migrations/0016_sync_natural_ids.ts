import type { Migration } from '../migrator';

/**
 * Identifiants déterministes (ADR 0011, section 8 ; Y-02 critère 9) : `routine_log` reçoit `rlog|<routine_id>|<date>` et `holiday`
 * reçoit `holiday|<pays>|<année>|<clé>` (mêmes formules que `src/domain/sync/naturalIds.ts`). Deux appareils qui valident la même
 * routine le même jour, ou qui sèment la même fête, écrivent alors la même ligne.
 *
 * SQL pur, exécuté sous `sync_guard` (rien n'entre dans la file d'envoi : la migration est rejouée à l'identique sur chaque appareil).
 * Aucune table ne référence ces identifiants (pas de clé étrangère vers `routine_log` ni `holiday`) ; les éventuelles horloges de champ
 * et entrées de file déjà posées suivent le nouvel identifiant.
 */
export const migration0016SyncNaturalIds: Migration = {
  version: 16,
  name: 'sync_natural_ids',
  statements: [
    'INSERT OR IGNORE INTO sync_guard (id) VALUES (1)',
    `UPDATE sync_field_clock SET row_id = (SELECT 'rlog|' || r.routine_id || '|' || r.date FROM routine_log r WHERE r.id = sync_field_clock.row_id)
     WHERE table_name = 'routine_log' AND row_id IN (SELECT id FROM routine_log WHERE id <> 'rlog|' || routine_id || '|' || date)`,
    `UPDATE sync_outbox SET row_id = (SELECT 'rlog|' || r.routine_id || '|' || r.date FROM routine_log r WHERE r.id = sync_outbox.row_id)
     WHERE table_name = 'routine_log' AND row_id IN (SELECT id FROM routine_log WHERE id <> 'rlog|' || routine_id || '|' || date)`,
    `UPDATE routine_log SET id = 'rlog|' || routine_id || '|' || date WHERE id <> 'rlog|' || routine_id || '|' || date`,
    `UPDATE sync_field_clock SET row_id = (SELECT 'holiday|' || h.country || '|' || h.year || '|' || h.key FROM holiday h WHERE h.id = sync_field_clock.row_id)
     WHERE table_name = 'holiday' AND row_id IN (SELECT id FROM holiday WHERE id <> 'holiday|' || country || '|' || year || '|' || key)`,
    `UPDATE sync_outbox SET row_id = (SELECT 'holiday|' || h.country || '|' || h.year || '|' || h.key FROM holiday h WHERE h.id = sync_outbox.row_id)
     WHERE table_name = 'holiday' AND row_id IN (SELECT id FROM holiday WHERE id <> 'holiday|' || country || '|' || year || '|' || key)`,
    `UPDATE holiday SET id = 'holiday|' || country || '|' || year || '|' || key WHERE id <> 'holiday|' || country || '|' || year || '|' || key`,
    'DELETE FROM sync_guard',
  ],
};
