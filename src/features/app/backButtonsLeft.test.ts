import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * UI-FIX-04 (défaut 12 de la liste d'Ali du 2026-10-27) : sur iPhone, le retour est à GAUCHE partout, avec la flèche « ArrowLeft » (comme
 * le Rapport depuis UI-FIX-03), jamais en haut à droite avec l'icône « annuler ». Contrat statique sur chaque écran à retour : le bouton
 * porte `ArrowLeft`, et la rangée qui le contient est alignée au début (`flex-start`), jamais `flex-end`.
 */
const ROOT = join(import.meta.dirname, '..', '..', '..');

interface BackScreen {
  readonly tsx: string;
  readonly css: string;
  /** Classe de la rangée du retour. */
  readonly row: string;
}

export const BACK_SCREENS: readonly BackScreen[] = [
  { tsx: 'src/features/goals/GoalsScreen.tsx', css: 'src/features/goals/GoalsScreen.css', row: 'ct-goals__topRow' },
  { tsx: 'src/features/someday/SomedayScreen.tsx', css: 'src/features/someday/SomedayScreen.css', row: 'ct-someday__topRow' },
  { tsx: 'src/features/tasks/DoneTasksScreen.tsx', css: 'src/features/tasks/DoneTasksScreen.css', row: 'ct-done__topRow' },
  { tsx: 'src/features/tasks/TrashScreen.tsx', css: 'src/features/tasks/TrashScreen.css', row: 'ct-trash__topRow' },
  { tsx: 'src/features/spaces/SpacesScreen.tsx', css: 'src/features/spaces/SpacesScreen.css', row: 'ct-spaces__topRow' },
  { tsx: 'src/features/spaces/QuietHoursScreen.tsx', css: 'src/features/spaces/QuietHoursScreen.css', row: 'ct-quiet__topRow' },
  { tsx: 'src/features/sync/SyncDetailsScreen.tsx', css: 'src/features/sync/SyncDetailsScreen.css', row: 'ct-sync__topRow' },
  { tsx: 'src/features/reminders/RecapSettingsScreen.tsx', css: 'src/features/reminders/RecapSettingsScreen.css', row: 'ct-recap__topRow' },
  { tsx: 'src/features/settings/AppearanceScreen.tsx', css: 'src/features/settings/AppearanceScreen.css', row: 'ct-appearance__topRow' },
  { tsx: 'src/features/settings/ImportScreen.tsx', css: 'src/features/settings/ImportScreen.css', row: 'ct-import__topRow' },
  { tsx: 'src/features/calendars/CalendarsScreen.tsx', css: 'src/features/calendars/CalendarsScreen.css', row: 'ct-calendars__topRow' },
  { tsx: 'src/features/events/HolidaySettingsScreen.tsx', css: 'src/features/events/HolidaySettingsScreen.css', row: 'ct-holiday-settings__topRow' },
  { tsx: 'src/features/stats/ReportScreen.tsx', css: 'src/features/stats/ReportScreen.css', row: 'ct-stats__topRow' },
];

const read = (file: string): string => readFileSync(join(ROOT, file), 'utf8');

/** Règles CSS dont le sélecteur se termine par la classe : sélecteur complet et corps (jusqu'à l'accolade fermante). */
function ruleBlocks(css: string, className: string): { readonly selector: string; readonly body: string }[] {
  const out: { selector: string; body: string }[] = [];
  const pattern = new RegExp(`([^{}]*\\.${className.replace(/[-]/g, '\\-')})\\s*\\{([^}]*)\\}`, 'g');
  for (const match of css.matchAll(pattern)) out.push({ selector: (match[1] ?? '').trim(), body: match[2] ?? '' });
  return out;
}

/** Au début sur iPhone : une règle `flex-start` (générale, ou propre à la mise en page mobile si la règle générale garde `flex-end` pour le PC). */
function alignedStartOnMobile(blocks: readonly { readonly selector: string; readonly body: string }[]): boolean {
  const start = blocks.filter((block) => /justify-content:\s*flex-start/.test(block.body));
  const end = blocks.filter((block) => /justify-content:\s*flex-end/.test(block.body));
  if (start.length === 0) return false;
  if (end.length === 0) return true;
  return start.some((block) => block.selector.includes('mobile')) && end.every((block) => !block.selector.includes('mobile'));
}

describe('UI-FIX-04 : retour iPhone à gauche partout', () => {
  for (const screen of BACK_SCREENS) {
    it(`${screen.tsx} : flèche ArrowLeft sur le bouton de retour, jamais Undo2`, () => {
      const source = read(screen.tsx);
      const index = source.search(/aria-label=\{t\('[a-zA-Z.]*back'\)\}/);
      expect(index, 'bouton de retour introuvable').toBeGreaterThan(-1);
      const block = source.slice(index, index + 400);
      expect(block).toContain('icon={ArrowLeft}');
      expect(block).not.toContain('Undo2');
    });

    it(`${screen.css} : la rangée .${screen.row} est alignée au début`, () => {
      const blocks = ruleBlocks(read(screen.css), screen.row);
      expect(blocks.length, 'règle de la rangée introuvable').toBeGreaterThan(0);
      expect(alignedStartOnMobile(blocks), `${screen.row} : attendu flex-start sur iPhone, lu ${blocks.map((block) => `${block.selector} { ${block.body.trim()} }`).join(' / ')}`).toBe(true);
    });
  }
});
