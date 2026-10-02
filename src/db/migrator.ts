import { nowIso, systemClock, type Clock } from '../domain/clock';
import type { SqlDriver, SqlExecutor } from './driver';

/**
 * Migration versionnée (un fichier par version dans src/db/migrations, ADR 0002).
 *
 * Règles :
 * - `version` entier strictement croissant, jamais réutilisé ; nom de fichier
 *   `NNNN_titre.ts` avec NNNN = version ;
 * - `statements` : une instruction SQL par élément, sans paramètre ;
 * - une migration publiée ne se modifie plus (somme de contrôle vérifiée) :
 *   on corrige par une nouvelle migration ;
 * - chaque migration s'exécute dans sa propre transaction : tout ou rien.
 */
export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly statements: readonly string[];
}

export type AppliedMigration = {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly applied_at: string;
};

/** Contexte du crochet : `fromVersion` = dernière version appliquée (0 = base neuve). */
export interface BeforeApplyInfo {
  readonly fromVersion: number;
}

export interface MigrateOptions {
  /** Horloge injectée (applied_at) ; par défaut l'horloge système. */
  readonly clock?: Clock;
  /**
   * Appelé une fois avant d'appliquer des migrations en attente (jamais si la base
   * est à jour) : point d'accroche de la sauvegarde automatique (PRD section 7).
   */
  readonly beforeApply?: (pending: readonly Migration[], info: BeforeApplyInfo) => Promise<void>;
}

export interface MigrateReport {
  readonly applied: readonly number[];
  readonly currentVersion: number;
}

export class MigrationError extends Error {
  override readonly name = 'MigrationError';
}

export const MIGRATIONS_TABLE = 'schema_migrations';

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
  version    INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  checksum   TEXT    NOT NULL,
  applied_at TEXT    NOT NULL
)`;

/** Somme de contrôle FNV-1a 32 bits du contenu SQL (détection de migration modifiée). */
export function migrationChecksum(migration: Migration): string {
  let hash = 0x811c9dc5;
  const text = migration.statements.join('\n;\n');
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Vérifie l'ordre et l'unicité des versions déclarées. */
export function validateMigrations(migrations: readonly Migration[]): void {
  let previous = 0;
  for (const m of migrations) {
    if (!Number.isInteger(m.version) || m.version < 1) {
      throw new MigrationError(`Version de migration invalide : ${String(m.version)}`);
    }
    if (m.version <= previous) {
      throw new MigrationError(`Migrations non strictement croissantes : ${String(m.version)} après ${String(previous)}`);
    }
    if (m.statements.length === 0) {
      throw new MigrationError(`Migration ${String(m.version)} vide`);
    }
    previous = m.version;
  }
}

/** Crée la table de suivi si besoin (idempotent). */
export async function ensureMigrationsTable(db: SqlExecutor): Promise<void> {
  await db.execute(CREATE_TABLE);
}

/** Lit les migrations appliquées ; suppose la table créée par ensureMigrationsTable. */
export async function readAppliedMigrations(db: SqlExecutor): Promise<AppliedMigration[]> {
  return db.select<AppliedMigration>(
    `SELECT version, name, checksum, applied_at FROM ${MIGRATIONS_TABLE} ORDER BY version`,
  );
}

/**
 * Applique les migrations en attente. Rejouable : un second appel ne fait rien.
 * Échoue sans rien appliquer si une migration déjà passée a changé, ou si la base
 * contient une version inconnue de ce code (app plus ancienne que la base).
 */
export async function migrate(
  db: SqlDriver,
  migrations: readonly Migration[],
  options: MigrateOptions = {},
): Promise<MigrateReport> {
  validateMigrations(migrations);
  const clock = options.clock ?? systemClock;

  await ensureMigrationsTable(db);
  const applied = await readAppliedMigrations(db);
  const known = new Map(migrations.map((m) => [m.version, m]));

  for (const row of applied) {
    const migration = known.get(row.version);
    if (!migration) {
      throw new MigrationError(`Base en version ${String(row.version)}, inconnue de cette version de l'app`);
    }
    if (migrationChecksum(migration) !== row.checksum) {
      throw new MigrationError(`Migration ${String(row.version)} modifiée après application`);
    }
  }

  const done = new Set(applied.map((row) => row.version));
  const pending = migrations.filter((m) => !done.has(m.version));
  if (pending.length > 0 && options.beforeApply) await options.beforeApply(pending, { fromVersion: applied.at(-1)?.version ?? 0 });

  for (const migration of pending) {
    await db.transaction(async (tx) => {
      for (const statement of migration.statements) await tx.execute(statement);
      await tx.execute(
        `INSERT INTO ${MIGRATIONS_TABLE} (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)`,
        [migration.version, migration.name, migrationChecksum(migration), nowIso(clock)],
      );
    });
  }

  const last = migrations.at(-1);
  return {
    applied: pending.map((m) => m.version),
    currentVersion: last ? last.version : 0,
  };
}
