import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { todayLocal } from '../../domain/clock';
import type { ReminderOffsetMin, Routine } from '../../domain/model';
import { resolveDefaultSpaceId } from '../../domain/taskRules';
import type { LocalDate, RoutineId, SpaceId } from '../../domain/types';
import { t } from '../../i18n';
import { CompactToggle, Fab, Kbd, Sheet, SpacePills, useDetailSlot, useFocusTrap, useLayout } from '../../ui';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { RoutineCard } from './RoutineCard';
import { RoutineForm } from './RoutineForm';
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
    <aside ref={ref} tabIndex={-1} aria-label={label} className="ct-detail-panel ct-routines__panel" style={{ width: 588 }}>
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
  const layout = useLayout();
  const slot = useDetailSlot();
  const spaceFilter = useAppStore((s) => s.spaceFilter);
  const setSpaceFilter = useAppStore((s) => s.setSpaceFilter);
  const spaces = useAppStore((s) => s.spaces);
  const appDay = useAppStore((s) => s.day);
  const today = appDay ?? todayLocal(container.clock);

  const routines = useFeatureStore(routinesStore, (s) => s.routines);
  const doneByRoutine = useFeatureStore(routinesStore, (s) => s.doneByRoutine);
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
  const defaultOffsets = useFeatureStore(routinesStore, (s) => s.defaultOffsets);

  const [editor, setEditor] = useState<Editor | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const fallbackSpaceId: SpaceId | null = spaces[0]?.id ?? null;

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

  const editedRoutine: Routine | null = editor?.mode === 'edit' ? (routines.find((routine) => routine.id === editor.id) ?? null) : null;

  async function openEdit(id: RoutineId): Promise<void> {
    setFormError(null);
    setEditor({ mode: 'edit', id, offsets: await reminderOffsets(id) });
  }

  async function save(input: RoutineInput): Promise<boolean> {
    const result = editor?.mode === 'edit' ? await update(editor.id, input) : await create(input);
    if (!result.ok) {
      setFormError(t('routines.saveError'));
      return false;
    }
    closeEditor();
    return true;
  }

  const pills = <SpacePills items={spaces} value={spaceFilter} onChange={setSpaceFilter} />;
  const form =
    editor && fallbackSpaceId && (editor.mode === 'create' || editedRoutine) ? (
      <RoutineForm
        key={editor.mode === 'edit' ? editor.id : 'new'}
        routine={editedRoutine}
        spaces={spaces}
        initialSpaceId={resolveDefaultSpaceId(spaceFilter, fallbackSpaceId)}
        today={today}
        onSubmit={save}
        onClose={closeEditor}
        errorMessage={formError}
        autoFocus={editor.mode === 'create'}
        initialOffsets={editor.mode === 'edit' ? editor.offsets : []}
        defaultOffsets={defaultOffsets}
      />
    ) : null;
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

      {status === 'ready' && routines.length === 0 && <p className="ct-routines__empty">{t('routines.empty')}</p>}
      {routines.length > 0 && (
        <div className="ct-routines__list" role="list" aria-label={t('routines.listLabel')}>
          {routines.map((routine) => (
            <div key={routine.id} role="listitem" className="ct-routines__item">
              <RoutineCard
                routine={routine}
                spaces={spaces}
                done={doneByRoutine.get(routine.id as RoutineId) ?? EMPTY_DONE}
                today={today}
                layout={layout}
                compact={compact}
                onEdit={() => void openEdit(routine.id as RoutineId)}
                onToggleDay={(date) => void toggleDay(routine.id as RoutineId, date)}
              />
            </div>
          ))}
        </div>
      )}

      {layout === 'mobile' && <p className="ct-routines__helper">{t('routines.helper')}</p>}

      <div className="ct-routines__bottomRow">
        {layout === 'pc' ? (
          <span className="ct-routines__hint">
            {t('routines.hintCheck')} <Kbd keys="Ctrl+N" separator=" " /> {t('routines.hintNew')}
          </span>
        ) : (
          <span />
        )}
        <Fab onClick={openCreate} label={layout === 'pc' ? t('common.add') : t('routines.add')} />
      </div>

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
