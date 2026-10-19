import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as screens from './lazyScreens';
import { SCREEN_LOADED_PREFIX } from './screenNames';

/**
 * BUNDLE-01 (critère 16) : aucun écran manquant. Chaque export paresseux de `lazyScreens.tsx` (écrans, fiche de tâche, hôtes de la coquille)
 * se charge réellement (son module existe et exporte le composant nommé) et pose son repère `data-ct-loaded-<nom>` ; l'inventaire des
 * `ScreenName` est exact : un nom par export, pas un de plus, sauf `restorechoicedialog`, posé par `RestoreChoiceHost` (Y-FIX-04).
 */
describe('inventaire des écrans et hôtes à la demande', () => {
  it('chaque export paresseux se charge et pose son repère ; les ScreenName correspondent un à un', async () => {
    const exported: Array<[string, unknown]> = Object.entries(screens);
    const lazy = exported.filter((entry): entry is [string, { preload: () => Promise<void> }] => typeof entry[1] === 'function' && 'preload' in entry[1]);
    expect(lazy.length).toBeGreaterThan(0);
    await Promise.all(lazy.map(([name, component]) => component.preload().catch((error: unknown) => { throw new Error(`${name} : ${String(error)}`); })));
    const posted = Array.from(document.documentElement.attributes)
      .map((attribute) => attribute.name)
      .filter((name) => name.startsWith(SCREEN_LOADED_PREFIX))
      .map((name) => name.slice(SCREEN_LOADED_PREFIX.length))
      .sort();
    expect(posted).toHaveLength(lazy.length);
    const source = readFileSync(join(import.meta.dirname, 'screenNames.ts'), 'utf8');
    const declared = Array.from(source.matchAll(/^\s*\| '([a-z]+)'/gm), (match) => match[1] as string).sort();
    expect(declared).toEqual([...posted, 'restorechoicedialog'].sort());
  });
});
