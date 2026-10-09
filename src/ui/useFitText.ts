import { useLayoutEffect, type RefObject } from 'react';

/** Plus petite taille admise (px) : en dessous, le titre passe à la ligne entre deux mots plutôt que de devenir illisible. */
export const FIT_TEXT_MIN_PX = 20;

/**
 * Posé sur le titre quand il ne tient pas au plancher à côté de ses voisins : la feuille de style de l'écran laisse alors sa
 * rangée passer à la ligne (`:has([data-fit='floor'])`), les voisins se placent sous le titre au lieu de le chevaucher.
 */
export const FIT_FLOOR_ATTRIBUTE = 'data-fit';

/**
 * Titre sur UNE ligne réduit à la place que lui laisse sa rangée (titres datés de Tâches et de la Semaine sur iPhone, à côté de
 * leurs boutons ; IOS-titres) : le CSS fixe la taille de la maquette et `white-space: nowrap` ; si le texte dépasse la largeur que
 * le titre reçoit (élément flexible avec `min-width: 0`), la taille est réduite, jamais coupée au milieu d'un mot ni rognée. Au
 * plancher (texte très agrandi, place minuscule) le titre passe à la ligne ENTRE deux mots (`white-space: normal`) plutôt que de
 * chevaucher ses voisins. Recalculé quand le texte change, quand la LARGEUR de la rangée change (rotation, fenêtre ; pas sa hauteur,
 * que le titre fait lui-même varier) et quand des polices sont chargées (`document.fonts` : `ready` et `loadingdone`). Sans mise en
 * page (jsdom) : rien n'est changé.
 *
 * `title` : l'élément du titre ; `row` : un ancêtre dont la largeur ne dépend PAS de la taille du titre (sinon boucle).
 */
export function useFitText(title: RefObject<HTMLElement | null>, row: RefObject<HTMLElement | null>, text: string): void {
  useLayoutEffect(() => {
    const element = title.current;
    if (!element) return undefined;
    /** Réduit la taille jusqu'à tenir ; rend vrai si le texte tient sur une ligne au-dessus du plancher. */
    const shrink = (): boolean => {
      element.style.removeProperty('font-size');
      if (element.clientWidth <= 0 || element.scrollWidth <= element.clientWidth) return true;
      let size = parseFloat(getComputedStyle(element).fontSize);
      if (!Number.isFinite(size) || size <= 0) return true;
      // Réduction proportionnelle, arrondie vers le bas au dixième de pixel, répétée tant que le texte dépasse : la chasse de Fraunces
      // dépend de la taille (axe de taille optique), la première estimation peut manquer de quelques dixièmes.
      for (let attempt = 0; attempt < 6 && size > FIT_TEXT_MIN_PX; attempt += 1) {
        const width = element.scrollWidth;
        const room = element.clientWidth;
        if (width <= room) return true;
        size = Math.max(FIT_TEXT_MIN_PX, Math.min(size - 0.1, Math.floor(((size * room) / width) * 10) / 10));
        element.style.setProperty('font-size', `${String(size)}px`);
      }
      return element.scrollWidth <= element.clientWidth;
    };
    const fit = (): void => {
      element.style.removeProperty('white-space');
      element.removeAttribute(FIT_FLOOR_ATTRIBUTE);
      if (shrink()) return;
      // Au plancher : la rangée du titre passe à la ligne (badge ou flèches sous le titre, CSS de l'écran), puis
      // nouvel essai avec toute la largeur ; en dernier recours, le titre passe à la ligne entre deux mots.
      element.setAttribute(FIT_FLOOR_ATTRIBUTE, 'floor');
      if (shrink()) return;
      element.style.setProperty('white-space', 'normal');
    };
    fit();
    let cancelled = false;
    const refit = (): void => {
      if (!cancelled) fit();
    };
    const fonts = typeof document !== 'undefined' ? (document.fonts as FontFaceSet | undefined) : undefined;
    void fonts?.ready.then(refit);
    fonts?.addEventListener('loadingdone', refit);
    const observed = row.current;
    let lastWidth: number | null = null;
    const observer =
      typeof ResizeObserver !== 'undefined' && observed
        ? new ResizeObserver((entries) => {
            const width = entries[entries.length - 1]?.contentRect.width ?? null;
            if (width === null || width === lastWidth) return;
            lastWidth = width;
            refit();
          })
        : null;
    if (observer && observed) observer.observe(observed);
    return () => {
      cancelled = true;
      fonts?.removeEventListener('loadingdone', refit);
      observer?.disconnect();
    };
  }, [title, row, text]);
}
