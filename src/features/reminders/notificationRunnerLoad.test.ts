import { expect, it, vi } from 'vitest';
import { getNotificationRunner } from './notificationRunner';
import { notificationStatusStore, statusController } from './notificationStatus';
import { reopenReminders, setupReminders } from './testKit';

it('N-TECH-02 : bloc impossible à charger, échec persistant visible après redémarrage', async () => {
  const h = await setupReminders();
  vi.doMock('./replanNotifications', () => { throw new Error('chunk-load-failed'); });
  try {
    expect(await getNotificationRunner(h.container).request('open')).toEqual({ status: 'failed', reason: 'schedule-failed' });
    expect(notificationStatusStore.get(h.container).getState().status.planFailure).toMatchObject({ reason: 'schedule-failed' });
    const reopened = reopenReminders(h);
    await statusController(reopened).load();
    expect(notificationStatusStore.get(reopened).getState().status.planFailure).toMatchObject({ reason: 'schedule-failed' });
    expect(h.fake.calls.filter(call => call.type === 'replace')).toHaveLength(0);
    vi.doUnmock('./replanNotifications');
    expect(await getNotificationRunner(reopened).request('resume')).toMatchObject({ status: 'planned' });
    expect(notificationStatusStore.get(reopened).getState().status.planFailure).toBeNull();
  } finally {
    vi.doUnmock('./replanNotifications');
    await h.db.close();
  }
});
