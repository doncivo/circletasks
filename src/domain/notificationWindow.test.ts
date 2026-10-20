import { describe, expect, it } from 'vitest';
import type { Reminder } from './model';
import { planNotifications } from './notificationPlan';
import { makeRoutine } from './routineTestKit';
import { asLocalDateTime, asLocalTime } from './types';

describe('N-TECH-02 : couverture réelle des routines', () => {
  const routine = makeRoutine({ time: asLocalTime('07:00') });
  const reminder = {
    id: '22000000-0000-4000-8000-000000000001', targetType: 'routine', targetId: routine.id,
    offsetMin: 0, deletedAt: null,
  } as Reminder;
  const plan = (now: string) => planNotifications({
    now: asLocalDateTime(now), tasks: [], routines: [routine], routinePauses: [], routineLogs: [], events: [],
    reminders: [reminder], spaces: [{ id: routine.spaceId, quietHours: [] }],
    recaps: { morning: { enabled: false, time: asLocalTime('07:30') }, evening: { enabled: false, time: asLocalTime('21:00') } },
  });

  it('application fermée deux jours : cinq rappels restent sans aucun nouveau passage', () => {
    const initial = plan('2026-10-07T10:00');
    expect(initial.items).toHaveLength(7);
    expect(initial.items.filter(item => item.fireAt > '2026-10-09T10:00').map(item => item.fireAt)).toEqual([
      '2026-10-10T07:00', '2026-10-11T07:00', '2026-10-12T07:00', '2026-10-13T07:00', '2026-10-14T07:00',
    ]);
    expect(initial.coverage).toEqual({ state: 'until', until: '2026-10-14T07:00' });
    expect(plan('2026-10-09T10:00').items.map(item => item.fireAt)).toEqual([
      '2026-10-10T07:00', '2026-10-11T07:00', '2026-10-12T07:00', '2026-10-13T07:00', '2026-10-14T07:00', '2026-10-15T07:00', '2026-10-16T07:00',
    ]);
  });
});
