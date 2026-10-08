import type { LocalDate, LocalTime, SpaceId } from '../../domain/types';
import type { ReminderOffsetMin } from '../../domain/model';
import { t } from '../../i18n';
import { IphoneReminderWarning } from './IphoneReminderWarning';
import { ReminderChoices } from './ReminderChoices';

export interface ReminderBlockProps {
  readonly time: LocalTime | null;
  readonly offsets: readonly ReminderOffsetMin[];
  readonly onToggle: (offset: ReminderOffsetMin) => void;
  /** N-07 : date et espace de l'élément, pour l'avertissement du PC « l'iPhone n'a peut-être pas reçu ce rappel » (absent : pas d'avertissement). */
  readonly warnFor?: { readonly spaceId: SpaceId | null; readonly date: LocalDate | null };
}

/** Bloc « Rappel » d'une feuille (Ajout.html) : grisé tant qu'aucune heure n'est choisie (QB-07). */
export function ReminderBlock({ time, offsets, onToggle, warnFor }: ReminderBlockProps) {
  return (
    <div className="ct-reminder-block" role="group" aria-label={t('reminders.blockLabel')}>
      <span className="ct-reminder-block__label">{t('reminders.blockLabel')}</span>
      <div className="ct-reminder-block__row">
        <ReminderChoices offsets={offsets} enabled={time !== null} onToggle={onToggle} plusLabel={t('reminders.more')} />
      </div>
      {warnFor && <IphoneReminderWarning spaceId={warnFor.spaceId} date={warnFor.date} time={time} offsets={offsets} />}
    </div>
  );
}
