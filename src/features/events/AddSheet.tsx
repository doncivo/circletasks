import { useState } from 'react';
import { todayLocal } from '../../domain/clock';
import type { LocalDate } from '../../domain/types';
import { t } from '../../i18n';
import { Sheet, type AddSegment } from '../../ui';
import { useAppContainer } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useDefaultReminderOffsets } from '../reminders';
import { RoutineForm } from '../routines/RoutineForm';
import { createRoutineUseCases, type RoutineInput } from '../routines/routineUseCases';
import { useAnnounceCreation, useDefaultSpaceId } from '../spaces';
import { TaskCreateSheet, type TaskCreateSheetProps } from '../tasks/TaskCreateSheet';
import { EventForm } from './EventForm';
import { createEventUseCases, type EventInput } from './eventUseCases';

export interface AddSheetProps {
  /** Segment ouvert : Tâche depuis Aujourd'hui et la Semaine, Événement depuis Événements, Routine depuis Routines (E-01 critère 2). */
  readonly initialSegment: AddSegment;
  /** Jour proposé à un nouvel événement (jour affiché, jour touché dans le calendrier) ; aujourd'hui par défaut. */
  readonly date?: LocalDate;
  /** Propriétés de la feuille « Nouvelle tâche » (jour affiché, projet, création) : la création d'une tâche dépend de l'écran appelant. */
  readonly taskSheet: Omit<TaskCreateSheetProps, 'onClose' | 'initialTitle' | 'onSegmentChange' | 'today' | 'spaces' | 'initialSpaceId'>;
  /** Crée la routine (l'écran Routines relit sa liste) ; absent : cas d'usage direct. Renvoie vrai si c'est fait. */
  readonly createRoutine?: (input: RoutineInput) => Promise<boolean>;
  readonly onClose: () => void;
}

/**
 * Feuille Ajout à trois segments Tâche / Événement / Routine (Ajout.html, AjoutEvenement.html, E-01 critère 2). Le titre saisi est
 * conservé quand on change de segment. Chaque segment est le formulaire de son module : `TaskCreateSheet` (T-01 à T-03),
 * `EventForm` (E-01) et `RoutineForm` (R-01, réutilisé tel quel).
 */
export function AddSheet({ initialSegment, date, taskSheet, createRoutine, onClose }: AddSheetProps) {
  const container = useAppContainer();
  const spaces = useAppStore((s) => s.spaces);
  const appDay = useAppStore((s) => s.day);
  const today = appDay ?? todayLocal(container.clock);
  const defaultSpaceId = useDefaultSpaceId();
  const defaultOffsets = useDefaultReminderOffsets();
  const announceCreation = useAnnounceCreation();
  const [segment, setSegment] = useState<AddSegment>(initialSegment);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);

  const change = (next: AddSegment, typed: string): void => {
    setTitle(typed);
    setError(null);
    setSegment(next);
  };

  async function saveEvent(input: EventInput): Promise<boolean> {
    const result = await createEventUseCases(container).create(input);
    if (!result.ok) {
      setError(t('events.saveError'));
      return false;
    }
    announceCreation(result.value.spaceId);
    onClose();
    return true;
  }

  async function saveRoutine(input: RoutineInput): Promise<boolean> {
    const ok = createRoutine ? await createRoutine(input) : (await createRoutineUseCases(container).create(input)).ok;
    if (!ok) {
      setError(t('routines.saveError'));
      return false;
    }
    announceCreation(input.fields.spaceId);
    onClose();
    return true;
  }

  if (!defaultSpaceId) return null;
  if (segment === 'task') {
    return <TaskCreateSheet {...taskSheet} today={today} spaces={spaces} initialSpaceId={defaultSpaceId} defaultOffsets={taskSheet.defaultOffsets ?? defaultOffsets} initialTitle={title} onSegmentChange={change} onClose={onClose} />;
  }
  if (segment === 'event') {
    return (
      <Sheet open onClose={onClose} label={t('events.sheet.newTitle')} className="ct-sheet--tall">
        <EventForm event={null} spaces={spaces} initialSpaceId={defaultSpaceId} today={today} initialDate={date ?? today} initialTitle={title} onSubmit={saveEvent} onClose={onClose} onSegmentChange={change} errorMessage={error} autoFocus />
      </Sheet>
    );
  }
  return (
    <Sheet open onClose={onClose} label={t('routines.form.newTitle')} className="ct-sheet--tall">
      <RoutineForm routine={null} spaces={spaces} initialSpaceId={defaultSpaceId} today={today} onSubmit={saveRoutine} onClose={onClose} errorMessage={error} autoFocus defaultOffsets={defaultOffsets} initialTitle={title} onSegmentChange={change} />
    </Sheet>
  );
}
