import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

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

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = (): HTMLElement[] =>
      container ? Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) : [];

    const first = focusables()[0];
    (first ?? container)?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onEscape?.();
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
      previouslyFocused?.focus();
    };
  }, [active, onEscape]);

  return containerRef;
}
