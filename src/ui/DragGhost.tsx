import { GripVertical } from 'lucide-react';
import type { ReactNode, RefCallback } from 'react';
import { Icon } from './Icon';
import './DragGhost.css';

export interface DragGhostProps {
  /** Référence fournie par `useZoneDrag` : le hook positionne la carte à chaque image. */
  readonly ghostRef: RefCallback<HTMLElement>;
  readonly title: string;
  /** Sous-ligne (« Pro · Mission client »). */
  readonly subtitle?: ReactNode;
}

/**
 * Carte volante pendant un glisser entre zones (PC-Semaine-UnJour.html : bordure de 2 px violette, ombre, rotation de −3°).
 * Décorative (`aria-hidden`) et insensible au pointeur : le survol voit à travers elle. Le déplacement est annoncé à part.
 */
export function DragGhost({ ghostRef, title, subtitle }: DragGhostProps) {
  return (
    <div ref={ghostRef} className="ct-drag-ghost" data-drag-ghost aria-hidden="true">
      <span className="ct-drag-ghost__grip">
        <Icon icon={GripVertical} size={18} strokeWidth={2.8} />
      </span>
      <span className="ct-drag-ghost__text">
        <span className="ct-drag-ghost__title">{title}</span>
        {subtitle !== undefined && <span className="ct-drag-ghost__sub">{subtitle}</span>}
      </span>
    </div>
  );
}
