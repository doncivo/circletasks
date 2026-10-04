import { describe, expect, it } from 'vitest';
import { SHORTCUTS, type ShortcutId } from './shortcuts';
import { RESERVED_SHORTCUTS } from './shortcutsHelp';

/**
 * D-04 critère 1 : chaque raccourci du registre a un gestionnaire réel dans l'écran concerné. Le test lit les sources (hors
 * tests) et cherche l'enregistrement : `shortcuts.register('id'` / `registry.register('id'` ou, pour les onglets, le champ
 * `shortcut: 'id'` de `TABS` consommé par `registerTabShortcuts`.
 */
const sources = import.meta.glob<string>(['/src/**/*.ts', '/src/**/*.tsx', '!/src/**/*.test.ts', '!/src/**/*.test.tsx', '!/src/features/app/shortcuts.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

const registered = (id: ShortcutId): string[] =>
  Object.entries(sources)
    .filter(([, text]) => new RegExp(`register\\(\\s*'${id.replace('.', '\\.')}'|shortcut: '${id.replace('.', '\\.')}'`).test(text))
    .map(([path]) => path);

/** Raccourcis dont le gestionnaire vit hors de l'application : le système (global) ou une story à venir (réservés). */
const NOT_IN_APP: readonly ShortcutId[] = ['global.quickCapture', ...RESERVED_SHORTCUTS];

describe('chaque raccourci du registre est branché (D-04 critère 1)', () => {
  const ids = Object.keys(SHORTCUTS) as ShortcutId[];

  it.each(ids.filter((id) => !NOT_IN_APP.includes(id)))('%s a un gestionnaire monté dans un écran', (id) => {
    expect(registered(id), `aucun gestionnaire pour ${id}`).not.toEqual([]);
  });

  it('le seul raccourci sans gestionnaire dans l’application est le global (système) ; Focus (F-01) est branché', () => {
    const missing = ids.filter((id) => registered(id).length === 0);
    expect(missing.sort()).toEqual([...NOT_IN_APP].sort());
  });
});
