import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';

/**
 * Balayage horizontal au toucher (S-03 : semaine suivante / précédente sur iPhone), sans dépendance.
 *
 * - Ne réagit qu'au toucher et au stylet (la souris a ses flèches et ses raccourcis).
 * - Il y a balayage si le geste est nettement horizontal (au moins deux fois plus de déplacement horizontal que vertical) et qu'il
 *   couvre au moins 30 % de la largeur de la zone, ou qu'il est assez rapide (40 px au moins à 0,5 px/ms ou plus).
 * - Un défilement vertical ne déclenche rien : dès que le geste est surtout vertical il est abandonné, et le navigateur qui prend
 *   la main (`pointercancel`) l'annule aussi. La zone doit déclarer `touch-action: pan-y` pour que le navigateur ne
 *   garde que le défilement vertical.
 * - `disabled` (ex. une carte tenue pour un glisser-déposer, S-02) abandonne le geste en cours.
 *
 * `onSwipe('left')` : le doigt est allé vers la gauche (semaine suivante) ; `'right'` : vers la droite (semaine précédente).
 */
export interface UseSwipeOptions {
  readonly onSwipe: (direction: 'left' | 'right') => void;
  readonly disabled?: boolean;
  /** Part de la largeur de la zone à parcourir (0,3 par défaut). */
  readonly distanceRatio?: number;
}

export interface SwipeHandlers {
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerCancel: () => void;
}

const MIN_FAST_DISTANCE_PX = 40;
const MIN_VELOCITY_PX_PER_MS = 0.5;
const VERTICAL_ABANDON_PX = 12;

interface Gesture {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly at: number;
  cancelled: boolean;
}

export function useSwipe({ onSwipe, disabled = false, distanceRatio = 0.3 }: UseSwipeOptions): SwipeHandlers {
  const gesture = useRef<Gesture | null>(null);
  const latest = useRef({ onSwipe, disabled });
  useEffect(() => {
    latest.current = { onSwipe, disabled };
  });

  return {
    onPointerDown: (event) => {
      if (event.pointerType === 'mouse') return;
      gesture.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, at: event.timeStamp, cancelled: false };
    },
    onPointerMove: (event) => {
      const current = gesture.current;
      if (!current || event.pointerId !== current.pointerId || current.cancelled) return;
      if (latest.current.disabled) {
        current.cancelled = true;
        return;
      }
      const dx = Math.abs(event.clientX - current.x);
      const dy = Math.abs(event.clientY - current.y);
      if (dy > VERTICAL_ABANDON_PX && dy > dx) current.cancelled = true; // défilement vertical
    },
    onPointerUp: (event) => {
      const current = gesture.current;
      gesture.current = null;
      if (!current || event.pointerId !== current.pointerId || current.cancelled || latest.current.disabled) return;
      const dx = event.clientX - current.x;
      const dy = event.clientY - current.y;
      if (Math.abs(dx) < 2 * Math.abs(dy)) return;
      const width = event.currentTarget.getBoundingClientRect().width;
      const elapsed = Math.max(1, event.timeStamp - current.at);
      const far = width > 0 && Math.abs(dx) >= width * distanceRatio;
      const fast = Math.abs(dx) >= MIN_FAST_DISTANCE_PX && Math.abs(dx) / elapsed >= MIN_VELOCITY_PX_PER_MS;
      if (far || fast) latest.current.onSwipe(dx < 0 ? 'left' : 'right');
    },
    onPointerCancel: () => {
      gesture.current = null;
    },
  };
}
