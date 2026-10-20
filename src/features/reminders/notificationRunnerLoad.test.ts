import { expect, it, vi } from 'vitest';
import { getNotificationRunner } from './notificationRunner';
import { notificationStatusStore, statusController } from './notificationStatus';
import { reopenReminders, setupReminders } from './testKit';

it('N-TECH-02 revue : le faux disponible en navigateur garde le chemin iPhone des essais', async () => {
  const h = await setupReminders({ platform: { runtime: 'web', os: 'ios' } });
  try {
    expect(await getNotificationRunner(h.container).request('open')).toMatchObject({ status: 'planned' });
    expect(h.fake.calls.filter(call => call.type === 'replace')).toHaveLength(1);
  } finally {
    await h.db.close();
  }
});

it('N-TECH-02 : le PC indisponible ne charge pas le planificateur et ne lit pas ses données', async () => {
  const h = await setupReminders({ mode: 'none', platform: { runtime: 'tauri', os: 'windows' } });
  const read = vi.spyOn(h.container.data.repos.reminders, 'listLive');
  vi.doMock('./replanNotifications', () => { throw new Error('must-not-load'); });
  try {
    expect(await getNotificationRunner(h.container).request('open')).toEqual({ status: 'pc' });
    expect(read).not.toHaveBeenCalled();
  } finally {
    vi.doUnmock('./replanNotifications');
    await h.db.close();
  }
});

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
