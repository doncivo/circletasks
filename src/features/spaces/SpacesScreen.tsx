import { Undo2 } from 'lucide-react';
import { useEffect } from 'react';
import { t } from '../../i18n';
import { Icon, useLayout } from '../../ui';
import { useFeatureStore } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { SpaceEditor } from './SpaceEditor';
import { spacesStore } from './spacesStore';
import './SpacesScreen.css';

/**
 * Écran « Espaces et projets » (ES-01, ES-04), ouvert depuis Réglages › ESPACES ET CALENDRIERS. Non dessiné dans les maquettes : il
 * reprend la carte d'espace de Bienvenue.html (nom + palette de couleurs). Aucune action pour créer ou supprimer un espace.
 */
export function SpacesScreen() {
  const layout = useLayout();
  const navigate = useNavigationStore((s) => s.navigate);
  const spaces = useAppStore((s) => s.spaces);
  const load = useFeatureStore(spacesStore, (s) => s.load);
  const errorKey = useFeatureStore(spacesStore, (s) => s.errorKey);
  const renameSpace = useFeatureStore(spacesStore, (s) => s.renameSpace);
  const setSpaceColor = useFeatureStore(spacesStore, (s) => s.setSpaceColor);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="ct-spaces-shell" data-layout={layout}>
      <div className="ct-spaces">
        <div className="ct-spaces__topRow">
          <button type="button" className="ct-spaces__back" aria-label={t('spaces.back')} onClick={() => navigate({ tab: 'settings', screen: 'home' })}>
            <Icon icon={Undo2} size={26} />
          </button>
        </div>
        <h1 className="ct-spaces__title">{t('spaces.title')}</h1>
        {errorKey && (
          <p className="ct-spaces__error" role="alert">
            {t(errorKey)}
          </p>
        )}
        {spaces.map((space) => (
          <SpaceEditor
            key={space.id}
            space={space}
            spaces={spaces}
            onRename={(raw) => renameSpace(space.id, raw)}
            onColor={(color) => setSpaceColor(space.id, color)}
          />
        ))}
      </div>
    </div>
  );
}
