import type { DataAccess, Repositories } from '../db/repositories';

/**
 * Transaction sous `sync_guard` (ADR 0011, section 3.2, invariants de l'audit M10) : la garde est posée en tête et retirée avant le
 * COMMIT ; un échec annule tout (ROLLBACK), garde comprise. Les écritures de `work` n'entrent jamais dans la file d'envoi.
 */
export function guarded<T>(data: DataAccess, work: (repos: Repositories) => Promise<T>): Promise<T> {
  return data.transaction(async (repos) => {
    await repos.sync.setGuard();
    const result = await work(repos);
    await repos.sync.clearGuard();
    return result;
  });
}
