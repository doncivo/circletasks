import type { DataAccess, Repositories } from './dataAccess';

/**
 * Observation des écritures (N-01, déclencheur `edit` de l'ADR 0012 avenant N1.3) : toute écriture réussie d'un repository surveillé, et
 * toute transaction réussie, appelle `onWrite` APRÈS la validation. Un point unique plutôt qu'un appel dans chaque cas d'usage : aucune
 * modification de tâche, de routine, d'événement, de rappel, d'espace (plages silencieuses) ou de récapitulatif ne peut oublier de
 * demander la replanification. `onWrite` ne lit rien dans la base (le passage de replanification s'en charge, coalescé).
 *
 * Une méthode est une LECTURE si son nom commence par un de `READ_PREFIXES`, sinon une écriture (un nom inattendu déclenche plutôt
 * qu'il ne manque : une replanification inutile est sans effet, une manquée serait un rappel faux).
 */
const READ_PREFIXES = /^(get|list|find|count|existing|progress)/;

export interface WriteObserverOptions {
  /** Repositories surveillés (les autres sont rendus tels quels). */
  readonly watch: readonly (keyof Repositories)[];
  /** `settings.set` : seules ces clés déclenchent. */
  readonly settingsKey: (key: string) => boolean;
  readonly onWrite: () => void;
}

function observeRepository<T extends object>(repository: T, name: keyof Repositories, options: WriteObserverOptions): T {
  return new Proxy(repository, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== 'function' || typeof property !== 'string' || READ_PREFIXES.test(property)) return value;
      return (...args: unknown[]): unknown => {
        const result: unknown = (value as (...a: unknown[]) => unknown).apply(target, args);
        return Promise.resolve(result).then((done) => {
          if (name !== 'settings' || (property === 'set' && typeof args[0] === 'string' && options.settingsKey(args[0]))) options.onWrite();
          return done;
        });
      };
    },
  });
}

export function observeWrites(data: DataAccess, options: WriteObserverOptions): DataAccess {
  const repos = Object.fromEntries(
    (Object.keys(data.repos) as (keyof Repositories)[]).map((name) => [name, options.watch.includes(name) ? observeRepository(data.repos[name], name, options) : data.repos[name]]),
  ) as unknown as Repositories;
  return {
    repos,
    transaction: async (work) => {
      const result = await data.transaction(work);
      options.onWrite();
      return result;
    },
  };
}
