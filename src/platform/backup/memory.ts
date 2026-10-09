import { BackupError, type BackupListing, type BackupService, type BackupVersion, type DailyBackupRequest, type RestoreRequest, type RestoreResult } from './types';

export interface MemoryBackup extends BackupService {
  /** Versions affichées ; modifiables par les tests. */
  readonly versions: BackupVersion[];
  readonly dailyCalls: DailyBackupRequest[];
  readonly restores: RestoreRequest[];
  /** Nombre de redémarrages demandés. */
  readonly restarts: { count: number };
  readonly revealed: { count: number };
  /** Prochaine opération : échoue avec cette raison (`restore` : `databaseClosed` choisi). */
  failNext(operation: 'list' | 'daily' | 'restore', reason: BackupError['reason'], options?: { databaseClosed?: boolean }): void;
  /** Marqueur rendu par la prochaine restauration réussie (défaut : aucun dossier de synchro). */
  markerNext(result: RestoreResult): void;
}

export interface MemoryBackupOptions {
  readonly available?: boolean;
  readonly directory?: string | null;
  readonly versions?: readonly BackupVersion[];
  /** Horloge (ms) de la version créée par `createDaily` ; défaut : instant réel. */
  readonly nowMs?: () => number;
}

/**
 * Faux des tests et service du navigateur de développement : garde les versions en mémoire. `createDaily` ajoute (ou remplace) la
 * version du jour ; `restore` enregistre la demande (le navigateur n'a pas de fichier à remplacer : la restauration réelle est testée
 * par `cargo test`).
 */
export function createMemoryBackup(options: MemoryBackupOptions = {}): MemoryBackup {
  const versions: BackupVersion[] = [...(options.versions ?? [])];
  const dailyCalls: DailyBackupRequest[] = [];
  const restores: RestoreRequest[] = [];
  const restarts = { count: 0 };
  const revealed = { count: 0 };
  const available = options.available ?? true;
  const now = options.nowMs ?? (() => Date.now());
  let failure: { operation: string; reason: BackupError['reason']; databaseClosed: boolean } | null = null;
  let markerNext: RestoreResult | undefined;

  function maybeFail(operation: 'list' | 'daily' | 'restore'): void {
    if (failure?.operation !== operation) return;
    const current = failure;
    failure = null;
    throw new BackupError(current.reason, { databaseClosed: current.databaseClosed });
  }

  return {
    versions,
    dailyCalls,
    restores,
    restarts,
    revealed,
    markerNext: (result) => {
      markerNext = result;
    },
    failNext: (operation, reason, opts) => {
      failure = { operation, reason, databaseClosed: opts?.databaseClosed ?? false };
    },
    available: () => available,
    list(): Promise<BackupListing> {
      try {
        maybeFail('list');
      } catch (error) {
        return Promise.reject(error as Error);
      }
      const sorted = [...versions].sort((a, b) => b.modifiedMs - a.modifiedMs);
      return Promise.resolve({ directory: options.directory === undefined ? null : options.directory, versions: sorted });
    },
    createDaily(request) {
      try {
        maybeFail('daily');
      } catch (error) {
        return Promise.reject(error as Error);
      }
      dailyCalls.push(request);
      const name = `circletasks-daily-${request.day}.db`;
      const index = versions.findIndex((version) => version.name === name);
      if (index >= 0 && !request.replace) return Promise.resolve({ created: false });
      const previous = index >= 0 ? versions[index] : undefined;
      const entry: BackupVersion = { name, kind: 'daily', stamp: request.day, size: previous?.size ?? 20_480, modifiedMs: now(), tasks: previous?.tasks ?? 0, schemaVersion: previous?.schemaVersion ?? 14 };
      if (index >= 0) versions.splice(index, 1, entry);
      else versions.push(entry);
      // 14 quotidiennes au plus, comme Rust.
      const daily = versions.filter((version) => version.kind === 'daily').sort((a, b) => a.stamp.localeCompare(b.stamp));
      for (const old of daily.slice(0, Math.max(0, daily.length - 14))) versions.splice(versions.indexOf(old), 1);
      return Promise.resolve({ created: true });
    },
    async restore(request, hooks) {
      if (!versions.some((version) => version.name === request.name)) throw new BackupError('not-found');
      await hooks?.prepare?.();
      maybeFail('restore');
      restores.push(request);
      const marker = markerNext;
      markerNext = undefined;
      return marker;
    },
    restart() {
      restarts.count += 1;
      return Promise.resolve();
    },
    reveal() {
      revealed.count += 1;
      return Promise.resolve();
    },
  };
}

/** Plateforme sans sauvegarde locale (iPhone avant l'ouverture des commandes) : la section est masquée. */
export function createUnavailableBackup(): BackupService {
  const unavailable = (): Promise<never> => Promise.reject(new BackupError('unavailable'));
  return { available: () => false, list: unavailable, createDaily: unavailable, restore: unavailable, restart: unavailable };
}
