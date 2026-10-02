import { useCallback } from 'react';
import { defaultSpaceFor, isCreatedOutsideFilter } from '../../domain/spaceRules';
import type { SpaceId } from '../../domain/types';
import { t } from '../../i18n';
import { useAppStore } from '../app/appStore';
import { useNoticeStore } from '../app/notice';

/**
 * Espace proposé à toute création (ES-02) : règle unique `defaultSpaceFor` appliquée au filtre global et aux espaces chargés ;
 * null tant que les espaces ne sont pas chargés. Toutes les fenêtres d'ajout (Aujourd'hui, Semaine, Routines, objectifs…) l'utilisent.
 */
export function useDefaultSpaceId(): SpaceId | null {
  const filter = useAppStore((s) => s.spaceFilter);
  const spaces = useAppStore((s) => s.spaces);
  return defaultSpaceFor(filter, spaces);
}

/**
 * ES-02 critère 4 : renvoie la fonction à appeler après une création réussie ; elle affiche « Ajouté dans <espace> » quand
 * l'élément est dans un espace que le filtre actif masque. Le filtre ne change jamais.
 */
export function useAnnounceCreation(): (spaceId: SpaceId) => void {
  const show = useNoticeStore((s) => s.show);
  return useCallback(
    (spaceId) => {
      const { spaceFilter, spaces } = useAppStore.getState();
      if (!isCreatedOutsideFilter(spaceFilter, spaceId)) return;
      const name = spaces.find((space) => space.id === spaceId)?.name;
      if (name) show(t('spaces.addedIn', { name }));
    },
    [show],
  );
}
