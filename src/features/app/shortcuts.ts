import type { PlainMessageKey } from '../../i18n';

/**
 * Registre central des raccourcis clavier (PRD section 5, D-04, P-08), ADR 0004.
 *
 * - Les combinaisons sont déclarées ici, une seule fois ; les écrans enregistrent
 *   seulement un gestionnaire pour un identifiant (`registry.register('list.complete', …)`).
 * - Plusieurs gestionnaires pour le même identifiant : le dernier enregistré gagne
 *   (ex. liste de la Semaine montée par-dessus Aujourd'hui), le précédent reprend
 *   la main quand il se désenregistre.
 * - Clavier AZERTY : les chiffres se comparent sur `event.code` (Digit1, Numpad1),
 *   car Alt+1 produit '&' en `event.key` ; les lettres sur `event.key` (Ctrl+Z reste
 *   la touche marquée Z) ; les symboles (',' '/') sur `event.key`, Maj ignorée.
 * - AltGr = Ctrl+Alt sous Windows : aucune combinaison applicative n'utilise Ctrl+Alt.
 * - Dans un champ de saisie, seuls les raccourcis `inEditable` se déclenchent
 *   (Ctrl+Z y reste l'annulation native du texte).
 * - Le raccourci global (Ctrl+Alt+Espace, Q-01) n'est pas géré ici : desktop-tauri
 *   l'enregistre côté système via src/platform ; il figure ici pour l'aide (P-08).
 */
export type ShortcutScope = 'global' | 'app' | 'list' | 'week';

export interface ShortcutDefinition {
  /** Combinaison, notation 'Ctrl+Shift+D', 'Alt+1', 'Ctrl+ArrowLeft', 'Space'. */
  readonly keys: string;
  readonly scope: ShortcutScope;
  readonly inEditable: boolean;
  readonly descriptionKey: PlainMessageKey;
}

const def = (keys: string, scope: ShortcutScope, inEditable: boolean, descriptionKey: PlainMessageKey): ShortcutDefinition => ({
  keys,
  scope,
  inEditable,
  descriptionKey,
});

export const SHORTCUTS = {
  'global.quickCapture': def('Ctrl+Alt+Space', 'global', true, 'shortcuts.quickCapture'),
  'app.newTask': def('Ctrl+N', 'app', true, 'shortcuts.newTask'),
  'app.search': def('Ctrl+K', 'app', true, 'shortcuts.search'),
  'app.tab.tasks': def('Alt+1', 'app', true, 'shortcuts.tabTasks'),
  'app.tab.week': def('Alt+2', 'app', true, 'shortcuts.tabWeek'),
  'app.tab.routines': def('Alt+3', 'app', true, 'shortcuts.tabRoutines'),
  'app.tab.events': def('Alt+4', 'app', true, 'shortcuts.tabEvents'),
  'app.tab.checklists': def('Alt+5', 'app', true, 'shortcuts.tabChecklists'),
  'app.tab.settings': def('Alt+6', 'app', true, 'shortcuts.tabSettings'),
  'app.space.pro': def('Ctrl+1', 'app', true, 'shortcuts.spacePro'),
  'app.space.perso': def('Ctrl+2', 'app', true, 'shortcuts.spacePerso'),
  'app.space.all': def('Ctrl+3', 'app', true, 'shortcuts.spaceAll'),
  'app.undo': def('Ctrl+Z', 'app', false, 'shortcuts.undo'),
  'app.settings': def('Ctrl+,', 'app', true, 'shortcuts.settings'),
  'app.shortcutsHelp': def('Ctrl+/', 'app', true, 'shortcuts.help'),
  'app.escape': def('Escape', 'app', true, 'shortcuts.escape'),
  'week.previous': def('Ctrl+ArrowLeft', 'week', false, 'shortcuts.weekPrevious'),
  'week.next': def('Ctrl+ArrowRight', 'week', false, 'shortcuts.weekNext'),
  'list.complete': def('Space', 'list', false, 'shortcuts.complete'),
  'list.open': def('Enter', 'list', false, 'shortcuts.open'),
  'list.previous': def('ArrowUp', 'list', false, 'shortcuts.previous'),
  'list.next': def('ArrowDown', 'list', false, 'shortcuts.next'),
  'list.moveUp': def('Alt+ArrowUp', 'list', false, 'shortcuts.moveUp'),
  'list.moveDown': def('Alt+ArrowDown', 'list', false, 'shortcuts.moveDown'),
  'list.postponeTomorrow': def('Ctrl+D', 'list', false, 'shortcuts.postponeTomorrow'),
  'list.delete': def('Delete', 'list', false, 'shortcuts.delete'),
  'list.focus': def('Ctrl+Shift+F', 'list', false, 'shortcuts.focus'),
  'list.duplicate': def('Ctrl+Shift+D', 'list', false, 'shortcuts.duplicate'),
} as const satisfies Record<string, ShortcutDefinition>;

export type ShortcutId = keyof typeof SHORTCUTS;

export interface KeyChord {
  readonly key: string;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

/** Touche pressée, indépendante du DOM (testable sous Node). */
export interface KeyInput {
  readonly key: string;
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  /** Vrai si le focus est dans un champ de saisie (input, textarea, contenteditable). */
  readonly editable: boolean;
}

export function parseChord(keys: string): KeyChord {
  const parts = keys.split('+');
  const key = parts.pop();
  if (!key) throw new SyntaxError(`Raccourci invalide : « ${keys} »`);
  const mods = new Set(parts);
  for (const m of mods) {
    if (m !== 'Ctrl' && m !== 'Alt' && m !== 'Shift') throw new SyntaxError(`Modificateur inconnu : « ${m} »`);
  }
  return { key, ctrl: mods.has('Ctrl'), alt: mods.has('Alt'), shift: mods.has('Shift') };
}

export function matchesChord(chord: KeyChord, input: KeyInput): boolean {
  if (input.metaKey || chord.ctrl !== input.ctrlKey || chord.alt !== input.altKey) return false;
  const k = chord.key;
  if (/^[0-9]$/.test(k)) return chord.shift === input.shiftKey && (input.code === `Digit${k}` || input.code === `Numpad${k}`);
  if (/^[A-Z]$/.test(k)) return chord.shift === input.shiftKey && input.key.toUpperCase() === k;
  if (k.length === 1) return input.key === k; // symbole : Maj dépend de la disposition
  if (k === 'Space') return chord.shift === input.shiftKey && input.key === ' ';
  return chord.shift === input.shiftKey && input.key === k;
}

export type ShortcutHandler = () => void;

export interface ShortcutRegistry {
  /** Enregistre un gestionnaire ; renvoie la fonction de désenregistrement. */
  register(id: ShortcutId, handler: ShortcutHandler): () => void;
  /** Déclenche le gestionnaire correspondant ; renvoie l'identifiant traité ou null. */
  handle(input: KeyInput): ShortcutId | null;
  /** Raccourcis ayant un gestionnaire actif (aide contextuelle). */
  activeIds(): ShortcutId[];
}

export function createShortcutRegistry(): ShortcutRegistry {
  const handlers = new Map<ShortcutId, ShortcutHandler[]>();
  const chords = (Object.keys(SHORTCUTS) as ShortcutId[])
    .filter((id) => SHORTCUTS[id].scope !== 'global')
    .map((id) => ({ id, chord: parseChord(SHORTCUTS[id].keys), inEditable: SHORTCUTS[id].inEditable }));

  return {
    register: (id, handler) => {
      handlers.set(id, [...(handlers.get(id) ?? []), handler]);
      return () => {
        const remaining = (handlers.get(id) ?? []).filter((h) => h !== handler);
        if (remaining.length > 0) handlers.set(id, remaining);
        else handlers.delete(id);
      };
    },
    handle: (input) => {
      for (const { id, chord, inEditable } of chords) {
        if (input.editable && !inEditable) continue;
        if (!matchesChord(chord, input)) continue;
        const handler = handlers.get(id)?.at(-1);
        if (!handler) continue;
        handler();
        return id;
      }
      return null;
    },
    activeIds: () => [...handlers.keys()],
  };
}

/** Convertit un événement clavier du DOM (écouteur posé par la coquille sur `window`). */
export function toKeyInput(event: KeyboardEvent): KeyInput {
  const target = event.target;
  const editable =
    typeof HTMLElement !== 'undefined' &&
    target instanceof HTMLElement &&
    (target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');
  return {
    key: event.key,
    code: event.code,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    metaKey: event.metaKey,
    editable,
  };
}
