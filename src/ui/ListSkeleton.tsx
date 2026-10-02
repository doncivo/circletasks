import './Skeleton.css';
import './ListSkeleton.css';

export interface ListSkeletonProps {
  /** Nombre de lignes grises (4 par défaut). */
  rows?: number;
}

/**
 * Squelette d'une liste de tâches (A-09) : lignes grises de la forme des lignes réelles (case, titre, sous-ligne). Masqué
 * aux lecteurs d'écran : c'est la liste (`aria-busy`) et une annonce « Chargement » unique qui les informent. La pulsation
 * respecte « Réduire les animations » (voir Skeleton.css).
 *
 * @example
 * <div aria-busy="true">{showSkeleton ? <ListSkeleton /> : rows}</div>
 */
export function ListSkeleton({ rows = 4 }: ListSkeletonProps) {
  return (
    <div className="ct-list-skeleton" aria-hidden="true" data-testid="list-skeleton">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="ct-list-skeleton__row">
          <span className="ct-skeleton ct-list-skeleton__box" />
          <span className="ct-list-skeleton__lines">
            <span className="ct-skeleton ct-list-skeleton__title" style={{ width: `${String(55 + ((index * 17) % 35))}%` }} />
            <span className="ct-skeleton ct-list-skeleton__sub" />
          </span>
        </div>
      ))}
    </div>
  );
}
