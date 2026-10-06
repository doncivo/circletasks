import type { SimDevice } from './syncDevice';

/**
 * Arrêt brutal simulé d'un appareil (ADR 0011, sections 3.3, 5.5, 9.1 et 10.2 ; Y-02, Y-05 critère 5) : le processus meurt juste avant
 * la n-ième **écriture** du cycle (ajout au journal, `state.ctx`, instantané, suppression de ses fichiers, transaction ou écriture
 * hors transaction dans la base). Une fois mort, tout appel (lecture comprise) échoue : le cycle ne peut plus rien faire, comme un
 * processus tué. Les lectures ne sont pas des points d'arrêt : un arrêt avant une lecture équivaut à un arrêt avant l'écriture suivante.
 *
 * Aucun délai : le déclenchement est un compteur d'opérations, jamais un temps.
 */
export interface CrashProbe {
  /** Nombre d'écritures vues depuis l'armement. */
  readonly writes: number;
  /** Le processus est mort (le point d'arrêt a été atteint). */
  readonly crashed: boolean;
  /** Rend la main à l'appareil (redémarrage de l'app) : plus aucun appel n'échoue. */
  disarm(): void;
}

const WRITE_SQL = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i;

/** `crashBeforeWrite` : rang (à partir de 1) de l'écriture qui n'aura pas lieu ; null : aucun arrêt (comptage seul). */
export function armCrash(device: SimDevice, crashBeforeWrite: number | null): CrashProbe {
  let writes = 0;
  let armed = true;
  let crashed = false;
  const boom = (): Error => new Error('arrêt simulé');
  const dead = (): void => {
    if (armed && crashed) throw boom();
  };
  const write = (): void => {
    if (!armed) return;
    if (crashed) throw boom();
    writes += 1;
    if (crashBeforeWrite !== null && writes === crashBeforeWrite) {
      crashed = true;
      throw boom();
    }
  };

  const platform = device.platform as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  for (const name of ['scan', 'readJournal', 'readSnapshot', 'bindDevice']) {
    const real = platform[name] as (...args: unknown[]) => Promise<unknown>;
    platform[name] = (...args) => {
      dead();
      return real.apply(device.platform, args);
    };
  }
  for (const name of ['appendJournal', 'writeState', 'writeSnapshot', 'deleteOwn']) {
    const real = platform[name] as (...args: unknown[]) => Promise<unknown>;
    platform[name] = (...args) => {
      write();
      return real.apply(device.platform, args);
    };
  }
  // Y-10 : déclaration d'oubli (écriture de `forgotten.json` par Rust) et suppression des fichiers d'un appareil oublié.
  const forget = (device.platform as unknown as { forget: Record<string, (...args: unknown[]) => Promise<unknown>> }).forget;
  for (const name of ['device', 'deleteFiles']) {
    const real = forget[name] as (...args: unknown[]) => Promise<unknown>;
    forget[name] = (...args) => {
      write();
      return real.apply(forget, args);
    };
  }

  const driver = device.driver as unknown as { execute: (sql: string, params?: unknown) => Promise<unknown>; select: (sql: string, params?: unknown) => Promise<unknown>; transaction: (fn: unknown) => Promise<unknown> };
  const execute = driver.execute.bind(device.driver);
  const select = driver.select.bind(device.driver);
  const transaction = driver.transaction.bind(device.driver);
  driver.execute = (sql, params) => {
    if (WRITE_SQL.test(sql)) write();
    else dead();
    return execute(sql, params);
  };
  driver.select = (sql, params) => {
    dead();
    return select(sql, params);
  };
  driver.transaction = (fn) => {
    write();
    return transaction(fn);
  };

  return {
    get writes() {
      return writes;
    },
    get crashed() {
      return crashed;
    },
    disarm() {
      armed = false;
    },
  };
}
