import { t, type PlainMessageKey } from '../../i18n';
import { tokenLabel } from '../../ui';
import { SHORTCUTS, parseChord, type KeyChord, type ShortcutId, type ShortcutScope } from './shortcuts';

/**
 * Liste des raccourcis (P-08) : tout est dérivé du registre `SHORTCUTS` (source unique), jamais recopié.
 * Logique pure, testable sous Node ; la fenêtre est dans `features/shortcuts`.
 */

/** Raccourcis du registre sans gestionnaire tant que leur story n'existe pas : affichés « (bientôt) », jamais simulés. */
export const RESERVED_SHORTCUTS: readonly ShortcutId[] = ['list.focus']; // F-01 (Focus) : à retirer à sa livraison.

/** Combinaison écrite en français : « Ctrl+Maj+F », « Suppr », « Échap », « ← ». */
export function formatChord(keys: string): string {
  return keys.split('+').map(tokenLabel).join('+');
}

const SPOKEN: Readonly<Record<string, PlainMessageKey>> = {
  Ctrl: 'shortcutsUi.spoken.ctrl',
  Alt: 'shortcutsUi.spoken.alt',
  Shift: 'shortcutsUi.spoken.shift',
  Space: 'shortcutsUi.spoken.space',
  Escape: 'shortcutsUi.spoken.escape',
  Enter: 'shortcutsUi.spoken.enter',
  Delete: 'shortcutsUi.spoken.delete',
  ArrowUp: 'shortcutsUi.spoken.arrowUp',
  ArrowDown: 'shortcutsUi.spoken.arrowDown',
  ArrowLeft: 'shortcutsUi.spoken.arrowLeft',
  ArrowRight: 'shortcutsUi.spoken.arrowRight',
  ',': 'shortcutsUi.spoken.comma',
  '/': 'shortcutsUi.spoken.slash',
};

/** Combinaison lue par un lecteur d'écran : « Contrôle plus Maj plus F ». */
export function spokenChord(keys: string): string {
  return keys
    .split('+')
    .map((token) => {
      const key = SPOKEN[token];
      return key ? t(key) : token;
    })
    .join(` ${t('shortcutsUi.spoken.plus')} `);
}

/** Combinaisons identiques ? (la touche est comparée sans tenir compte de la casse). */
export function sameChord(a: KeyChord, b: KeyChord): boolean {
  return a.ctrl === b.ctrl && a.alt === b.alt && a.shift === b.shift && a.key.toUpperCase() === b.key.toUpperCase();
}

/** Identifiant du raccourci applicatif qui utilise déjà cette combinaison (D-04, critère 6), sinon null. */
export function appShortcutUsing(keys: string): ShortcutId | null {
  let chord: KeyChord;
  try {
    chord = parseChord(keys);
  } catch {
    return null;
  }
  for (const id of Object.keys(SHORTCUTS) as ShortcutId[]) {
    if (SHORTCUTS[id].scope === 'global') continue;
    if (sameChord(parseChord(SHORTCUTS[id].keys), chord)) return id;
  }
  return null;
}

/** État de la capture rapide globale, tel que l'aide l'affiche (D-04). */
export interface QuickCaptureHelpState {
  readonly keys: string;
  readonly state: 'active' | 'off' | 'unavailable';
}

export interface HelpEntry {
  readonly id: ShortcutId;
  /** Combinaison affichée, en français. */
  readonly keys: string;
  /** Combinaison lue par les lecteurs d'écran. */
  readonly spoken: string;
  readonly description: string;
  /** Mention après la description : « (dans la Semaine) », « indisponible »… ; null si le raccourci agit ici. */
  readonly note: string | null;
  /** Grisé : l'écran courant ne gère pas ce raccourci. */
  readonly dimmed: boolean;
}

export interface HelpGroup {
  readonly scope: ShortcutScope;
  readonly label: string;
  readonly entries: readonly HelpEntry[];
}

const GROUPS: readonly { readonly scope: ShortcutScope; readonly labelKey: PlainMessageKey }[] = [
  { scope: 'global', labelKey: 'shortcutsUi.groupGlobal' },
  { scope: 'app', labelKey: 'shortcutsUi.groupApp' },
  { scope: 'list', labelKey: 'shortcutsUi.groupList' },
  { scope: 'week', labelKey: 'shortcutsUi.groupWeek' },
];

const plain = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export interface HelpInput {
  readonly quickCapture: QuickCaptureHelpState;
  /** Raccourcis ayant un gestionnaire monté (`registry.activeIds()`), pour griser ceux de l'écran courant. */
  readonly activeIds: readonly ShortcutId[];
  /** Recherche instantanée (champ « Filtrer »), sur la description et la combinaison. */
  readonly query?: string;
}

/**
 * Groupes de l'aide, par portée (Global, Application, Listes, Semaine). Les raccourcis de la Semaine et des listes
 * sont grisés quand aucun d'eux n'a de gestionnaire à l'écran (P-08 critère 8) ; la capture rapide montre la
 * combinaison réellement configurée, « désactivé » ou « indisponible ».
 */
export function buildHelpGroups(input: HelpInput): HelpGroup[] {
  const active = new Set(input.activeIds);
  const scopeActive = (scope: ShortcutScope): boolean =>
    (Object.keys(SHORTCUTS) as ShortcutId[]).some((id) => SHORTCUTS[id].scope === scope && active.has(id));
  const needle = plain(input.query?.trim() ?? '');

  const entryOf = (id: ShortcutId): HelpEntry => {
    const definition = SHORTCUTS[id];
    const isGlobal = definition.scope === 'global';
    const keys = isGlobal ? input.quickCapture.keys : definition.keys;
    let note: string | null = null;
    let dimmed = false;
    if (isGlobal && input.quickCapture.state === 'unavailable') {
      note = t('shortcutsUi.unavailable');
      dimmed = true;
    } else if (isGlobal && input.quickCapture.state === 'off') {
      note = t('shortcutsUi.disabled');
      dimmed = true;
    } else if (RESERVED_SHORTCUTS.includes(id)) {
      note = t('shortcutsUi.comingSoon');
      dimmed = true;
    } else if (definition.scope === 'week' && !scopeActive('week')) {
      note = t('shortcutsUi.inWeek');
      dimmed = true;
    } else if (definition.scope === 'list' && !scopeActive('list')) {
      note = t('shortcutsUi.inList');
      dimmed = true;
    }
    return { id, keys: formatChord(keys), spoken: spokenChord(keys), description: t(definition.descriptionKey), note, dimmed };
  };

  return GROUPS.map(({ scope, labelKey }) => ({
    scope,
    label: t(labelKey),
    entries: (Object.keys(SHORTCUTS) as ShortcutId[])
      .filter((id) => SHORTCUTS[id].scope === scope)
      .map(entryOf)
      .filter((entry) => needle === '' || plain(`${entry.description} ${entry.keys}`).includes(needle)),
  })).filter((group) => group.entries.length > 0);
}
