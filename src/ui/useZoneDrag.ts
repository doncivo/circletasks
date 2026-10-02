import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefCallback } from 'react';

/**
 * Glisser-déposer d'éléments entre zones (S-02 : cartes de la Semaine d'un jour à l'autre, S-06 : depuis « Un jour »), sans
 * dépendance. Complète `useSortable` (A-02), limité à une seule liste verticale.
 *
 * Contrat DOM : une zone est un élément `data-drop-zone="<id>"` ; un élément déplaçable porte `data-drag-id="<id>"` (posé par
 * `itemProps`) et se trouve dans une zone.
 *
 * - Souris : le glisser démarre après 4 px de déplacement ; un simple clic n'est pas un glisser, et le clic qui suit un glisser est
 *   ignoré (il n'ouvre pas la fiche).
 * - Tactile et stylet : il faut un appui long (400 ms par défaut) sans bouger pour saisir l'élément ; un toucher bref reste un clic
 *   et un défilement avant la fin de l'appui n'est jamais gêné. Une fois saisi, le défilement de la page est suspendu.
 * - Défilement automatique près du bord haut ou bas du conteneur défilant sous le doigt ou le curseur.
 * - Échap, ou l'annulation du pointeur, abandonne le glisser sans rien déplacer ; un lâcher hors de toute zone ne fait rien.
 * - L'élément suit le pointeur par une « carte volante » (`attachGhost`) positionnée sans repasser par React : seuls l'élément
 *   saisi, la zone survolée et la position d'insertion sont de l'état.
 */
export interface ZoneDragState {
  readonly id: string;
  /** Zone survolée, ou null hors de toute zone. */
  readonly zone: string | null;
  /** Position d'insertion dans la zone survolée : nombre d'autres éléments au-dessus du pointeur (position finale visée). */
  readonly index: number | null;
  readonly mode: 'mouse' | 'touch';
}

export interface UseZoneDragOptions {
  /** L'élément peut-il être saisi ? (routines, événements : non) */
  readonly isMovable: (id: string) => boolean;
  /** Lâcher dans une zone : `index` est la position finale visée dans cette zone. */
  readonly onDrop: (id: string, zone: string, index: number) => void;
  readonly disabled?: boolean;
  /** Durée de l'appui long tactile, en ms. */
  readonly longPressMs?: number;
}

export interface ZoneDrag {
  readonly drag: ZoneDragState | null;
  /** À poser sur l'élément enveloppant la carte déplaçable. */
  itemProps(id: string): {
    'data-drag-id': string;
    'data-dragging': 'true' | undefined;
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  };
  /** À poser sur la carte volante affichée pendant le glisser (position pilotée directement). */
  readonly attachGhost: RefCallback<HTMLElement>;
}

const THRESHOLD_PX = 4;
/** Déplacement toléré pendant l'appui long avant d'y voir un défilement (et d'abandonner la saisie). */
const LONG_PRESS_SLOP_PX = 10;
const DEFAULT_LONG_PRESS_MS = 400;
const EDGE_PX = 64;
const MAX_SCROLL_PX_PER_FRAME = 18;
const IGNORED_TARGETS = 'input, textarea, select, [contenteditable="true"], [role="checkbox"]';

function isScrollable(element: Element): boolean {
  const { overflowY } = getComputedStyle(element);
  return (overflowY === 'auto' || overflowY === 'scroll') && element.scrollHeight > element.clientHeight;
}

function scrollParentOf(start: Element | null): HTMLElement | null {
  for (let element = start; element; element = element.parentElement) {
    if (isScrollable(element)) return element as HTMLElement;
  }
  return null;
}

/** Zone et position d'insertion sous le point (x, y), hors élément saisi ; null hors de toute zone. */
function hitTest(x: number, y: number, draggedId: string): { zone: string; index: number } | null {
  const stack = typeof document.elementsFromPoint === 'function' ? document.elementsFromPoint(x, y) : [];
  const zoneElement = stack.map((element) => element.closest<HTMLElement>('[data-drop-zone]')).find((found) => found !== null) ?? null;
  const zone = zoneElement?.dataset['dropZone'];
  if (!zoneElement || zone === undefined) return null;
  let index = 0;
  for (const item of zoneElement.querySelectorAll<HTMLElement>('[data-drag-id]')) {
    if (item.dataset['dragId'] === draggedId) continue;
    const rect = item.getBoundingClientRect();
    if (rect.top + rect.height / 2 < y) index += 1;
  }
  return { zone, index };
}

export function useZoneDrag(options: UseZoneDragOptions): ZoneDrag {
  const [drag, setDrag] = useState<ZoneDragState | null>(null);
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  const ghost = useRef<HTMLElement | null>(null);
  const cleanup = useRef<(() => void) | null>(null);

  const attachGhost = useCallback<RefCallback<HTMLElement>>((element) => {
    ghost.current = element;
  }, []);

  useEffect(() => () => cleanup.current?.(), []);

  const begin = useCallback((event: ReactPointerEvent<HTMLElement>, id: string): void => {
    const { isMovable, disabled, longPressMs } = latest.current;
    if (disabled || cleanup.current || !isMovable(id)) return;
    const mode = event.pointerType === 'touch' || event.pointerType === 'pen' ? 'touch' : 'mouse';
    if (mode === 'mouse' && event.button !== 0) return;
    if ((event.target as HTMLElement).closest(IGNORED_TARGETS)) return;

    const pointerId = event.pointerId;
    const origin = event.currentTarget;
    let x = event.clientX;
    let y = event.clientY;
    const startX = x;
    const startY = y;
    let started = false;
    let hovered: { zone: string; index: number } | null = null;
    let frame = 0;
    let longPress = 0;
    const listeners: (() => void)[] = [];
    const listen = <K extends keyof WindowEventMap>(type: K, handler: (event: WindowEventMap[K]) => void, capture = false): void => {
      window.addEventListener(type, handler, capture);
      listeners.push(() => window.removeEventListener(type, handler, capture));
    };

    const place = (): void => {
      if (ghost.current) ghost.current.style.transform = `translate(${String(x + 12)}px, ${String(y + 12)}px) rotate(-3deg)`;
    };

    /** À chaque image : défilement automatique, puis zone et position d'insertion sous le pointeur. */
    const tick = (): void => {
      frame = requestAnimationFrame(tick);
      place();
      const under = typeof document.elementsFromPoint === 'function' ? document.elementsFromPoint(x, y) : [];
      const container = scrollParentOf(under.find((element) => !element.closest('[data-drag-ghost]')) ?? null);
      if (container) {
        const rect = container.getBoundingClientRect();
        const edge = Math.min(EDGE_PX, rect.height / 3);
        if (y < rect.top + edge) container.scrollTop -= Math.ceil(MAX_SCROLL_PX_PER_FRAME * Math.min(1, (rect.top + edge - y) / edge));
        else if (y > rect.bottom - edge) container.scrollTop += Math.ceil(MAX_SCROLL_PX_PER_FRAME * Math.min(1, (y - (rect.bottom - edge)) / edge));
      }
      const hit = hitTest(x, y, id);
      if (hit?.zone !== hovered?.zone || hit?.index !== hovered?.index) {
        hovered = hit;
        setDrag({ id, zone: hit?.zone ?? null, index: hit?.index ?? null, mode });
      }
    };

    const start = (): void => {
      started = true;
      // La souris sortie de la fenêtre doit encore livrer le lâcher.
      try {
        origin.setPointerCapture?.(pointerId);
      } catch {
        // pointeur déjà libéré : le glisser continue par les écouteurs de la fenêtre
      }
      hovered = hitTest(x, y, id);
      setDrag({ id, zone: hovered?.zone ?? null, index: hovered?.index ?? null, mode });
      place();
      frame = requestAnimationFrame(tick);
    };

    const stop = (): void => {
      window.clearTimeout(longPress);
      cancelAnimationFrame(frame);
      for (const off of listeners) off();
      cleanup.current = null;
      setDrag(null);
    };
    cleanup.current = stop;

    const onMove = (move: PointerEvent): void => {
      if (move.pointerId !== pointerId) return;
      x = move.clientX;
      y = move.clientY;
      if (started) return;
      const moved = Math.hypot(x - startX, y - startY);
      if (mode === 'mouse') {
        if (moved >= THRESHOLD_PX) start();
      } else if (moved > LONG_PRESS_SLOP_PX) {
        stop(); // le doigt a bougé avant la fin de l'appui : c'est un défilement, pas une saisie
      }
    };

    const onUp = (up: PointerEvent): void => {
      if (up.pointerId !== pointerId) return;
      x = up.clientX;
      y = up.clientY;
      const wasStarted = started;
      const target = wasStarted ? (hitTest(x, y, id) ?? hovered) : null;
      stop();
      if (!wasStarted) return;
      // Le clic synthétique qui suit un glisser ne doit pas ouvrir la fiche.
      const swallow = (click: Event): void => {
        click.stopPropagation();
        click.preventDefault();
      };
      window.addEventListener('click', swallow, { capture: true, once: true });
      window.setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
      if (target) latest.current.onDrop(id, target.zone, target.index);
    };

    listen('pointermove', onMove);
    listen('pointerup', onUp);
    listen('pointercancel', (cancel) => {
      if (cancel.pointerId === pointerId) stop();
    });
    listen(
      'keydown',
      (key) => {
        if (key.key === 'Escape' && started) {
          key.stopPropagation();
          stop();
        }
      },
      true,
    );

    if (mode === 'touch') {
      // Une fois l'élément saisi, le doigt ne doit plus faire défiler la page : l'écouteur non passif doit exister avant le premier
      // `touchmove` pour que `preventDefault` soit pris en compte.
      const block = (touch: TouchEvent): void => {
        if (started && touch.cancelable) touch.preventDefault();
      };
      window.addEventListener('touchmove', block, { passive: false });
      listeners.push(() => window.removeEventListener('touchmove', block));
      // Pas de menu contextuel ni de sélection de texte déclenchés par l'appui long.
      const noMenu = (menu: Event): void => menu.preventDefault();
      origin.addEventListener('contextmenu', noMenu);
      listeners.push(() => origin.removeEventListener('contextmenu', noMenu));
      longPress = window.setTimeout(start, longPressMs ?? DEFAULT_LONG_PRESS_MS);
    }
  }, []);

  return {
    drag,
    itemProps: (id) => ({
      'data-drag-id': id,
      'data-dragging': drag?.id === id ? 'true' : undefined,
      onPointerDown: (event) => begin(event, id),
    }),
    attachGhost,
  };
}
