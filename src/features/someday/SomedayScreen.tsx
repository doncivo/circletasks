import { Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { todayLocal } from '../../domain/clock';
import { t } from '../../i18n';
import { CompactToggle, EditModeSwitch, Fab, Icon, SomedayIcon, useDelayedFlag, useLayout } from '../../ui';
import { useAppContainer } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { SpaceFilterBar } from '../spaces';
import { TaskDetail } from '../tasks';
import { TodayCreateSheet } from '../today/TodayCreate';
import { useDefaultReminderOffsets } from '../reminders';
import { SomedayAddField } from './SomedayAddField';
import { SomedayList } from './SomedayList';
import { SomedayPanel } from './SomedayPanel';
import { SomedaySelectionBar, SomedaySelectionDialogs } from './SomedaySelectionBar';
import { useSomedayListState } from './useSomedayListState';
import { useSomedayView } from './useSomedayView';
import './SomedayScreen.css';

/**
 * Écran « Un jour » (M18, UnJour.html) : écran plein sur iPhone avec « Retour », panneau à droite d'Aujourd'hui sur PC
 * (PC-Semaine-UnJour.html). Le filtre Pro / Perso / Tout et le menu de projet sont ceux, globaux, des autres écrans.
 */
export function SomedayScreen() {
  const layout = useLayout();
  const navigate = useNavigationStore((s) => s.navigate);
  const detailOpen = useNavigationStore((s) => s.detail !== null);
  const closeToToday = (): void => navigate({ tab: 'tasks', screen: 'today' });
  // PC : la fiche d'une tâche prend la place du panneau tant qu'elle est ouverte (SD-01 critère 2 : « à la place du détail »).
  if (layout === 'pc') return detailOpen ? null : <SomedayPanel onClose={closeToToday} slot />;
  return <SomedayMobile onBack={closeToToday} />;
}

function SomedayMobile({ onBack }: { onBack: () => void }) {
  const container = useAppContainer();
  const view = useSomedayView();
  const state = useSomedayListState(view);
  const appDay = useAppStore((s) => s.day);
  const today = appDay ?? todayLocal(container.clock);
  const defaultOffsets = useDefaultReminderOffsets();
  const [sheetOpen, setSheetOpen] = useState(false);
  const showSkeleton = useDelayedFlag(view.status === 'loading', 150);

  // Ctrl+N : même feuille « Nouvelle tâche » que le bouton « + » (présélectionnée sur « Un jour »).
  useEffect(() => container.shortcuts.register('app.newTask', () => setSheetOpen(true)), [container]);

  return (
    <div className="ct-someday" data-layout="mobile">
      <div className="ct-someday__topRow">
        <button type="button" className="ct-someday__iconButton" aria-label={t('someday.back')} onClick={onBack}>
          <Icon icon={Undo2} size={26} />
        </button>
      </div>
      <div className="ct-someday__header">
        <div className="ct-someday__heading">
          <div className="ct-someday__titleRow">
            <span className="ct-someday__titleIcon">
              <SomedayIcon size={38} color="var(--ct-color-someday)" />
            </span>
            <h1 className="ct-someday__title">{t('someday.title')}</h1>
          </div>
          <span className="ct-someday__subtitle">{view.subtitle}</span>
        </div>
        <CompactToggle active={state.compact} onChange={state.setCompact} label={t('today.compactView')} />
      </div>
      <div className="ct-someday__rule" aria-hidden="true">
        <div className="ct-someday__ruleAccent" />
        <div className="ct-someday__ruleLine" />
      </div>
      <SpaceFilterBar />
      {view.errorKey && view.status === 'error' && <p className="ct-someday__error" role="alert">{t(view.errorKey)}</p>}
      {view.actionErrorKey && <p className="ct-someday__error" role="alert">{t(view.actionErrorKey)}</p>}
      <SomedayAddField onAdd={view.addInline} />
      <SomedayList view={view} state={state} openedTaskId={null} showSkeleton={showSkeleton} />
      <SomedaySelectionBar edit={state.edit} view={view} />
      <div className="ct-someday__bottomRow">
        <EditModeSwitch active={state.edit.editMode} onChange={state.edit.setEditMode} label={t('today.editMode')} />
        <Fab onClick={() => setSheetOpen(true)} label={t('common.add')} />
      </div>
      {sheetOpen && (
        <TodayCreateSheet
          viewedDate={today}
          today={today}
          spaces={view.spaces}
          initialSpaceId={view.defaultSpaceId}
          initialProjectId={view.projectFilter}
          initialSomeday
          defaultOffsets={defaultOffsets}
          onClose={() => setSheetOpen(false)}
          onCreate={async (input) => {
            const result = await view.create({
              title: input.title,
              spaceId: input.spaceId,
              projectId: input.projectId,
              date: input.choice.date,
              ...(input.choice.time !== null ? { time: input.choice.time } : {}),
              ...(input.recurrence ? { recurrence: input.recurrence } : {}),
              icon: input.icon,
              reminderOffsets: input.reminderOffsets,
              goalId: input.goalId,
            });
            if (result.ok) view.announceCreation(input.spaceId);
            return result.ok;
          }}
        />
      )}
      <SomedaySelectionDialogs edit={state.edit} view={view} spaces={view.spaces} />
      <TaskDetail />
    </div>
  );
}
