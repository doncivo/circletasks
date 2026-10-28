import { ChevronDown } from 'lucide-react';
import { useId, useState, type CSSProperties } from 'react';
import type { DateChoice } from '../../domain/dateInput';
import type { IconRef, RecurrenceFields, ReminderOffsetMin, Space } from '../../domain/model';
import type { GoalId, LocalDate, ProjectId, SpaceId } from '../../domain/types';
import { t } from '../../i18n';
import { tTaskRefonte } from '../../i18n/taskRefonteText';
import { Icon, IconChooser, RecurrencePicker, SpaceSegmented } from '../../ui';
import { GoalAttachSwitch } from '../goals/GoalAttachSwitch';
import { ReminderBlock } from '../reminders';
import { ProjectSelect } from '../spaces';
import { TaskSchedulePicker } from './TaskSchedulePicker';
import './TaskCreateSheet.css';
import { contrastRatio } from '../../domain/spaceRules';

/** Texte AA sur la couleur réelle de l'espace, y compris si une ancienne donnée contient une teinte hors palette. */
export function selectedSpaceStyle(color: string): CSSProperties {
  return { backgroundColor: color, color: contrastRatio(color, '#ffffff') >= 4.5 ? '#ffffff' : '#000000' };
}

export interface TaskCreateOptionsProps {
  choice: DateChoice; today: LocalDate; viewedDate: LocalDate; changeChoice: (value: DateChoice) => void;
  spaces: readonly Space[]; spaceId: SpaceId | null; onSpace: (value: SpaceId) => void;
  projectId: ProjectId | null; setProjectId: (value: ProjectId | null) => void;
  icon: IconRef | null; setIcon: (value: IconRef | null) => void;
  recurrence: RecurrenceFields | null; setRecurrence: (value: RecurrenceFields | null) => void;
  offsets: readonly ReminderOffsetMin[]; onOffset: (value: ReminderOffsetMin) => void;
  goalId: GoalId | null; setGoalId: (value: GoalId | null) => void;
}

/** Le titre reste dans l'hôte synchrone ; sélecteurs, styles et nouveaux textes arrivent à l'ouverture seulement. */
export function TaskCreateOptions(p: TaskCreateOptionsProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const moreId = useId();
  const selectedSpace = p.spaces.find((space) => space.id === p.spaceId);
  return <>
    <TaskSchedulePicker value={p.choice} today={p.today} onChange={p.changeChoice} />
    <div className="ct-task-sheet__spaceRow"><SpaceSegmented layout="compact" items={p.spaces} value={p.spaceId} onChange={p.onSpace} label={t('detail.spaceChoiceLabel')} {...(selectedSpace ? { selectedStyle: selectedSpaceStyle(selectedSpace.color) } : {})} /></div>
    <button type="button" className="ct-task-create__more" aria-expanded={moreOpen} aria-controls={moreId} onClick={() => setMoreOpen(!moreOpen)}><span>{tTaskRefonte('more')}<span className="ct-task-create__moreHint"> — {tTaskRefonte('moreHint')}</span></span><Icon icon={ChevronDown} size={20} /></button>
    <div id={moreId} className="ct-task-create__options" hidden={!moreOpen}>
      <RecurrencePicker value={p.recurrence} onChange={p.setRecurrence} startDate={p.choice.date ?? p.viewedDate} />
      <ReminderBlock time={p.choice.date === null ? null : p.choice.time} offsets={p.offsets} warnFor={{ spaceId: p.spaceId, date: p.choice.date }} onToggle={p.onOffset} />
      <ProjectSelect spaceId={p.spaceId} value={p.projectId} onChange={p.setProjectId} />
      <IconChooser value={p.icon} onChange={p.setIcon} />
      <GoalAttachSwitch variant="sheet" taskDate={p.choice.date} attachedGoalId={p.goalId} onChange={p.setGoalId} hideUnavailableSwitch />
    </div>
  </>;
}
