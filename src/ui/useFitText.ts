import { useLayoutEffect, type RefObject } from 'react';

/** Plus petite taille admise (px) : en dessous, le titre garde cette taille plutôt que de devenir illisible. */
export const FIT_TEXT_MIN_PX = 20;

/**
 * Titre sur UNE ligne réduit à la place que lui laisse sa rangée (titres datés de Tâches et de la Semaine sur iPhone, à côté de
 * leurs boutons ; IOS-titres) : le CSS fixe la taille de la maquette et `white-space: nowrap` ; si le texte dépasse la largeur que
 * le titre reçoit (élément flexible avec `min-width: 0`), la taille est réduite dans la proportion exacte, jamais coupée au milieu
 * d'un mot ni rognée. Recalculé quand le texte change, quand la rangée change de largeur (rotation, fenêtre) et quand les polices
 * embarquées sont chargées. Sans mise en page (jsdom) : rien n'est changé.
 *
 * `title` : l'élément du titre ; `row` : un ancêtre dont la largeur ne dépend PAS de la taille du titre (sinon boucle).
 */
export function useFitText(title: RefObject<HTMLElement | null>, row: RefObject<HTMLElement | null>, text: string): void {
  useLayoutEffect(() => {
    const element = title.current;
    if (!element) return undefined;
    const fit = (): void => {
      element.style.removeProperty('font-size');
      const available = element.clientWidth;
      const needed = element.scrollWidth;
      if (available <= 0 || needed <= available) return;
      let size = parseFloat(getComputedStyle(element).fontSize);
      if (!Number.isFinite(size) || size <= 0) return;
      // Réduction proportionnelle, arrondie vers le bas au dixième de pixel, répétée tant que le texte dépasse : la chasse de Fraunces
      // dépend de la taille (axe de taille optique), la première estimation peut manquer de quelques dixièmes.
      for (let attempt = 0; attempt < 6 && size > FIT_TEXT_MIN_PX; attempt += 1) {
        const width = element.scrollWidth;
        const room = element.clientWidth;
        if (width <= room) return;
        size = Math.max(FIT_TEXT_MIN_PX, Math.min(size - 0.1, Math.floor(((size * room) / width) * 10) / 10));
        element.style.setProperty('font-size', `${String(size)}px`);
      }
    };
    fit();
    let cancelled = false;
    void document.fonts?.ready.then(() => {
      if (!cancelled) fit();
    });
    const observed = row.current;
    const observer = typeof ResizeObserver !== 'undefined' && observed ? new ResizeObserver(() => fit()) : null;
    if (observer && observed) observer.observe(observed);
    return () => {
      cancelled = true;
      observer?.disconnect();
    };
  }, [title, row, text]);
}
