import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { DRAG_THRESHOLD_PX, createWindowListeners, pointerModeOf, swallowClickAfterDrag } from './dragPrimitive';
import './Sortable.css';

/**
 * Glisser-déposer vertical d'une liste (A-02) : souris, tactile et stylet, sans dépendance.
 *
 * - Souris : on saisit la ligne ou sa poignée ; indicateur d'insertion entre les lignes.
 * - Tactile : on ne saisit que la poignée (le défilement de la liste reste libre) ; les autres lignes
 *   s'écartent pour faire place à la ligne tenue.
 * - Un simple clic (sans déplacement d'au moins 4 px) n'est pas un glisser ; le clic qui suit un glisser est
 *   ignoré pour ne pas ouvrir la fiche en lâchant.
 * - Échap, ou l'annulation du pointeur, abandonne le glisser sans rien déplacer.
 * - Au clavier, le déplacement passe par les raccourcis Alt+↑ / Alt+↓ (registre de raccourcis) et par les
 *   flèches sur la poignée, gérés par l'appelant : ce hook ne traite que le pointeur.
 *
 * `ids` : éléments de la liste dans l'ordre affiché, qu'ils soient déplaçables ou non ; `onMove(id, toIndex)`
 * reçoit la position finale visée dans cette liste. C'est à l'appelant (domaine) de refuser ou de ramener une
 * destination interdite.
 */
export interface SortableDrag {
  readonly id: string;
  /** Position visée dans `ids` (celle qu'aurait la ligne si on la lâchait maintenant). */
  readonly toIndex: number;
  readonly mode: 'mouse' | 'touch';
  readonly offsetY: number;
  readonly height: number;
}

export interface UseSortableOptions {
  readonly ids: readonly string[];
  readonly onMove: (id: string, toIndex: number) => void;
  /** Une ligne peut-elle être saisie ? (routines, éléments terminés : non) */
  readonly isMovable?: (id: string) => boolean;
  readonly disabled?: boolean;
}

export type DragSource = 'row' | 'handle';

export interface Sortable {
  readonly containerProps: {
    readonly ref: RefObject<HTMLDivElement>;
    readonly className: string;
    readonly 'data-sorting': 'true' | undefined;
  };
  readonly drag: SortableDrag | null;
  /** À poser sur l'élément enveloppant la ligne. */
  itemProps(id: string): { 'data-sortable-id': string; 'data-dragging': 'true' | undefined; 'data-drop': 'before' | 'after' | undefined; style: CSSProperties | undefined };
  /** À poser sur la ligne (`row`, souris) ou sur la poignée (`handle`, tous pointeurs). */
  dragProps(id: string, source: DragSource): { onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void };
}

const INTERACTIVE_TEXT = 'input, textarea, select, [contenteditable="true"]';

interface Session {
  readonly id: string;
  readonly startX: number;
  readonly startY: number;
  readonly pointerId: number | undefined;
  readonly mode: 'mouse' | 'touch';
  readonly startIndex: number;
  centers: Map<string, number>;
  height: number;
  ownCenter: number;
  active: boolean;
  toIndex: number;
}

export function useSortable(options: UseSortableOptions): Sortable {
  const containerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<SortableDrag | null>(null);
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  const session = useRef<Session | null>(null);
  const cleanup = useRef<(() => void) | null>(null);

  const stop = useCallback((): void => {
    cleanup.current?.();
    cleanup.current = null;
    session.current = null;
    setDrag(null);
  }, []);

  useEffect(() => () => cleanup.current?.(), []);

  const begin = useCallback(
    (event: ReactPointerEvent<HTMLElement>, id: string, source: DragSource): void => {
      const { ids, isMovable, disabled } = latest.current;
      if (disabled || (isMovable && !isMovable(id)) || session.current) return;
      const mode = pointerModeOf(event);
      if (mode === 'mouse' && event.button !== 0) return;
      if (source === 'row' && mode !== 'mouse') return;
      if (source === 'row' && (event.target as HTMLElement).closest(INTERACTIVE_TEXT)) return;
      const startIndex = ids.indexOf(id);
      if (startIndex < 0) return;

      const current: Session = {
        id,
        startX: event.clientX,
        startY: event.clientY,
        pointerId: event.pointerId,
        mode,
        startIndex,
        centers: new Map(),
        height: 0,
        ownCenter: 0,
        active: false,
        toIndex: startIndex,
      };
      session.current = current;

      /** Mesure les lignes au moment où le glisser démarre (la liste ne bouge pas pendant le glisser). */
      const measure = (): void => {
        const root = containerRef.current;
        if (!root) return;
        for (const element of root.querySelectorAll<HTMLElement>('[data-sortable-id]')) {
          const key = element.dataset['sortableId'] ?? '';
          const rect = element.getBoundingClientRect();
          current.centers.set(key, rect.top + rect.height / 2);
          if (key === id) {
            current.height = rect.height;
            current.ownCenter = rect.top + rect.height / 2;
          }
        }
      };

      const onMove = (move: PointerEvent): void => {
        if (current.pointerId !== undefined && move.pointerId !== undefined && move.pointerId !== current.pointerId) return;
        const dy = move.clientY - current.startY;
        if (!current.active) {
          if (Math.abs(dy) < DRAG_THRESHOLD_PX && Math.abs(move.clientX - current.startX) < DRAG_THRESHOLD_PX) return;
          current.active = true;
          measure();
        }
        const centerNow = current.ownCenter + dy;
        const others = latest.current.ids.filter((other) => other !== id);
        let toIndex = 0;
        for (const other of others) if ((current.centers.get(other) ?? Number.POSITIVE_INFINITY) < centerNow) toIndex += 1;
        current.toIndex = toIndex;
        setDrag({ id, toIndex, mode, offsetY: dy, height: current.height });
      };

      const finish = (up: PointerEvent): void => {
        if (current.pointerId !== undefined && up.pointerId !== undefined && up.pointerId !== current.pointerId) return;
        const wasActive = current.active;
        const target = current.toIndex;
        stop();
        if (!wasActive) return;
        swallowClickAfterDrag();
        if (target !== current.startIndex) latest.current.onMove(id, target);
      };

      const onKey = (key: KeyboardEvent): void => {
        if (key.key === 'Escape') {
          key.stopPropagation();
          stop();
        }
      };

      const windowListeners = createWindowListeners();
      windowListeners.listen('pointermove', onMove);
      windowListeners.listen('pointerup', finish);
      windowListeners.listen('pointercancel', stop);
      windowListeners.listen('keydown', onKey, true);
      cleanup.current = windowListeners.removeAll;
    },
    [stop],
  );

  const itemProps: Sortable['itemProps'] = (id) => {
    const empty = { 'data-sortable-id': id, 'data-dragging': undefined, 'data-drop': undefined, style: undefined } as const;
    if (!drag) return empty;
    if (drag.id === id) {
      return { ...empty, 'data-dragging': 'true', style: { transform: `translateY(${drag.offsetY}px)` } };
    }
    const ids = options.ids;
    const from = ids.indexOf(drag.id);
    const index = ids.indexOf(id);
    if (drag.mode === 'touch') {
      // Les lignes s'écartent : celles que la ligne tenue a dépassées reculent d'une hauteur de ligne.
      let shift = 0;
      if (from < drag.toIndex && index > from && index <= drag.toIndex) shift = -drag.height;
      else if (from > drag.toIndex && index < from && index >= drag.toIndex) shift = drag.height;
      return shift === 0 ? empty : { ...empty, style: { transform: `translateY(${shift}px)` } };
    }
    // Souris : indicateur d'insertion avant la ligne qui prendra la suite, ou après la dernière.
    const others = ids.filter((other) => other !== drag.id);
    const target = others[drag.toIndex];
    if (target === id) return { ...empty, 'data-drop': 'before' };
    if (target === undefined && others[others.length - 1] === id) return { ...empty, 'data-drop': 'after' };
    return empty;
  };

  return {
    containerProps: { ref: containerRef, className: 'ct-sortable', 'data-sorting': drag ? 'true' : undefined },
    drag,
    itemProps,
    dragProps: (id, source) => ({ onPointerDown: (event) => begin(event, id, source) }),
  };
}
