import { ArrowLeft, ArrowRight, Undo2 } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { todayLocal } from '../../domain/clock';
import { DONE_PERIOD_KINDS, groupDoneByDay, localTimeOfInstant } from '../../domain/donePeriod';
import type { Space, Task } from '../../domain/model';
import { t } from '../../i18n';
import { formatDayLabel, formatDonePeriodLabel } from '../../i18n/format';
import { Checkbox, Icon, IconView, ListRow, SpacePills, resolveIconRefColor, useLayout } from '../../ui';
import { useAppContainer, useFeatureStore, useTaskEntities } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { doneTasksStore, resolveDoneTasks } from './doneTasksStore';
import { TaskDetail } from './TaskDetail';
import './DoneTasksScreen.css';

function doneSubtitle(task: Task, spaces: readonly Space[]) {
  const space = spaces.find((s) => s.id === task.spaceId);
  const time = task.doneAt ? t('done.doneAt', { time: localTimeOfInstant(task.doneAt) }) : '';
  return (
    <>
      {time}
      {space && (
        <>
          {' · '}
          <span style={{ color: space.color }}>{space.name}</span>
        </>
      )}
    </>
  );
}

/**
 * Écran « Tâches terminées » (T-07) : liste filtrable par jour, semaine (lundi-dimanche)
 * ou mois, groupée par jour de fin. Ouvert depuis « Rapport mensuel » (Q5) ; période
 * par défaut « Jour » = aujourd'hui. Décocher une case rouvre la tâche (annulable 5 s),
 * toucher une ligne ouvre la fiche détail (A-08).
 */
export function DoneTasksScreen() {
  const container = useAppContainer();
  const layout = useLayout();
  const spaces = useAppStore((s) => s.spaces);
  const spaceFilter = useAppStore((s) => s.spaceFilter);
  const setSpaceFilter = useAppStore((s) => s.setSpaceFilter);
  const appDay = useAppStore((s) => s.day);
  const navigate = useNavigationStore((s) => s.navigate);
  const openDetail = useNavigationStore((s) => s.openDetail);

  const period = useFeatureStore(doneTasksStore, (s) => s.period);
  const viewFilter = useFeatureStore(doneTasksStore, (s) => s.filter);
  const taskIds = useFeatureStore(doneTasksStore, (s) => s.taskIds);
  const status = useFeatureStore(doneTasksStore, (s) => s.status);
  const errorKey = useFeatureStore(doneTasksStore, (s) => s.errorKey);
  const actionErrorKey = useFeatureStore(doneTasksStore, (s) => s.actionErrorKey);
  const open = useFeatureStore(doneTasksStore, (s) => s.open);
  const selectKind = useFeatureStore(doneTasksStore, (s) => s.selectKind);
  const shift = useFeatureStore(doneTasksStore, (s) => s.shift);
  const setFilter = useFeatureStore(doneTasksStore, (s) => s.setFilter);
  const reopen = useFeatureStore(doneTasksStore, (s) => s.reopen);
  const entities = useTaskEntities();

  // Ouverture : période « Jour » = aujourd'hui, filtre d'espace courant (les méthodes du store ne rejettent jamais).
  useEffect(() => {
    void open(appDay ?? todayLocal(container.clock), useAppStore.getState().spaceFilter);
    // Une seule fois à l'ouverture de l'écran.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Le filtre d'espace est global (appStore) : un changement ailleurs recharge la liste.
  useEffect(() => {
    if (period && spaceFilter !== viewFilter) void setFilter(spaceFilter);
  }, [spaceFilter, viewFilter, period, setFilter]);

  const tasks = useMemo(() => resolveDoneTasks(taskIds, entities, { period, filter: viewFilter }), [taskIds, entities, period, viewFilter]);
  const groups = useMemo(() => groupDoneByDay(tasks), [tasks]);

  return (
    <div className="ct-done-shell" data-layout={layout}>
      <div className="ct-done">
        <div className="ct-done__topRow">
          <button
            type="button"
            className="ct-done__iconButton"
            aria-label={t('done.back')}
            onClick={() => navigate({ tab: 'tasks', screen: 'report' })}
          >
            <Icon icon={Undo2} size={26} />
          </button>
        </div>

        <div className="ct-done__headerRow">
          <div className="ct-done__heading">
            <h1 className="ct-done__title">{t('done.title')}</h1>
            <span className="ct-done__period" aria-live="polite">
              {period ? formatDonePeriodLabel(period.kind, period.from, period.to) : ''}
            </span>
          </div>
          <div className="ct-done__nav">
            <button type="button" className="ct-done__iconButton" aria-label={t('done.previous')} onClick={() => void shift(-1)}>
              <Icon icon={ArrowLeft} size={22} />
            </button>
            <button type="button" className="ct-done__iconButton" aria-label={t('done.next')} onClick={() => void shift(1)}>
              <Icon icon={ArrowRight} size={22} />
            </button>
          </div>
        </div>

        <div className="ct-done__kinds" role="group" aria-label={t('done.periodLabel')}>
          {DONE_PERIOD_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              className="ct-done__kind"
              aria-pressed={period?.kind === kind}
              onClick={() => void selectKind(kind)}
            >
              {t(`done.${kind}`)}
            </button>
          ))}
        </div>

        <SpacePills items={spaces} value={spaceFilter} onChange={setSpaceFilter} />

        {actionErrorKey && <p className="ct-done__error" role="alert">{t(actionErrorKey)}</p>}
        {status === 'error' && errorKey && <p className="ct-done__error" role="alert">{t(errorKey)}</p>}

        {status === 'ready' && groups.length === 0 && <p className="ct-done__empty">{t('done.empty')}</p>}
        {status !== 'error' &&
          groups.map((group) => (
            <section key={group.date} className="ct-done__group" aria-label={formatDayLabel(group.date)}>
              <h2 className="ct-done__groupTitle">{formatDayLabel(group.date)}</h2>
              {group.tasks.map((task) => (
                <ListRow
                  key={task.id}
                  title={task.title}
                  subtitle={doneSubtitle(task, spaces)}
                  done
                  leading={
                    <Checkbox checked onChange={() => void reopen(task.id)} label={t('tasks.reopen', { title: task.title })} />
                  }
                  icon={task.icon ? <IconView icon={task.icon} color={resolveIconRefColor(task.icon)} size={layout === 'pc' ? 24 : 28} /> : undefined}
                  onActivate={() => openDetail({ type: 'task', id: task.id })}
                />
              ))}
            </section>
          ))}
      </div>

      <TaskDetail />
    </div>
  );
}
