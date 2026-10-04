import type { ShortcutRegistry } from './shortcuts';

/**
 * Le focus est-il dans la liste, ou nulle part (corps de page) ? Entrée n'ouvre le détail de la ligne sélectionnée que dans ce
 * cas : sur un autre bouton de l'écran (« Un jour », « Réglages »…), Entrée garde son effet natif.
 */
export function isListFocus(root: HTMLElement | null): boolean {
  const active = document.activeElement;
  if (active === null || active === document.body) return true;
  return root !== null && root.contains(active);
}

/** Où chercher les lignes d'une liste pour ↑ / ↓ (D-04). */
export interface ListNavigationTarget {
  /** Conteneur de la liste ; null tant qu'elle n'est pas montée. */
  readonly root: () => HTMLElement | null;
  /** Sélecteur d'une ligne, dans l'ordre d'affichage. */
  readonly itemSelector: string;
  /** Sélecteur, dans la ligne, de l'élément qui reçoit le focus (titre cliquable en priorité). */
  readonly focusSelector: string;
}

/**
 * ↑ / ↓ (registre de raccourcis) : donnent le focus à la ligne précédente / suivante de la liste. Actifs seulement si le focus est
 * dans la liste ou nulle part (corps de page) ; sinon le gestionnaire décline (`false`) et le défilement natif reste. Depuis le
 * corps de page, ↓ va à la première ligne et ↑ à la dernière. Les champs de saisie ne sont jamais concernés (raccourci non
 * `inEditable`). Les lignes réagissent au focus : la ligne atteinte devient la ligne « sélectionnée » (Espace, Ctrl+D, Suppr…).
 * Renvoie la fonction qui retire les deux raccourcis.
 */
export function registerListNavigation(registry: ShortcutRegistry, target: ListNavigationTarget): () => void {
  const move = (delta: 1 | -1) => (): boolean => {
    const root = target.root();
    if (!root) return false;
    const items = Array.from(root.querySelectorAll<HTMLElement>(target.itemSelector));
    if (items.length === 0) return false;
    const active = document.activeElement;
    const inside = active instanceof HTMLElement && root.contains(active);
    if (!inside && active !== null && active !== document.body) return false;
    const current = inside ? items.findIndex((item) => item.contains(active)) : -1;
    const next = current < 0 ? (delta > 0 ? 0 : items.length - 1) : Math.min(Math.max(current + delta, 0), items.length - 1);
    const row = items[next];
    const focusable = row?.querySelector<HTMLElement>(target.focusSelector) ?? row?.querySelector<HTMLElement>('button, [tabindex]');
    if (!focusable) return false;
    focusable.focus();
    return true;
  };
  const offs = [registry.register('list.previous', move(-1)), registry.register('list.next', move(1))];
  return () => {
    for (const off of offs) off();
  };
}
