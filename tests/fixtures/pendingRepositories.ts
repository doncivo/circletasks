import type { RepositoryFactory, Repositories } from '../../src/db/repositories';

/** Méthode de contrat non implémentée par les repositories de remplacement des tests. */
export class NotImplementedError extends Error {
  override readonly name = 'NotImplementedError';
}

/**
 * Repositories de remplacement pour les tests (ADR 0004) : tout appel de méthode lève `NotImplementedError` en nommant la méthode.
 * Les tests surchargent les seules méthodes dont ils ont besoin. Jamais utilisé par le code de l'application.
 */
export const createPendingRepositories: RepositoryFactory = () =>
  new Proxy({} as Repositories, {
    get: (_target, repoName) =>
      new Proxy(
        {},
        {
          get: (_repo, method) => () =>
            Promise.reject(new NotImplementedError(`${String(repoName)}.${String(method)} : à implémenter (data-model)`)),
        },
      ),
  });
