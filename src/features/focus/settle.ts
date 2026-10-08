import { act } from '@testing-library/react';
import type { SqlDriver } from '../../db/driver';

/**
 * Attend que l'écran soit au repos, sans échéance d'horloge (aides de test, jsdom).
 *
 * Les `findBy*` et `waitFor` de Testing Library abandonnent après 1 s (2 s ici et là) de temps réel : or un écran qui lit la base
 * puis se redessine en plusieurs temps (rapport, section CONCENTRATION) met 0,3 s machine au repos et plus d'une seconde machine
 * chargée. Ici on attend des événements, pas des durées : à chaque tour, `act` laisse React exécuter ses effets et ses rendus, et
 * un `select` derrière la file sérialisée du driver garantit que toutes les lectures déjà émises sont terminées. On s'arrête quand
 * un tour ne change plus le document. Une boucle qui ne se stabiliserait jamais est bornée par le `testTimeout` de Vitest.
 */
export async function settle(driver: SqlDriver): Promise<void> {
  let previous = '';
  for (;;) {
    await act(async () => {
      await driver.select('SELECT 1');
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    const html = document.body.innerHTML;
    if (html === previous) return;
    previous = html;
  }
}
