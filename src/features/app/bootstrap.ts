import type { SqlDriver } from '../../db/driver';
import { migrate } from '../../db/migrator';
import { migrations } from '../../db/migrations';
import { openDatabase } from '../../platform/database';
import { useAppStore } from './appStore';

let database: SqlDriver | undefined;

/**
 * Ouvre la base du runtime courant et applique les migrations. Appelé une fois au
 * démarrage ; l'état est publié dans le store (dbStatus).
 * La sauvegarde avant migration (beforeApply) sera branchée par data-model / desktop-tauri.
 */
export async function bootstrapDatabase(open: () => Promise<SqlDriver> = openDatabase): Promise<SqlDriver | undefined> {
  const { setDbStatus } = useAppStore.getState();
  setDbStatus('loading');
  try {
    const db = await open();
    await migrate(db, migrations);
    database = db;
    setDbStatus('ready');
    return db;
  } catch (error) {
    setDbStatus('error', error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

/** Base ouverte au démarrage, pour les repositories. */
export function getDatabase(): SqlDriver {
  if (!database) throw new Error('Base non initialisée : appeler bootstrapDatabase() au démarrage');
  return database;
}
