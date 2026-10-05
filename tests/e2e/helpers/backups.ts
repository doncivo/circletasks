import type { Page } from '@playwright/test';

/**
 * Faux du service de sauvegarde pour les e2e (P-04) : garde les versions en mémoire de la page, enregistre les appels et sait échouer à la
 * demande. À installer AVANT d'ouvrir l'app (`addInitScript`). La vraie restauration (fichier remplacé, redémarrage) est testée par
 * `cargo test --test desktop` : le navigateur n'a pas de fichier à remplacer.
 */
export interface FakeVersion {
  readonly name: string;
  readonly kind: 'daily' | 'pre-migration' | 'pre-restore';
  readonly stamp: string;
  readonly size: number;
  /** ISO local sans fuseau ou avec fuseau ; converti en ms dans la page. */
  readonly at: string;
  readonly tasks: number | null;
  readonly schemaVersion?: number;
}

interface FakeState {
  versions: (Omit<FakeVersion, 'at'> & { modifiedMs: number; schemaVersion: number | null })[];
  dailyCalls: { day: string; replace: boolean }[];
  restores: { name: string; stamp: string }[];
  restarts: number;
  revealed: number;
  failNext: { operation: 'list' | 'daily' | 'restore'; reason: string; databaseClosed: boolean } | null;
}

declare global {
  interface Window {
    __ctBackupState?: FakeState;
  }
}

export async function installFakeBackups(page: Page, versions: readonly FakeVersion[] = [], options: { available?: boolean; directory?: string | null; failFirstDaily?: boolean } = {}): Promise<void> {
  await page.addInitScript(
    ({ versions: seed, available, directory, failFirstDaily }) => {
      const state: FakeState = {
        versions: seed.map(({ at, ...rest }) => ({ ...rest, modifiedMs: new Date(at).getTime(), schemaVersion: rest.schemaVersion ?? 14 })),
        dailyCalls: [],
        restores: [],
        restarts: 0,
        revealed: 0,
        failNext: failFirstDaily ? { operation: 'daily', reason: 'io', databaseClosed: false } : null,
      };
      window.__ctBackupState = state;
      class FakeBackupError extends Error {
        reason: string;
        databaseClosed: boolean;
        constructor(reason: string, databaseClosed: boolean) {
          super(`sauvegarde : ${reason}`);
          this.name = 'BackupError';
          this.reason = reason;
          this.databaseClosed = databaseClosed;
        }
      }
      const check = (operation: 'list' | 'daily' | 'restore'): void => {
        const failure = state.failNext;
        if (failure?.operation !== operation) return;
        state.failNext = null;
        throw new FakeBackupError(failure.reason, failure.databaseClosed);
      };
      (globalThis as { __ctBackups?: unknown }).__ctBackups = {
        available: () => available,
        list: async () => {
          check('list');
          return { directory, versions: [...state.versions].sort((a, b) => b.modifiedMs - a.modifiedMs) };
        },
        createDaily: async (request: { day: string; replace: boolean }) => {
          check('daily');
          state.dailyCalls.push(request);
          const name = `circletasks-daily-${request.day}.db`;
          const index = state.versions.findIndex((v) => v.name === name);
          if (index >= 0 && !request.replace) return { created: false };
          const entry = { name, kind: 'daily' as const, stamp: request.day, size: 20_480, modifiedMs: Date.now(), tasks: 0, schemaVersion: 14 };
          if (index >= 0) state.versions.splice(index, 1, entry);
          else state.versions.push(entry);
          return { created: true };
        },
        restore: async (request: { name: string; stamp: string }) => {
          check('restore');
          state.restores.push(request);
        },
        restart: async () => {
          state.restarts += 1;
        },
        reveal: async () => {
          state.revealed += 1;
        },
      };
    },
    { versions, available: options.available ?? true, directory: options.directory === undefined ? 'C:\\Users\\Ali\\AppData\\Roaming\\fr.circletasks.planner\\backups' : options.directory, failFirstDaily: options.failFirstDaily ?? false },
  );
}

export async function failNextBackup(page: Page, operation: 'list' | 'daily' | 'restore', reason: string, databaseClosed = false): Promise<void> {
  await page.evaluate(
    (failure) => {
      if (window.__ctBackupState) window.__ctBackupState.failNext = failure;
    },
    { operation, reason, databaseClosed },
  );
}

export async function backupState(page: Page): Promise<Pick<FakeState, 'dailyCalls' | 'restores' | 'restarts' | 'revealed'> & { names: string[] }> {
  return page.evaluate(() => {
    const state = window.__ctBackupState;
    return { dailyCalls: state?.dailyCalls ?? [], restores: state?.restores ?? [], restarts: state?.restarts ?? 0, revealed: state?.revealed ?? 0, names: (state?.versions ?? []).map((v) => v.name) };
  });
}
