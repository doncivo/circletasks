import { describe, expect, it } from 'vitest';
import { t } from '../../i18n';
import { SHORTCUTS, type ShortcutId } from './shortcuts';
import { RESERVED_SHORTCUTS, appShortcutUsing, buildHelpGroups, formatChord, spokenChord } from './shortcutsHelp';

/**
 * Tableau « Raccourcis clavier PC » de docs/PRD.md section 5, copié à la date de livraison de P-08 (décision D3 : le test
 * fige son contenu ; le PRD reste la référence si Ali le modifie). Chaque cellule « Raccourci » est développée en ses combinaisons.
 */
const PRD_SECTION_5: ReadonlyArray<{ readonly shortcut: string; readonly scope: string }> = [
  { shortcut: 'Ctrl+Alt+Espace', scope: 'Global, même app réduite' },
  { shortcut: 'Ctrl+N', scope: 'Application' },
  { shortcut: 'Ctrl+K', scope: 'Application' },
  { shortcut: 'Alt+1', scope: 'Application' },
  { shortcut: 'Alt+2 à Alt+6', scope: 'Application' },
  { shortcut: 'Ctrl+← / Ctrl+→', scope: 'Semaine' },
  { shortcut: 'Ctrl+1 / Ctrl+2 / Ctrl+3', scope: 'Application' },
  { shortcut: 'Espace', scope: 'Listes' },
  { shortcut: 'Entrée', scope: 'Listes' },
  { shortcut: '↑ / ↓', scope: 'Listes' },
  { shortcut: 'Alt+↑ / Alt+↓', scope: 'Listes' },
  { shortcut: 'Ctrl+D', scope: 'Listes' },
  { shortcut: 'Suppr', scope: 'Listes' },
  { shortcut: 'Ctrl+Z', scope: 'Application' },
  { shortcut: 'Ctrl+Maj+F', scope: 'Listes' },
  { shortcut: 'Ctrl+,', scope: 'Application' },
  { shortcut: 'Ctrl+/', scope: 'Application' },
  { shortcut: 'Échap', scope: 'Application' },
  { shortcut: 'Ctrl+Maj+D', scope: 'Listes' },
];

const SCOPE_LABEL: Record<string, string> = { global: 'Global', app: 'Application', list: 'Listes', week: 'Semaine' };

/** Développe une cellule du tableau : « Alt+2 à Alt+6 » → Alt+2…Alt+6 ; « A / B » → A, B. */
function expand(cell: string): string[] {
  const range = /^Alt\+(\d) à Alt\+(\d)$/.exec(cell);
  if (range) {
    const [from, to] = [Number(range[1]), Number(range[2])];
    return Array.from({ length: to - from + 1 }, (_, i) => `Alt+${from + i}`);
  }
  return cell.split(' / ').map((part) => part.trim());
}

/** Raccourcis du registre absents de la section 5 : extension de S-02 (Alt+←/→ déplace une carte de la Semaine). */
const BEYOND_PRD: readonly ShortcutId[] = ['week.moveEarlier', 'week.moveLater'];

describe('liste des raccourcis = PRD section 5 (P-08 critère 4)', () => {
  const ids = Object.keys(SHORTCUTS) as ShortcutId[];
  const french = (id: ShortcutId): string => formatChord(SHORTCUTS[id].keys);

  it('le tableau du PRD compte 19 lignes', () => {
    expect(PRD_SECTION_5).toHaveLength(19);
  });

  it('chaque combinaison du PRD existe dans le registre, avec sa portée et une description', () => {
    for (const row of PRD_SECTION_5) {
      for (const chord of expand(row.shortcut)) {
        const found = ids.filter((id) => french(id) === chord);
        expect(found, `« ${chord} » absente du registre`).toHaveLength(1);
        const id = found[0] as ShortcutId;
        expect(row.scope.startsWith(SCOPE_LABEL[SHORTCUTS[id].scope] ?? '?'), `${chord} : portée ${row.scope}`).toBe(true);
        expect(t(SHORTCUTS[id].descriptionKey).length).toBeGreaterThan(0);
      }
    }
  });

  it('le registre ne contient rien d’autre que le PRD, hors l’extension nommée de la Semaine', () => {
    const prd = new Set(PRD_SECTION_5.flatMap((row) => expand(row.shortcut)));
    const extra = ids.filter((id) => !prd.has(french(id)));
    expect(extra.sort()).toEqual([...BEYOND_PRD].sort());
  });
});

describe('formatChord et spokenChord (P-08 critères 2 et 9)', () => {
  it('écrit les touches en français', () => {
    expect(formatChord('Ctrl+Shift+F')).toBe('Ctrl+Maj+F');
    expect(formatChord('Delete')).toBe('Suppr');
    expect(formatChord('Enter')).toBe('Entrée');
    expect(formatChord('Escape')).toBe('Échap');
    expect(formatChord('Space')).toBe('Espace');
    expect(formatChord('Ctrl+ArrowLeft')).toBe('Ctrl+←');
    expect(formatChord('Ctrl+,')).toBe('Ctrl+,');
  });

  it('annonce « Contrôle plus Maj plus F »', () => {
    expect(spokenChord('Ctrl+Shift+F')).toBe('Contrôle plus Maj plus F');
    expect(spokenChord('Ctrl+/')).toBe('Contrôle plus barre oblique');
    expect(spokenChord('Alt+ArrowUp')).toBe('Alt plus flèche haut');
  });
});

describe('buildHelpGroups', () => {
  const quickCapture = { keys: 'Ctrl+Alt+Space', state: 'active' } as const;
  const labels = (input: Parameters<typeof buildHelpGroups>[0]) => buildHelpGroups(input).map((g) => g.label);

  it('groupe par portée : Global, Application, Listes, Semaine', () => {
    expect(labels({ quickCapture, activeIds: [] })).toEqual(['Global', 'Application', 'Listes', 'Semaine']);
  });

  it('montre la combinaison réellement configurée, « désactivé » ou « indisponible » (critère 3)', () => {
    const entry = (state: 'active' | 'off' | 'unavailable', keys: string) =>
      buildHelpGroups({ quickCapture: { keys, state }, activeIds: [] })[0]?.entries[0];
    expect(entry('active', 'Ctrl+Shift+Space')).toMatchObject({ keys: 'Ctrl+Maj+Espace', note: null, dimmed: false });
    expect(entry('unavailable', 'Ctrl+Alt+Space')).toMatchObject({ note: 'indisponible', dimmed: true });
    expect(entry('off', 'Ctrl+Alt+Space')).toMatchObject({ note: 'désactivé', dimmed: true });
  });

  it('grise les raccourcis de la Semaine et des listes quand l’écran ne les gère pas (critère 8)', () => {
    const find = (groups: ReturnType<typeof buildHelpGroups>, id: ShortcutId) => groups.flatMap((g) => g.entries).find((e) => e.id === id);
    const none = buildHelpGroups({ quickCapture, activeIds: [] });
    expect(find(none, 'week.next')).toMatchObject({ dimmed: true, note: '(dans la Semaine)' });
    expect(find(none, 'list.complete')).toMatchObject({ dimmed: true, note: '(dans une liste)' });
    expect(find(none, 'app.newTask')).toMatchObject({ dimmed: false, note: null });
    const inWeek = buildHelpGroups({ quickCapture, activeIds: ['week.next', 'list.complete'] });
    expect(find(inWeek, 'week.next')).toMatchObject({ dimmed: false, note: null });
    expect(find(inWeek, 'list.complete')).toMatchObject({ dimmed: false, note: null });
  });

  it('marque « bientôt » les raccourcis réservés, sans les simuler (Focus)', () => {
    expect(RESERVED_SHORTCUTS).toEqual(['list.focus']);
    const entry = buildHelpGroups({ quickCapture, activeIds: ['list.focus'] })
      .flatMap((g) => g.entries)
      .find((e) => e.id === 'list.focus');
    expect(entry).toMatchObject({ keys: 'Ctrl+Maj+F', note: '(bientôt)', dimmed: true });
  });

  it('la recherche instantanée restreint la liste, sans tenir compte des accents ni de la casse (critère 7)', () => {
    const groups = buildHelpGroups({ quickCapture, activeIds: [], query: 'REGLAGES' });
    const found = groups.flatMap((g) => g.entries).map((e) => e.id);
    expect(found).toContain('app.settings');
    expect(found).toContain('app.tab.settings');
    expect(found).not.toContain('app.newTask');
    expect(buildHelpGroups({ quickCapture, activeIds: [], query: 'zzzz' })).toEqual([]);
    expect(buildHelpGroups({ quickCapture, activeIds: [], query: 'ctrl+maj' }).flatMap((g) => g.entries).map((e) => e.id)).toEqual([
      'list.focus',
      'list.duplicate',
    ]);
  });

  it('chaque entrée porte une description et des touches annoncées', () => {
    for (const entry of buildHelpGroups({ quickCapture, activeIds: [] }).flatMap((g) => g.entries)) {
      expect(entry.description).not.toBe('');
      expect(entry.spoken).not.toBe('');
    }
  });
});

describe('appShortcutUsing (D-04 critère 6)', () => {
  it('repère une combinaison déjà prise par l’application', () => {
    expect(appShortcutUsing('Ctrl+N')).toBe('app.newTask');
    expect(appShortcutUsing('Ctrl+K')).toBe('app.search');
    expect(appShortcutUsing('Alt+3')).toBe('app.tab.routines');
  });

  it('ignore la combinaison globale elle-même et les combinaisons libres', () => {
    expect(appShortcutUsing('Ctrl+Alt+Space')).toBeNull();
    expect(appShortcutUsing('Ctrl+Shift+Space')).toBeNull();
    expect(appShortcutUsing('pas une combinaison')).toBeNull();
  });
});
