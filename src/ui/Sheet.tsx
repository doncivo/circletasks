import type { CSSProperties, ReactNode, RefObject } from 'react';
import { useFocusTrap } from './useFocusTrap';
import './Sheet.css';

export interface SheetProps {
  open: boolean;
  /** Échap, piège de focus (PRD section 5). */
  onClose: () => void;
  /** Titre accessible de la feuille (ex. « Nouvelle tâche », « Détail de la tâche »). */
  label: string;
  children: ReactNode;
  className?: string;
  /** Élément focalisé à l'ouverture, dans le geste d'ouverture (Q-05) ; absent : premier élément focusable. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Cadre visible fourni par une feuille sensible au clavier, sans changer les autres feuilles. */
  backdropStyle?: CSSProperties;
}

/**
 * Feuille plein écran iPhone (Ajout.html, Detail.html) : coins arrondis en haut,
 * poignée de balayage, fond assombri. Piège de focus, Échap pour fermer.
 *
 * @example
 * <Sheet open={overlay !== null} onClose={closeOverlay} label={t('tasks.newTask')}>
 *   <TaskForm />
 * </Sheet>
 */
export function Sheet({ open, onClose, label, children, className, initialFocusRef, backdropStyle }: SheetProps) {
  const containerRef = useFocusTrap<HTMLElement>({ active: open, onEscape: onClose, ...(initialFocusRef ? { initialFocus: initialFocusRef } : {}) });
  if (!open) return null;
  return (
    <div className="ct-sheet__backdrop" style={backdropStyle}>
      <section
        ref={containerRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={['ct-sheet', className].filter(Boolean).join(' ')}
      >
        <div className="ct-sheet__handle" aria-hidden="true" />
        {children}
      </section>
    </div>
  );
}
