import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { todayLocal } from '../../domain/clock';
import type { ReminderOffsetMin, Routine } from '../../domain/model';
import { computeStreaks } from '../../domain/routineStreaks';
import type { LocalDate, RoutineId } from '../../domain/types';
import { t } from '../../i18n';
import { CompactToggle, ConfirmDialog, Fab, Kbd, Sheet, SpacePills, useDetailSlot, useFocusTrap, useLayout } from '../../ui';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { AddSheet, useStandaloneTaskSheet } from '../events';
import { useDefaultSpaceId } from '../spaces';
import { RoutineCard } from './RoutineCard';
import { RoutineForm } from './RoutineForm';
import { RoutineReport } from './RoutineReport';
import { RoutineStreakBox } from './RoutineStreakBox';
import { RoutinesArchived } from './RoutinesArchived';
import { onRoutinesChanged } from './routineEvents';
import { routinesStore } from './routineStore';
import type { RoutineInput } from './routineUseCases';
import './RoutinesScreen.css';

/** Formulaire ouvert : création, ou modification d'une routine. */
type Editor =
  | { readonly mode: 'create' }
  /** `offsets` : avances des rappels actuels, lues avant d'ouvrir le formulaire (cases « À l'heure », « 30 min »). */
  | { readonly mode: 'edit'; readonly id: RoutineId; readonly offsets: readonly ReminderOffsetMin[] };

/** Panneau de droite du PC (PC-Routines.html) : même emplacement que la fiche détail des tâches, sans l'en-tête « DÉTAIL ». */
function RoutinePanel({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const ref = useFocusTrap<HTMLElement>({ active: true, onEscape: onClose });
  return (
    <aside ref={ref} tabIndex={-1} aria-label={label} className="ct-detail-panel ct-routines__panel" style={{ width: 548 }}>
      {children}
    </aside>
  );
}

/**
 * Onglet Routines (M4, Routines.html, PC-Routines.html) : cartes des routines du filtre d'espace, création et modification dans
 * une feuille (iPhone) ou le panneau de droite (PC). Rien n'est stocké d'avance : jours prévus, compteurs et séries sont calculés
 * par src/domain.
 */
export function RoutinesScreen() {
  const container = useAppContainer();
  const navigate = useNavigationStore((s) => s.navigate);
  const layout = useLayout();
  const slot = useDetailSlot();
  const spaceFilter = useAppStore((s) => s.spaceFilter);
  const setSpaceFilter = useAppStore((s) => s.setSpaceFilter);
  const spaces = useAppStore((s) => s.spaces);
  const appDay = useAppStore((s) => s.day);
  const today = appDay ?? todayLocal(container.clock);

  const routines = useFeatureStore(routinesStore, (s) => s.routines);
  const archived = useFeatureStore(routinesStore, (s) => s.archived);
  const doneByRoutine = useFeatureStore(routinesStore, (s) => s.doneByRoutine);
  const pausesOf = useFeatureStore(routinesStore, (s) => s.pausesOf);
  const compact = useFeatureStore(routinesStore, (s) => s.compact);
  const status = useFeatureStore(routinesStore, (s) => s.status);
  const errorKey = useFeatureStore(routinesStore, (s) => s.errorKey);
  const actionErrorKey = useFeatureStore(routinesStore, (s) => s.actionErrorKey);
  const load = useFeatureStore(routinesStore, (s) => s.load);
  const setCompact = useFeatureStore(routinesStore, (s) => s.setCompact);
  const create = useFeatureStore(routinesStore, (s) => s.create);
  const update = useFeatureStore(routinesStore, (s) => s.update);
  const reminderOffsets = useFeatureStore(routinesStore, (s) => s.reminderOffsets);
  const toggleDay = useFeatureStore(routinesStore, (s) => s.toggleDay);
  const refresh = useFeatureStore(routinesStore, (s) => s.refresh);
  const setArchived = useFeatureStore(routinesStore, (s) => s.setArchived);
  const setPaused = useFeatureStore(routinesStore, (s) => s.setPaused);
  const defaultOffsets = useFeatureStore(routinesStore, (s) => s.defaultOffsets);

  const [editor, setEditor] = useState<Editor | null>(null);
  /** Routine dont le rapport est ouvert : sélection de la carte (PC, panneau de droite) ou feuille « Rapport de la routine » (iPhone). */
  const [reportId, setReportId] = useState<RoutineId | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  /** Routine dont l'archivage attend la confirmation. */
  const [archiveTarget, setArchiveTarget] = useState<Routine | null>(null);
  // ES-02 : espace proposé à la modification (celui de la routine) ; la création passe par la feuille Ajout (E-01 : segment Routine).
  const defaultSpaceId = useDefaultSpaceId();
  const taskSheet = useStandaloneTaskSheet(today);

  useEffect(() => {
    void load(spaceFilter);
    // `load` ne rejette jamais ; recharge au changement de filtre d'espace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceFilter]);

  // Validation annulée ailleurs (message « Annuler », Ctrl+Z) : les ronds et compteurs se relisent.
  useEffect(() => onRoutinesChanged(container.data, () => void refresh()), [container, refresh]);

  const openCreate = useCallback((): void => {
    setFormError(null);
    setEditor({ mode: 'create' });
  }, []);
  // Ctrl+N : nouvelle routine (PC-Routines.html, « Ctrl N nouvelle routine »).
  useEffect(() => container.shortcuts.register('app.newTask', openCreate), [container, openCreate]);

  const closeEditor = (): void => {
    setEditor(null);
    setFormError(null);
  };

  const reportRoutine: Routine | null = routines.find((routine) => routine.id === reportId) ?? null;

  const editedRoutine: Routine | null = editor?.mode === 'edit' ? (routines.find((routine) => routine.id === editor.id) ?? null) : null;

  async function openEdit(id: RoutineId): Promise<void> {
    setFormError(null);
    setEditor({ mode: 'edit', id, offsets: await reminderOffsets(id) });
  }

  async function save(input: RoutineInput): Promise<boolean> {
    if (editor?.mode !== 'edit') return false;
    const result = await update(editor.id, input);
    if (!result.ok) {
      setFormError(t('routines.saveError'));
      return false;
    }
    closeEditor();
    return true;
  }

  const filteredSpace = spaceFilter === 'all' ? null : spaces.find((space) => space.id === spaceFilter);
  const emptyMessage = filteredSpace ? t('spaces.emptyRoutines', { space: filteredSpace.name }) : t('routines.empty');
  const pills = <SpacePills items={spaces} value={spaceFilter} onChange={setSpaceFilter} />;
  const form =
    editor?.mode === 'edit' && defaultSpaceId && editedRoutine ? (
      <RoutineForm
        key={editor.id}
        routine={editedRoutine}
        spaces={spaces}
        initialSpaceId={defaultSpaceId}
        today={today}
        onSubmit={save}
        onClose={closeEditor}
        errorMessage={formError}
        archiveAction={
          editedRoutine ? (
            <button type="button" className="ct-routine-form__archive" onClick={() => setArchiveTarget(editedRoutine)}>
              {t('routines.form.archive')}
            </button>
          ) : undefined
        }
        initialOffsets={editor.offsets}
        editExtras={editedRoutine ? <RoutineStreakBox streaks={computeStreaks(editedRoutine, doneByRoutine.get(editedRoutine.id as RoutineId) ?? EMPTY_DONE, today, pausesOf.get(editedRoutine.id as RoutineId) ?? [])} /> : undefined}
        defaultOffsets={defaultOffsets}
      />
    ) : null;
  const report = reportRoutine ? (
    <RoutineReport
      key={reportRoutine.id}
      routine={reportRoutine}
      spaces={spaces}
      done={doneByRoutine.get(reportRoutine.id as RoutineId) ?? EMPTY_DONE}
      pauses={pausesOf.get(reportRoutine.id as RoutineId) ?? []}
      today={today}
      onClose={() => setReportId(null)}
      onTogglePause={() => void setPaused(reportRoutine.id as RoutineId, !reportRoutine.paused)}
      onArchive={() => setArchiveTarget(reportRoutine)}
      {...(layout === 'pc' ? { onModify: () => void openEdit(reportRoutine.id as RoutineId) } : {})}
    />
  ) : null;
  const reportLabel = t('routines.report.panelLabel');
  const formLabel = editor?.mode === 'edit' ? t('routines.form.editTitle') : t('routines.form.newTitle');

  return (
    <div className="ct-routines" data-layout={layout}>
      <div className="ct-routines__headerRow">
        <h1 className="ct-routines__title">{t('routines.title')}</h1>
        <div className="ct-routines__headerActions">
          {layout === 'pc' && pills}
          <CompactToggle active={compact} onChange={(value) => void setCompact(value)} label={t('routines.compactView')} />
        </div>
      </div>
      <div className="ct-routines__rule" aria-hidden="true">
        <div className="ct-routines__ruleAccent" />
        <div className="ct-routines__ruleLine" />
      </div>
      {layout === 'mobile' && pills}

      {actionErrorKey && (
        <p className="ct-routines__error" role="alert">
          {t(actionErrorKey)}
        </p>
      )}
      {status === 'error' && errorKey && (
        <p className="ct-routines__error" role="alert">
          {t(errorKey)}
        </p>
      )}

      {status === 'ready' && routines.length === 0 && <p className="ct-routines__empty">{emptyMessage}</p>}
      {routines.length > 0 && (
        <div className="ct-routines__list" role="list" aria-label={t('routines.listLabel')}>
          {routines.map((routine) => (
            <div key={routine.id} role="listitem" className="ct-routines__item">
              <RoutineCard
                routine={routine}
                spaces={spaces}
                done={doneByRoutine.get(routine.id as RoutineId) ?? EMPTY_DONE}
                pauses={pausesOf.get(routine.id as RoutineId) ?? []}
                today={today}
                layout={layout}
                compact={compact}
                selected={reportId === routine.id}
                onEdit={() => void openEdit(routine.id as RoutineId)}
                onOpen={() => setReportId(routine.id as RoutineId)}
                onToggleDay={(date) => void toggleDay(routine.id as RoutineId, date)}
              />
            </div>
          ))}
        </div>
      )}

      <RoutinesArchived routines={archived} spaces={spaces} onRestore={(routine) => void setArchived(routine.id as RoutineId, false)} />

      {layout === 'mobile' && <p className="ct-routines__helper">{t('routines.helper')}</p>}

      <div className="ct-routines__bottomRow">
        {layout === 'pc' ? (
          <span className="ct-routines__hint">
            {t('routines.hintCheck')} <Kbd keys="Ctrl+N" separator=" " /> {t('routines.hintNew')}
          </span>
        ) : (
          <button type="button" className="ct-routines__monthReport" onClick={() => navigate({ tab: 'routines', screen: 'report' })}>
            {t('routines.monthReport.open')}
          </button>
        )}
        <Fab onClick={openCreate} label={layout === 'pc' ? t('common.add') : t('routines.add')} />
      </div>

      {archiveTarget && (
        <ConfirmDialog
          title={t('routines.form.archiveConfirmTitle', { title: archiveTarget.title })}
          description={t('routines.form.archiveConfirmBody')}
          confirmLabel={t('routines.form.archive')}
          onCancel={() => setArchiveTarget(null)}
          onConfirm={() => {
            const id = archiveTarget.id as RoutineId;
            setArchiveTarget(null);
            void setArchived(id, true).then((done) => {
              if (done) {
                closeEditor();
                setReportId((current) => (current === id ? null : current));
              }
            });
          }}
        />
      )}

      {report && !form && layout === 'mobile' && (
        <Sheet open onClose={() => setReportId(null)} label={reportLabel} className="ct-sheet--tall">
          {report}
        </Sheet>
      )}
      {report && !form && layout === 'pc' && (
        <PanelPortal slot={slot} label={reportLabel} onClose={() => setReportId(null)}>
          {report}
        </PanelPortal>
      )}
      {editor?.mode === 'create' && (
        <AddSheet
          initialSegment="routine"
          date={today}
          taskSheet={taskSheet}
          createRoutine={async (input) => (await create(input)).ok}
          onClose={closeEditor}
        />
      )}
      {form && layout === 'mobile' && (
        <Sheet open onClose={closeEditor} label={formLabel} className="ct-sheet--tall">
          {form}
        </Sheet>
      )}
      {form && layout === 'pc' && (
        <PanelPortal slot={slot} label={formLabel} onClose={closeEditor}>
          {form}
        </PanelPortal>
      )}
    </div>
  );
}

const EMPTY_DONE: ReadonlySet<LocalDate> = new Set();

/** Panneau PC rendu dans l'emplacement de la coquille (pleine hauteur, bord droit) ; sur place hors coquille (tests). */
function PanelPortal({ slot, label, onClose, children }: { slot: HTMLElement | null; label: string; onClose: () => void; children: ReactNode }) {
  const panel = (
    <RoutinePanel label={label} onClose={onClose}>
      {children}
    </RoutinePanel>
  );
  return slot ? createPortal(panel, slot) : panel;
}
