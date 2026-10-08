import { Check, RotateCcw } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { t } from '../i18n';
import { swallowClickAfterDrag } from './dragPrimitive';
import { Icon } from './Icon';
import './SwipeRow.css';

/**
 * Geste de ligne sur iPhone (A-07, ADR 0013 §1.3) : balayage à droite (terminer / rouvrir), balayage à gauche (jusqu'à trois boutons
 * de 62 px), appui long. Composant d'interface pur : il ne connaît ni tâche ni cas d'usage, les écrans lui donnent des rappels. Il ne
 * lit pas `src/platform` : le retour haptique passe par `feedback`.
 *
 * Règle de geste (constantes exportées, testées) :
 * - toucher et stylet seulement ; la souris est ignorée (PC inchangé) ;
 * - le geste est pris à 10 px de déplacement horizontal, si celui-ci vaut au moins deux fois le vertical ; un déplacement vertical de
 *   plus de 12 px qui domine l'horizontal avant la prise est un défilement : le geste est abandonné ;
 * - à droite : validation à 40 % de la largeur, ou vite (40 px au moins à 0,5 px/ms) ;
 * - à gauche : ouverture à 62 px, ou vite ; la ligne reste ouverte, aucune action n'est lancée par le seul balayage ;
 * - appui long : 500 ms sans dépasser 8 px.
 */
export const SWIPE_ROW_RULES = {
  /** Déplacement horizontal minimal avant la prise du geste (px). */
  lockPx: 10,
  /** Rapport horizontal / vertical minimal (2 pour 1, comme `useSwipe`). */
  lockRatio: 2,
  /** Déplacement vertical qui abandonne le geste (défilement, px). */
  scrollAbandonPx: 12,
  /** Part de la largeur à parcourir vers la droite pour valider. */
  commitRatio: 0.4,
  /** Geste rapide : distance minimale (px) et vitesse minimale (px/ms). */
  fastPx: 40,
  fastPxPerMs: 0.5,
  /** Largeur d'un bouton révélé à gauche (px). */
  actionWidthPx: 62,
  /** Appui long : durée (ms) et tolérance de déplacement (px). */
  longPressMs: 500,
  longPressSlopPx: 8,
  /** Balayage à droite d'une ligne ouverte : distance qui la referme (px). */
  closeDistancePx: 24,
} as const;

/** Retour haptique du geste (cosmétique) ; l'adaptateur `rowGestureFeedback` vit dans `src/features/app`. */
export interface RowGestureFeedback {
  /** Premier franchissement des 40 % pendant le balayage à droite (une fois par geste). */
  threshold(): void;
  /** Ouverture de la ligne par le balayage à gauche. */
  open(): void;
  /** Lâcher validant le balayage à droite. */
  commit(): void;
  /** Cas d'usage abouti (jamais après un échec). */
  succeeded(): void;
  /** Appui long reconnu. */
  longPress(): void;
}

export interface SwipeRowAction {
  readonly id: string;
  /** « Reporter » ; nom accessible du bouton masqué : « {label} : {title} » (ou `ariaLabel` s'il est fourni). */
  readonly label: string;
  readonly ariaLabel?: string;
  /** Icône de 20 px (Lucide au trait, ou `SomedayIcon`), déjà rendue par l'appelant. */
  readonly icon: ReactNode;
  /** Gamme de la maquette Gestes.html : #C9BEE6 / #5B43A8 / #A1271C. */
  readonly tone: 'soft' | 'accent' | 'danger';
  readonly onSelect: () => void;
}

export interface SwipeRowRight {
  readonly label: string;
  readonly tone: 'complete' | 'reopen';
  /** Rend vrai si le cas d'usage a abouti (retour haptique de succès seulement alors). */
  readonly onCommit: () => Promise<boolean>;
}

export interface SwipeRowProps {
  readonly rowId: string;
  readonly title: string;
  /** Balayage à droite ; null : aucun. */
  readonly right: SwipeRowRight | null;
  /** 0 à 3 boutons de 62 px révélés par le balayage à gauche. */
  readonly left: readonly SwipeRowAction[];
  /** Appui long ; null dans la Semaine (le glisser S-02 garde l'appui long). */
  readonly onLongPress: (() => void) | null;
  /** Mode édition (A-05), glisser en cours (S-02, A-02) : aucun geste, aucun bouton. */
  readonly disabled: boolean;
  readonly feedback?: RowGestureFeedback | undefined;
  readonly children: ReactNode;
}

interface GroupValue {
  readonly openId: string | null;
  readonly setOpenId: (updater: (current: string | null) => string | null) => void;
}

const GroupContext = createContext<GroupValue | null>(null);

/** Une seule ligne ouverte par groupe : ouvrir une ligne referme la précédente. */
export function SwipeRowGroup({ children }: { readonly children: ReactNode }) {
  const [openId, setOpenId] = useState<string | null>(null);
  return <GroupContext.Provider value={{ openId, setOpenId }}>{children}</GroupContext.Provider>;
}

/** Départs ignorés : champs de saisie et zones qui gèrent leur propre toucher. */
const IGNORED_TARGETS = 'input, textarea, select, [contenteditable], [data-no-row-gesture]';

type Side = 'right' | 'left';

interface Gesture {
  readonly pointerId: number;
  readonly x0: number;
  readonly y0: number;
  readonly t0: number;
  readonly width: number;
  /** Position de départ de la ligne : 0 (fermée) ou −largeur des boutons (ouverte). */
  readonly base: number;
  mode: 'pending' | 'swipe' | 'dead';
  side: Side | null;
  x: number;
  passed: boolean;
}

/**
 * Focus vers la ligne voisine (suivante, sinon précédente) de la ligne `rowId`, à rappeler une fois l'action faite (A-07 critère 17 :
 * après « Terminer » ou une suppression, le focus ne reste pas sur une ligne disparue). Le voisin est choisi avant l'action ; sans ligne
 * `SwipeRow` correspondante (PC), le rappel ne fait rien.
 */
export function focusNeighborLater(rowId: string, force = false): () => void {
  const row = document.querySelector<HTMLElement>(`[data-swipe-row="${CSS.escape(rowId)}"]`);
  const item = row?.closest<HTMLElement>('[role="listitem"], .ct-week__itemSlot') ?? row;
  const neighbor = item?.nextElementSibling ?? item?.previousElementSibling ?? null;
  const active = document.activeElement;
  // Le focus n'est déplacé que s'il était dans la ligne (ou nulle part) : jamais volé à un autre contrôle.
  const concerned = force || !active || active === document.body || (row?.contains(active) ?? false);
  return () => {
    if (!concerned || !neighbor?.isConnected) return;
    const target = neighbor.querySelector<HTMLElement>('button.ct-list-row__title, button.ct-week-item__title, button:not([tabindex="-1"])');
    target?.focus();
  };
}

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

export function SwipeRow({ rowId, title, right, left, onLongPress, disabled, feedback, children }: SwipeRowProps) {
  const group = useContext(GroupContext);
  const [localOpen, setLocalOpen] = useState(false);
  const open = group ? group.openId === rowId : localOpen;
  const setOpen = useCallback(
    (value: boolean): void => {
      if (group) group.setOpenId((current) => (value ? rowId : current === rowId ? null : current));
      else setLocalOpen(value);
    },
    [group, rowId],
  );
  // Côté révélé pendant un geste ; au repos ouvert, les boutons de gauche restent révélés.
  const [dragSide, setReveal] = useState<Side | null>(null);
  // Désactivée (mode édition, glisser) : le côté révélé est oublié (ajustement pendant le rendu).
  const [prevDisabled, setPrevDisabled] = useState(disabled);
  if (prevDisabled !== disabled) {
    setPrevDisabled(disabled);
    setReveal(null);
  }

  const rootRef = useRef<HTMLDivElement>(null);
  const frontRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const longPressTimer = useRef(0);
  const longFired = useRef(false);
  const busy = useRef(false);
  const mounted = useRef(true);
  const closedByTap = useRef(false);
  const stopBlocking = useRef<(() => void) | null>(null);
  const latest = useRef({ right, left, onLongPress, disabled, feedback, open });
  useEffect(() => {
    latest.current = { right, left, onLongPress, disabled, feedback, open };
  });

  const openWidth = SWIPE_ROW_RULES.actionWidthPx * left.length;

  /** Pose la ligne à `x` px : directement dans le DOM pendant le geste (pas de rendu React par mouvement). */
  const place = useCallback((x: number, animate: boolean): void => {
    const front = frontRef.current;
    if (!front) return;
    front.dataset['animate'] = animate ? 'true' : 'false';
    front.style.transform = x === 0 ? '' : `translateX(${String(x)}px)`;
  }, []);

  const clearLongPress = useCallback((): void => {
    window.clearTimeout(longPressTimer.current);
    longPressTimer.current = 0;
  }, []);

  const endGesture = useCallback((): void => {
    clearLongPress();
    gesture.current = null;
    stopBlocking.current?.();
    stopBlocking.current = null;
  }, [clearLongPress]);

  useEffect(
    () => () => {
      mounted.current = false;
      window.clearTimeout(longPressTimer.current);
      stopBlocking.current?.();
    },
    [],
  );

  // Position au repos : suit l'état ouvert / fermé (aussi quand une autre ligne du groupe s'ouvre, ou après un toucher ailleurs).
  useEffect(() => {
    if (gesture.current?.mode === 'swipe' || busy.current) return;
    place(open && openWidth > 0 ? -openWidth : 0, true);
  }, [open, openWidth, place]);

  // `disabled` (mode édition, glisser) : le geste en cours est abandonné et la ligne se referme.
  useEffect(() => {
    if (!disabled) return;
    endGesture();
    place(0, false);
    // Fermeture hors du corps de l'effet (la ligne rouverte plus tard ne doit pas retrouver un état ouvert périmé).
    queueMicrotask(() => setOpen(false));
  }, [disabled, endGesture, place, setOpen]);

  // Ligne ouverte : un toucher ailleurs ou un défilement la referme.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      const buttons = rootRef.current?.querySelector('.ct-swipe-row__under--left');
      if (target && buttons?.contains(target)) return;
      closedByTap.current = target !== null && (frontRef.current?.contains(target) ?? false);
      if (closedByTap.current) {
        // Le clic qui suit ce toucher ne doit pas atteindre la ligne : il est avalé une fois, puis le repère est retiré.
        const release = (): void => {
          window.setTimeout(() => {
            closedByTap.current = false;
          }, 0);
        };
        window.addEventListener('pointerup', release, { once: true });
        window.addEventListener('pointercancel', release, { once: true });
      }
      setOpen(false);
    };
    const onScroll = (): void => setOpen(false);
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, setOpen]);

  const kill = (): void => {
    const current = gesture.current;
    if (current) current.mode = 'dead';
    clearLongPress();
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>): void => {
    const state = latest.current;
    if (state.disabled || (event.pointerType !== 'touch' && event.pointerType !== 'pen')) return;
    if ((event.target as HTMLElement).closest(IGNORED_TARGETS)) return;
    if (gesture.current) return; // un seul doigt
    longFired.current = false;
    const width = event.currentTarget.getBoundingClientRect().width;
    const base = state.open ? -SWIPE_ROW_RULES.actionWidthPx * state.left.length : 0;
    gesture.current = { pointerId: event.pointerId, x0: event.clientX, y0: event.clientY, t0: event.timeStamp, width, base, mode: 'pending', side: null, x: base, passed: false };
    // Les mouvements de page pendant un balayage pris sont bloqués (l'écouteur doit exister avant le premier `touchmove`).
    const block = (touch: TouchEvent): void => {
      if (gesture.current?.mode === 'swipe' && touch.cancelable) touch.preventDefault();
    };
    window.addEventListener('touchmove', block, { passive: false });
    stopBlocking.current = () => window.removeEventListener('touchmove', block);
    if (state.onLongPress && !state.open) {
      longPressTimer.current = window.setTimeout(() => {
        const current = gesture.current;
        if (!current || current.mode !== 'pending') return;
        current.mode = 'dead';
        longFired.current = true;
        latest.current.feedback?.longPress();
        latest.current.onLongPress?.();
      }, SWIPE_ROW_RULES.longPressMs);
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>): void => {
    const current = gesture.current;
    if (!current || event.pointerId !== current.pointerId || current.mode === 'dead') return;
    if (latest.current.disabled) {
      kill();
      return;
    }
    const dx = event.clientX - current.x0;
    const dy = event.clientY - current.y0;
    if (current.mode === 'pending') {
      if (Math.hypot(dx, dy) > SWIPE_ROW_RULES.longPressSlopPx) clearLongPress();
      if (Math.abs(dy) > SWIPE_ROW_RULES.scrollAbandonPx && Math.abs(dy) > Math.abs(dx)) {
        kill(); // défilement vertical
        return;
      }
      if (Math.abs(dx) < SWIPE_ROW_RULES.lockPx || Math.abs(dx) < SWIPE_ROW_RULES.lockRatio * Math.abs(dy)) return;
      const state = latest.current;
      const side: Side = current.base < 0 ? 'left' : dx > 0 ? 'right' : 'left';
      if ((side === 'right' && !state.right) || (side === 'left' && state.left.length === 0)) {
        kill();
        return;
      }
      current.mode = 'swipe';
      current.side = side;
      clearLongPress();
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId);
      } catch {
        // pointeur déjà libéré : le geste continue sans capture
      }
      setReveal(side);
    }
    const max = SWIPE_ROW_RULES.actionWidthPx * latest.current.left.length;
    const x = current.side === 'right' ? clamp(current.base + dx, 0, current.width) : clamp(current.base + dx, -max, 0);
    current.x = x;
    place(x, false);
    if (current.side === 'right' && !current.passed && current.width > 0 && x >= SWIPE_ROW_RULES.commitRatio * current.width) {
      current.passed = true;
      latest.current.feedback?.threshold();
    }
  };

  const finishRight = async (action: SwipeRowRight): Promise<void> => {
    busy.current = true;
    latest.current.feedback?.commit();
    const refocus = focusNeighborLater(rowId);
    // L'écran affiche l'erreur de son store ; un rejet inattendu compte comme un échec (jamais de succès haptique).
    const ok = await action.onCommit().catch(() => false);
    busy.current = false;
    if (ok) {
      latest.current.feedback?.succeeded();
      refocus();
    }
    if (!mounted.current) return;
    place(0, true);
    setReveal(null);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLElement>): void => {
    const current = gesture.current;
    if (!current || event.pointerId !== current.pointerId) return;
    // Un lâcher sans mouvement intermédiaire (geste très rapide) est évalué comme un dernier mouvement.
    if (current.mode !== 'dead') onPointerMove(event);
    const wasLong = longFired.current;
    const wasSwipe = current.mode === 'swipe';
    endGesture();
    if (wasLong) {
      swallowClickAfterDrag();
      return;
    }
    if (!wasSwipe) return;
    swallowClickAfterDrag();
    const state = latest.current;
    const dx = current.x - current.base;
    const elapsed = Math.max(1, event.timeStamp - current.t0);
    const fast = Math.abs(dx) >= SWIPE_ROW_RULES.fastPx && Math.abs(dx) / elapsed >= SWIPE_ROW_RULES.fastPxPerMs;
    const width = SWIPE_ROW_RULES.actionWidthPx * state.left.length;
    if (current.side === 'right') {
      const far = current.width > 0 && current.x >= SWIPE_ROW_RULES.commitRatio * current.width;
      if (state.right && (far || (fast && dx > 0))) {
        place(0, true);
        void finishRight(state.right);
      } else {
        place(0, true);
        setReveal(null);
      }
      return;
    }
    if (current.base < 0) {
      // Ligne ouverte : un balayage vers la droite la referme, sinon elle reste ouverte.
      if (dx >= SWIPE_ROW_RULES.closeDistancePx || (fast && dx > 0)) {
        setOpen(false);
        place(0, true);
        setReveal(null);
      } else place(-width, true);
      return;
    }
    if (-dx >= SWIPE_ROW_RULES.actionWidthPx || (fast && dx < 0)) {
      place(-width, true);
      state.feedback?.open();
      setOpen(true);
    } else {
      place(0, true);
      setReveal(null);
    }
  };

  const onPointerCancel = (event: ReactPointerEvent<HTMLElement>): void => {
    const current = gesture.current;
    if (!current || event.pointerId !== current.pointerId) return;
    const wasSwipe = current.mode === 'swipe';
    endGesture();
    if (wasSwipe) {
      place(latest.current.open ? -openWidth : 0, true);
      if (!latest.current.open) setReveal(null);
    }
  };

  const select = (action: SwipeRowAction): void => {
    setOpen(false);
    action.onSelect();
  };

  const active = !disabled;
  const reveal: Side | null = active ? (dragSide ?? (open && openWidth > 0 ? 'left' : null)) : null;
  return (
    <div
      ref={rootRef}
      className="ct-swipe-row"
      data-row-gesture=""
      data-swipe-row={rowId}
      data-reveal={reveal ?? undefined}
      data-open={open && active ? 'true' : undefined}
      {...(active ? { onPointerDown, onPointerMove, onPointerUp, onPointerCancel } : {})}
      onContextMenu={(event) => {
        if (gesture.current || longFired.current) event.preventDefault();
      }}
    >
      {active && reveal === 'right' && right && (
        <div className="ct-swipe-row__under ct-swipe-row__under--right" data-tone={right.tone} aria-hidden="true">
          <Icon icon={right.tone === 'complete' ? Check : RotateCcw} size={24} strokeWidth={2.6} />
          <span>{right.label}</span>
        </div>
      )}
      {active && reveal === 'left' && left.length > 0 && (
        <div className="ct-swipe-row__under ct-swipe-row__under--left" aria-hidden="true">
          {left.map((action) => (
            <button
              key={action.id}
              type="button"
              className="ct-swipe-row__button"
              data-tone={action.tone}
              data-action={action.id}
              data-no-row-gesture=""
              tabIndex={-1}
              onClick={() => select(action)}
            >
              {action.icon}
              <span>{action.label}</span>
            </button>
          ))}
        </div>
      )}
      <div
        ref={frontRef}
        className="ct-swipe-row__front"
        data-animate="false"
        onClickCapture={(event) => {
          if (closedByTap.current) {
            closedByTap.current = false;
            event.stopPropagation();
            event.preventDefault();
          }
        }}
      >
        {children}
      </div>
      {active && left.length > 0 && (
        <div role="group" aria-label={t('gestures.actionsGroup', { title })} aria-expanded={open} className="ct-swipe-row__a11y">
          {left.map((action) => (
            <button
              key={action.id}
              type="button"
              className="ct-swipe-row__a11yButton"
              data-tone={action.tone}
              data-a11y-action={action.id}
              aria-label={action.ariaLabel ?? t('gestures.actionLabel', { action: action.label, title })}
              onClick={() => select(action)}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
