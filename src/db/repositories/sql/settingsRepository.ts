import { SETTINGS_DEFINITIONS, defaultSetting, type SettingKey, type SettingsValues } from '../../../domain/model';
import type { Hlc } from '../../../domain/types';
import type { WriteStamper } from '../../../domain/hlc';
import type { SqlExecutor, SqlRow } from '../../driver';
import type { SettingsRepository, SyncMetaRepository } from '../settingsRepository';
import { SYNC_TABLES } from '../../../domain/sync/syncTables';
import { toJson } from './sqlHelpers';

interface SettingsRow extends SqlRow {
  readonly key: string;
  readonly value: string;
}

/**
 * Table `settings` (PRD section 6) : clé / valeur JSON, sans `id` ni
 * `deleted_at` (pas de suppression, une ligne par clé) ; `updated_at`,
 * `device_id` et `hlc` restent posés par le `WriteStamper` à chaque écriture.
 */
export function createSettingsRepository(db: SqlExecutor, stamper: WriteStamper): SettingsRepository {
  return {
    async get<K extends SettingKey>(key: K): Promise<SettingsValues[K]> {
      const rows = await db.select<SettingsRow>('SELECT value FROM settings WHERE key = ? LIMIT 1', [key]);
      const row = rows[0];
      return row ? (JSON.parse(row.value) as SettingsValues[K]) : defaultSetting(key);
    },

    async getAll(): Promise<SettingsValues> {
      const rows = await db.select<SettingsRow>('SELECT key, value FROM settings');
      const stored = new Map(rows.map((row) => [row.key, row.value]));
      const entries = (Object.keys(SETTINGS_DEFINITIONS) as SettingKey[]).map((key) => {
        const raw = stored.get(key);
        const value = raw !== undefined ? (JSON.parse(raw) as SettingsValues[typeof key]) : defaultSetting(key);
        return [key, value] as const;
      });
      return Object.fromEntries(entries) as unknown as SettingsValues;
    },

    async set<K extends SettingKey>(key: K, value: SettingsValues[K]): Promise<void> {
      const stamp = stamper.next();
      await db.execute(
        `INSERT INTO settings (key, value, updated_at, device_id, hlc) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at,
           device_id = excluded.device_id, hlc = excluded.hlc`,
        [key, toJson(value), stamp.at, stamp.deviceId, stamp.hlc],
      );
    },
  };
}

/**
 * Sources de `maxHlc()` (ADR 0005, ADR 0011 section 3.2) : toutes les tables publiées du catalogue de synchro (`routine_pause`,
 * `calendar_account` compris) et les horloges de champ (`sync_field_clock`), qui peuvent porter un hlc reçu plus grand que celui de la
 * ligne (champ d'une ligne dont le hlc n'a pas bougé).
 */
const HLC_SOURCES: readonly string[] = [...SYNC_TABLES.map((t) => t.name), 'sync_field_clock'];

export function createSyncMetaRepository(db: SqlExecutor): SyncMetaRepository {
  return {
    async maxHlc() {
      const union = HLC_SOURCES.map((table) => `SELECT MAX(hlc) AS hlc FROM ${table}`).join(' UNION ALL ');
      const rows = await db.select<{ hlc: string | null }>(`SELECT MAX(hlc) AS hlc FROM (${union})`);
      const value = rows[0]?.hlc;
      return value === undefined || value === null ? null : (value as Hlc);
    },
  };
}
