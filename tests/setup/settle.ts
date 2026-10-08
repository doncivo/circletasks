import { act } from '@testing-library/react';
import type { SqlDriver } from '../../src/db/driver';

/** Nombre maximal de tours avant de déclarer l'écran instable (un compteur, pas une durée). */
export const SETTLE_MAX_TURNS = 50;

/**
 * Aide de test (jsdom), jamais importée par le code livré : attend que l'écran soit au repos, sans échéance d'horloge.
 *
 * Les `findBy*` et `waitFor` de Testing Library abandonnent après 1 s (2 s ici et là) de temps réel : or un écran qui lit la base
 * puis se redessine en plusieurs temps (rapport, section CONCENTRATION) met 0,3 s machine au repos et plus d'une seconde machine
 * chargée. Ici on attend des événements, pas des durées : à chaque tour, `act` laisse React exécuter ses effets et ses rendus, et
 * un `select` derrière la file sérialisée du driver garantit que toutes les lectures déjà émises sont terminées. On s'arrête quand
 * un tour ne change plus le document. Un écran qui change encore après `maxTurns` tours lève une erreur explicite.
 */
export async function settle(driver: SqlDriver, maxTurns: number = SETTLE_MAX_TURNS): Promise<void> {
  let previous = '';
  for (let turn = 0; turn < maxTurns; turn++) {
    await act(async () => {
      await driver.select('SELECT 1');
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    const html = document.body.innerHTML;
    if (html === previous) return;
    previous = html;
  }
  throw new Error(`écran jamais stable après ${String(maxTurns)} tours`);
}
