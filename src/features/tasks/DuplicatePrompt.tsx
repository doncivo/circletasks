import { todayLocal } from '../../domain/clock';
import type { Task } from '../../domain/model';
import { duplicateDefaultDate } from '../../domain/taskDuplicate';
import type { LocalDate } from '../../domain/types';
import { t } from '../../i18n';
import { DatePrompt } from '../../ui';
import { useAppContainer } from '../app/AppContainerContext';

interface DuplicatePromptProps {
  task: Pick<Task, 'date' | 'someday'>;
  /** Date choisie (null : « Un jour ») ; la copie est créée par l'appelant. */
  onConfirm: (date: LocalDate | null) => void;
  /** Échap / Fermer : rien n'est créé. */
  onClose: () => void;
}

/**
 * Choix de la date d'une duplication (T-12, Q8) : le sélecteur s'ouvre présélectionné sur la date
 * de la tâche d'origine (« Un jour » si elle y est), avec le raccourci « Un jour ».
 */
export function DuplicatePrompt({ task, onConfirm, onClose }: DuplicatePromptProps) {
  const container = useAppContainer();
  const today = todayLocal(container.clock);
  return (
    <DatePrompt
      open
      allowSomeday
      label={t('tasks.duplicatePickDate')}
      confirmLabel={t('tasks.duplicate')}
      today={today}
      initialValue={duplicateDefaultDate(task, today)}
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
}
