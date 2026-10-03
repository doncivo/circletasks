import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { t } from '../i18n';
import { Icon } from './Icon';
import { useFocusTrap } from './useFocusTrap';
import './DetailPanel.css';

export interface DetailPanelProps {
  /** Échap, piège de focus (PRD section 5). */
  onClose: () => void;
  /** Nom accessible du panneau (ex. « Détail de la tâche »). */
  label: string;
  /** Légende de l'en-tête, déjà résolue par l'appelant ; « DÉTAIL » par défaut. */
  caption?: string;
  /** Largeur en pixels ; 588 px dans PC-Aujourdhui.html. */
  width?: number;
  children: ReactNode;
  className?: string;
}

/**
 * Panneau de détail PC (PC-Aujourdhui.html, A-08), ancré à droite de la zone
 * centrale. Piège de focus et Échap pour fermer, comme la feuille mobile.
 *
 * @example
 * <DetailPanel label={t('tasks.detail', { title })} onClose={closeDetail}>
 *   <TaskDetailForm task={task} />
 * </DetailPanel>
 */
export function DetailPanel({ onClose, label, caption, width = 420, children, className }: DetailPanelProps) {
  const containerRef = useFocusTrap<HTMLElement>({ active: true, onEscape: onClose });
  return (
    <aside
      ref={containerRef}
      tabIndex={-1}
      aria-label={label}
      className={['ct-detail-panel', className].filter(Boolean).join(' ')}
      style={{ width }}
    >
      <div className="ct-detail-panel__header">
        <span className="ct-detail-panel__caption">{caption ?? t('detail.caption')}</span>
        <button type="button" aria-label={t('detail.closeLabel')} onClick={onClose} className="ct-detail-panel__close">
          <Icon icon={X} />
        </button>
      </div>
      {children}
    </aside>
  );
}
