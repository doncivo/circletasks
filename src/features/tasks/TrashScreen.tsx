import { Undo2 } from 'lucide-react';
import { useEffect, type CSSProperties } from 'react';
import { localDateOfInstant } from '../../domain/donePeriod';
import type { Space, Task } from '../../domain/model';
import { t } from '../../i18n';
import { formatDayLabel } from '../../i18n/format';
import { Button, Icon, IconView, ListRow, SpacePills, resolveIconRefColor, useLayout } from '../../ui';
import { useFeatureStore } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { trashStore } from './trashStore';
import './TrashScreen.css';

function trashSubtitle(task: Task, spaces: readonly Space[]) {
  const space = spaces.find((s) => s.id === task.spaceId);
  const deletedOn = task.deletedAt ? t('trash.deletedOn', { date: formatDayLabel(localDateOfInstant(task.deletedAt)) }) : '';
  return (
    <>
      {deletedOn}
      {space && (
        <>
          {' · '}
          <span className="ct-trash__space" style={{ '--ct-space-color': space.color } as CSSProperties}>{space.name}</span>
        </>
      )}
    </>
  );
}

/**
 * Écran Corbeille (T-08), ouvert depuis Réglages › DONNÉES ET SÉCURITÉ › « Corbeille » (Q6) :
 * tâches supprimées depuis moins de 30 jours, de la plus récente à la plus ancienne, avec
 * leur date de suppression et un bouton « Restaurer ». Filtre d'espace global (Pro / Perso / Tout).
 */
export function TrashScreen() {
  const layout = useLayout();
  const spaces = useAppStore((s) => s.spaces);
  const spaceFilter = useAppStore((s) => s.spaceFilter);
  const setSpaceFilter = useAppStore((s) => s.setSpaceFilter);
  const navigate = useNavigationStore((s) => s.navigate);

  const tasks = useFeatureStore(trashStore, (s) => s.tasks);
  const status = useFeatureStore(trashStore, (s) => s.status);
  const errorKey = useFeatureStore(trashStore, (s) => s.errorKey);
  const actionErrorKey = useFeatureStore(trashStore, (s) => s.actionErrorKey);
  const load = useFeatureStore(trashStore, (s) => s.load);
  const restore = useFeatureStore(trashStore, (s) => s.restore);

  // Ouverture et changement du filtre d'espace global : (re)charge la corbeille (`load` ne rejette jamais).
  useEffect(() => {
    void load(spaceFilter);
  }, [spaceFilter, load]);

  return (
    <div className="ct-trash-shell" data-layout={layout}>
      <div className="ct-trash">
        <div className="ct-trash__topRow">
          <button
            type="button"
            className="ct-trash__iconButton"
            aria-label={t('trash.back')}
            onClick={() => navigate({ tab: 'settings', screen: 'home' })}
          >
            <Icon icon={Undo2} size={26} />
          </button>
        </div>
        <h1 className="ct-trash__title">{t('trash.title')}</h1>
        <p className="ct-trash__intro">{t('trash.intro')}</p>

        <SpacePills items={spaces} value={spaceFilter} onChange={setSpaceFilter} />

        {actionErrorKey && <p className="ct-trash__error" role="alert">{t(actionErrorKey)}</p>}
        {status === 'error' && errorKey && <p className="ct-trash__error" role="alert">{t(errorKey)}</p>}

        {status === 'ready' && tasks.length === 0 && <p className="ct-trash__empty">{t('trash.empty')}</p>}
        {status !== 'error' && (
          <ul className="ct-trash__list">
            {tasks.map((task) => (
              <li key={task.id} className="ct-trash__item">
                <ListRow
                  title={task.title}
                  subtitle={trashSubtitle(task, spaces)}
                  icon={task.icon ? <IconView icon={task.icon} color={resolveIconRefColor(task.icon)} size={layout === 'pc' ? 24 : 28} /> : undefined}
                  trailing={
                    <Button
                      variant="secondary"
                      ariaLabel={t('trash.restoreLabel', { title: task.title })}
                      onClick={() => void restore(task.id)}
                      className="ct-trash__restore"
                    >
                      {t('trash.restore')}
                    </Button>
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
