import type { PointerEvent as ReactPointerEvent } from 'react';

/**
 * Primitive de glisser commune à `useSortable` (une liste, A-02) et `useZoneDrag` (entre zones, S-02, S-06) : dette de l'ordre 3
 * soldée avec P-01. Les deux hooks gardent leur logique propre (mesure des lignes d'un côté, zones et appui long de l'autre) ;
 * ce module porte ce qu'ils partagent : le seuil de déplacement, le type de pointeur, le clic qui suit un glisser et la
 * pose / dépose groupée des écouteurs de fenêtre.
 */

/** Déplacement minimal (px) avant qu'un appui devienne un glisser : en deçà, c'est un clic. */
export const DRAG_THRESHOLD_PX = 4;

export type PointerMode = 'mouse' | 'touch';

/** Souris, ou tactile / stylet. */
export function pointerModeOf(event: Pick<ReactPointerEvent, 'pointerType'>): PointerMode {
  return event.pointerType === 'touch' || event.pointerType === 'pen' ? 'touch' : 'mouse';
}

/** Le clic synthétique qui suit un glisser ne doit pas ouvrir la fiche : il est avalé une fois (retiré au tour suivant s'il ne vient pas). */
export function swallowClickAfterDrag(): void {
  const swallow = (click: Event): void => {
    click.stopPropagation();
    click.preventDefault();
  };
  window.addEventListener('click', swallow, { capture: true, once: true });
  window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
}

/** Ensemble d'écouteurs de fenêtre retirés d'un coup. */
export interface WindowListeners {
  listen<K extends keyof WindowEventMap>(type: K, handler: (event: WindowEventMap[K]) => void, capture?: boolean): void;
  /** Ajoute une fonction de nettoyage arbitraire. */
  onRemove(off: () => void): void;
  removeAll(): void;
}

export function createWindowListeners(): WindowListeners {
  const offs: (() => void)[] = [];
  return {
    listen(type, handler, capture = false) {
      window.addEventListener(type, handler, capture);
      offs.push(() => window.removeEventListener(type, handler, capture));
    },
    onRemove(off) {
      offs.push(off);
    },
    removeAll() {
      for (const off of offs.splice(0)) off();
    },
  };
}
