import { CalendarDays, Clock } from 'lucide-react';
import { useId, useState } from 'react';
import type { DateChoice } from '../../domain/dateInput';
import type { LocalDate } from '../../domain/types';
import { t } from '../../i18n';
import { formatDetailDate, formatTime } from '../../i18n/format';
import { tTaskRefonte } from '../../i18n/taskRefonteText';
import { DatePicker, Icon } from '../../ui';

export function TaskSchedulePicker({ value, today, onChange }: { value: DateChoice; today: LocalDate; onChange: (value: DateChoice) => void }) {
  const [open, setOpen] = useState<'date' | 'time' | null>(null);
  const panel = useId();
  const date = value.date === null ? t('datePicker.someday') : value.date === today ? t('datePicker.today') : formatDetailDate(value.date, value.date.slice(0, 4) !== today.slice(0, 4));
  const time = value.time === null ? tTaskRefonte('noTime') : formatTime(value.time);
  return (
    <div className="ct-task-schedule">
      <div className="ct-task-schedule__chips">
        <button type="button" aria-label={`${tTaskRefonte('date')} : ${date}`} aria-expanded={open === 'date'} aria-controls={open === 'date' ? panel : undefined} onClick={() => setOpen(open === 'date' ? null : 'date')}>
          <Icon icon={CalendarDays} size={18} />{date}
        </button>
        <button type="button" aria-label={`${tTaskRefonte('time')} : ${time}`} aria-expanded={open === 'time'} aria-controls={open === 'time' ? panel : undefined} disabled={value.date === null} onClick={() => setOpen(open === 'time' ? null : 'time')}>
          <Icon icon={Clock} size={18} />{time}
        </button>
      </div>
      {open && <div id={panel} className="ct-task-schedule__editor">
        <DatePicker value={value} today={today} onChange={(next) => onChange(next ?? { date: today, time: null })} />
        <button type="button" className="ct-task-schedule__close" onClick={() => setOpen(null)}>{tTaskRefonte('scheduleDone')}</button>
      </div>}
    </div>
  );
}
