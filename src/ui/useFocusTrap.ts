import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Pièges actifs, du plus ancien au plus récent : seul le dernier (la surcouche du dessus,
 * ex. un menu ouvert dans une fiche détail) réagit à Échap et Tab.
 */
const activeTraps: symbol[] = [];

export interface UseFocusTrapOptions {
  /** Piège actif : pose les écouteurs, déplace le focus, le restaure à la désactivation. */
  readonly active: boolean;
  /** Appelé sur Échap (DetailPanel, Sheet : PRD section 5). */
  readonly onEscape?: () => void;
}

/**
 * Piège de focus pour une surcouche (Sheet, DetailPanel, future Modal) : au montage,
 * déplace le focus dans le conteneur ; Tab / Maj+Tab restent dans le conteneur ;
 * Échap appelle `onEscape` ; à la désactivation, restaure le focus précédent.
 *
 * Le conteneur doit porter `ref` et, s'il peut être vide, `tabIndex={-1}` pour
 * rester une cible de focus de repli.
 *
 * @example
 * const ref = useFocusTrap<HTMLElement>({ active: open, onEscape: onClose });
 * <section ref={ref} tabIndex={-1}>…</section>
 */
export function useFocusTrap<T extends HTMLElement>({ active, onEscape }: UseFocusTrapOptions) {
  const containerRef = useRef<T | null>(null);
  // `onEscape` lu par référence : un parent qui recrée son rappel à chaque rendu ne relance pas l'effet
  // (sinon le focus serait replacé au premier élément à chaque rendu).
  const onEscapeRef = useRef(onEscape);
  useEffect(() => {
    onEscapeRef.current = onEscape;
  });

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    const token = Symbol('focus-trap');
    activeTraps.push(token);
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = (): HTMLElement[] =>
      container ? Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) : [];

    const first = focusables()[0];
    (first ?? container)?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (activeTraps[activeTraps.length - 1] !== token) return;
      if (event.key === 'Escape') {
        event.stopPropagation();
        onEscapeRef.current?.();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      if (!firstEl || !lastEl) {
        event.preventDefault();
        return;
      }
      if (event.shiftKey && document.activeElement === firstEl) {
        event.preventDefault();
        lastEl.focus();
      } else if (!event.shiftKey && document.activeElement === lastEl) {
        event.preventDefault();
        firstEl.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      const index = activeTraps.indexOf(token);
      if (index >= 0) activeTraps.splice(index, 1);
      previouslyFocused?.focus();
    };
  }, [active]);

  return containerRef;
}
