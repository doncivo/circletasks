import { ConflictList } from './ConflictList';

/**
 * Emplacement « journal des conflits » de l'écran de détails de la synchro (Y-04, étape 0 du lot Y3) : sous la ligne « Aucun conflit /
 * N conflits cette semaine » de Y-02, le bloc « JOURNAL DES CONFLITS » (absent sans conflit). Rempli dans ce fichier seulement, sans
 * toucher `SyncDetailsScreen.tsx`.
 */
export function SyncDetailsConflicts() {
  return <ConflictList />;
}
