import { t } from '../i18n';
import './Skeleton.css';

export interface SkeletonProps {
  /** Largeur CSS, ex. '100%', '180px'. */
  width?: string;
  /** Hauteur CSS, ex. '16px'. */
  height?: string;
  /** Rayon des coins ; pill pour une barre, round pour un cercle (avatar/icône). */
  radius?: 'sm' | 'md' | 'lg' | 'pill' | 'round';
  /** Nombre de lignes répétées (ex. un squelette de liste). */
  count?: number;
  className?: string;
}

const RADIUS_VAR: Record<NonNullable<SkeletonProps['radius']>, string> = {
  sm: 'var(--ct-radius-sm)',
  md: 'var(--ct-radius-md)',
  lg: 'var(--ct-radius-lg)',
  pill: 'var(--ct-radius-pill)',
  round: 'var(--ct-radius-round)',
};

/**
 * Squelette de chargement (CLAUDE.md « États »). Pulsation discrète, désactivée
 * sous `prefers-reduced-motion` (règle globale de tokens.css).
 *
 * @example
 * <Skeleton width="60%" height="18px" count={3} />
 */
export function Skeleton({ width = '100%', height = '16px', radius = 'sm', count = 1, className }: SkeletonProps) {
  return (
    <div role="status" aria-busy="true" aria-label={t('app.loading')} className={['ct-skeleton-group', className].filter(Boolean).join(' ')}>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="ct-skeleton" style={{ width, height, borderRadius: RADIUS_VAR[radius] }} />
      ))}
    </div>
  );
}
