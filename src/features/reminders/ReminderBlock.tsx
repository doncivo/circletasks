import type { LocalTime } from '../../domain/types';
import type { ReminderOffsetMin } from '../../domain/model';
import { t } from '../../i18n';
import { ReminderChoices } from './ReminderChoices';

export interface ReminderBlockProps {
  readonly time: LocalTime | null;
  readonly offsets: readonly ReminderOffsetMin[];
  readonly onToggle: (offset: ReminderOffsetMin) => void;
}

/** Bloc « Rappel » d'une feuille (Ajout.html) : grisé tant qu'aucune heure n'est choisie (QB-07). */
export function ReminderBlock({ time, offsets, onToggle }: ReminderBlockProps) {
  return (
    <div className="ct-reminder-block" role="group" aria-label={t('reminders.blockLabel')}>
      <span className="ct-reminder-block__label">{t('reminders.blockLabel')}</span>
      <div className="ct-reminder-block__row">
        <ReminderChoices offsets={offsets} enabled={time !== null} onToggle={onToggle} plusLabel={t('reminders.more')} />
      </div>
    </div>
  );
}
