import type { LocalDate, LocalTime, SpaceId } from '../../domain/types';
import { isReminderOffset, type ReminderOffsetMin } from '../../domain/model';
import { reminderFireAt } from '../../domain/recurrenceNext';
import { t } from '../../i18n';
import { IphoneReminderWarning } from './IphoneReminderWarning';
import { QuietShiftNotice } from './QuietShiftNotice';
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
      {/* N-FIX-04 : dès le choix, un rappel couvert par une plage silencieuse de l'espace est annoncé avec sa cause. */}
      {warnFor && warnFor.date !== null && time !== null && (
        <QuietShiftNotice spaceId={warnFor.spaceId} fireAts={offsets.filter(isReminderOffset).map((offset) => reminderFireAt(warnFor.date as LocalDate, time, offset))} />
      )}
      {warnFor && <IphoneReminderWarning spaceId={warnFor.spaceId} date={warnFor.date} time={time} offsets={offsets} />}
    </div>
  );
}
