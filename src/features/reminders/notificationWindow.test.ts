import { expect, it } from 'vitest';
import { SPACE_PERSO_ID } from '../../db/seed/defaultSpaces';
import { asLocalDate, asLocalTime } from '../../domain/types';
import { createRoutineUseCases } from '../routines/routineUseCases';
import { replanNotifications } from './replanNotifications';
import { setupReminders } from './testKit';

it('N-TECH-02 : fermeture deux jours puis reprise, cinq gardés et deux nouveaux sur le planificateur', async () => {
  const h = await setupReminders({ startAt: '2026-10-07T08:00:00.000Z' });
  try {
    await h.db.data.repos.settings.set('reminders.morningRecap', { enabled: false, time: asLocalTime('07:30') });
    await h.db.data.repos.settings.set('reminders.eveningRecap', { enabled: false, time: asLocalTime('21:00') });
    const created = await createRoutineUseCases(h.container).create({
      fields: { spaceId: SPACE_PERSO_ID, title: 'Routine', icon: null, scheduleType: 'daily', weekdays: [], timesPerWeek: null, interval: null, startDate: asLocalDate('2026-09-01'), time: asLocalTime('07:00'), paused: false, archived: false },
      reminderOffsets: [0],
    });
    expect(created.ok).toBe(true);
    await replanNotifications(h.container, 'open');
    const initial = await h.fake.pending();
    expect(initial).toHaveLength(7);
    h.db.clock.advance(2 * 24 * 3_600_000);
    expect((await h.fake.pending()).filter(item => item.fireAt > '2026-10-09T10:00')).toHaveLength(5);
    expect(await replanNotifications(h.container, 'resume')).toMatchObject({ status: 'planned', report: { scheduled: 2, kept: 5, cancelled: 2 }, coverage: { state: 'until', until: '2026-10-16T07:00' } });
  } finally {
    await h.db.close();
  }
});
