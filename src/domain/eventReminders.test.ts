import { describe, expect, it } from 'vitest';
import { buildEventReminders, normalizeEventReminderOffsets, toggleEventReminderOffset } from './eventReminders';
import { makeEvent } from './eventTestKit';
import { asEntityId, asLocalDate as d, asLocalTime as tm, type ReminderId } from './types';

let n = 0;
const newId = () => asEntityId<ReminderId>(`93000000-0000-4000-8000-${String((n += 1)).padStart(12, '0')}`);

describe('rappels d’événement (E-01 critère 5)', () => {
  it('journée entière : 09:00 locale, 1 semaine avant / la veille / le jour même', () => {
    const rows = buildEventReminders({ event: makeEvent({ startDate: '2026-10-05' }), offsets: [0, 1440, 10080], today: d('2026-09-23'), newReminderId: newId });
    expect(rows.map((r) => [r.offsetMin, r.fireAt, r.targetType])).toEqual([
      [0, '2026-10-05T09:00', 'event'],
      [1440, '2026-10-04T09:00', 'event'],
      [10080, '2026-09-28T09:00', 'event'],
    ]);
  });

  it('événement à heures : l’heure de début moins l’avance', () => {
    const event = makeEvent({ allDay: false, startDate: '2026-10-05', startTime: tm('10:00'), endTime: tm('11:00') });
    const rows = buildEventReminders({ event, offsets: [1440, 0], today: d('2026-09-23'), newReminderId: newId });
    expect(rows.map((r) => r.fireAt)).toEqual(['2026-10-05T10:00', '2026-10-04T10:00']);
  });

  it('série : calculé sur la prochaine occurrence à venir', () => {
    const event = makeEvent({ startDate: '1992-09-25', repeat: 'yearly' });
    expect(buildEventReminders({ event, offsets: [1440], today: d('2026-09-26'), newReminderId: newId })[0]?.fireAt).toBe('2027-09-24T09:00');
    expect(buildEventReminders({ event, offsets: [1440], today: d('2026-09-20'), newReminderId: newId })[0]?.fireAt).toBe('2026-09-24T09:00');
  });

  it('avances inconnues ignorées, sans doublon ; bascule', () => {
    expect(normalizeEventReminderOffsets([1440, 5, 1440, 10080])).toEqual([1440, 10080]);
    expect(toggleEventReminderOffset([0], 10080)).toEqual([0, 10080]);
    expect(toggleEventReminderOffset([0, 10080], 0)).toEqual([10080]);
  });
});
