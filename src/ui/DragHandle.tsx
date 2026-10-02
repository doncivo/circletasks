import { GripVertical } from 'lucide-react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Icon } from './Icon';
import './DragHandle.css';

export interface DragHandleProps {
  /** Libellé accessible complet (ex. « Déplacer : Envoyer la facture »), composé par l'appelant via t(). */
  label: string;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  /** Flèches haut / bas sur la poignée focalisée : alternative au glisser pour le clavier et les lecteurs d'écran. */
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  className?: string;
}

/**
 * Poignée de déplacement des maquettes (Main-Edition.html : six points, #8E87A3), saisie par `useSortable`.
 * Bouton focalisable : ↑ / ↓ déplacent la ligne d'une position ; zone tactile ≥ 44 px.
 *
 * @example
 * <DragHandle label={t('today.moveHandle', { title })} {...sortable.dragProps(id, 'handle')} onMoveUp={up} onMoveDown={down} />
 */
export function DragHandle({ label, onPointerDown, onMoveUp, onMoveDown, className }: DragHandleProps) {
  return (
    <button
      type="button"
      aria-label={label}
      className={['ct-drag-handle', 'ct-sortable__handle', className].filter(Boolean).join(' ')}
      onPointerDown={onPointerDown}
      onKeyDown={(event) => {
        if (event.key === 'ArrowUp' && onMoveUp) {
          event.preventDefault();
          onMoveUp();
        } else if (event.key === 'ArrowDown' && onMoveDown) {
          event.preventDefault();
          onMoveDown();
        }
      }}
    >
      <Icon icon={GripVertical} size={22} strokeWidth={2.8} />
    </button>
  );
}
