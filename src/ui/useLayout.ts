import { useSyncExternalStore } from 'react';

/** Mise en page : 'pc' à partir de 1024 px de large (fenêtre PC min 1024 x 700), 'mobile' en dessous. */
export type Layout = 'pc' | 'mobile';

export const PC_MIN_WIDTH_PX = 1024;
export const PC_MEDIA_QUERY = `(min-width: ${PC_MIN_WIDTH_PX}px)`;

function subscribe(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => undefined;
  const mql = window.matchMedia(PC_MEDIA_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

function getSnapshot(): Layout {
  if (typeof window.matchMedia !== 'function') {
    return window.innerWidth >= PC_MIN_WIDTH_PX ? 'pc' : 'mobile';
  }
  return window.matchMedia(PC_MEDIA_QUERY).matches ? 'pc' : 'mobile';
}

/** Mise en page courante, recalculée au redimensionnement (rotation iPhone, fenêtre PC). */
export function useLayout(): Layout {
  return useSyncExternalStore(subscribe, getSnapshot, () => 'pc');
}
