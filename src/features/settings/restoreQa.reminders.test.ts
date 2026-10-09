import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notificationNumericId } from '../../domain/notificationId';
import type { RawNotificationAction } from '../../domain/notificationActions';
import { createFakeNotificationActionSource, type FakeNotificationActionSource, type NotificationRequest } from '../../platform/notifications';
import { useAppStatusStore } from '../app/appStatus';
import type { AppContainer } from '../app/container';
import { getNotificationRunner } from '../reminders/notificationRunner';
import { replanNotifications } from '../reminders/replanNotifications';
import { reopenReminders, seedReminderTask, setupReminders, type ReminderHarness } from '../reminders/testKit';
import { quiesceForRestore } from './restoreQuiesce';

/**
 * QA du lot F, P-04-iOS critères 6 et 14 : la mise au calme attend une action N-03 en cours d'application ; après une restauration, les
 * rappels sont replanifiés à partir des données restaurées. Horloge : jeu. 8 oct. 2026, 10:00 à Paris.
 */
const lastRequests = (h: ReminderHarness): readonly NotificationRequest[] => {
  const call = [...h.fake.calls].reverse().find((entry) => entry.type === 'replace');
  if (call?.type !== 'replace') throw new Error('aucun replace');
  return call.requests;
};
function line(h: ReminderHarness, sid: string, actionId: RawNotificationAction['actionId']): RawNotificationAction {
  return { numericId: notificationNumericId(sid), actionId, receivedAtMs: h.db.clock.nowMs(), sid, deliveredAt: h.db.clock.nowMs() - 30_000 };
}
async function reminderOf(container: AppContainer, taskId: string): Promise<string> {
  const found = (await container.data.repos.reminders.listLive()).find((row) => row.targetId === (taskId as unknown as typeof row.targetId));
  if (found === undefined) throw new Error('rappel introuvable');
  return found.id;
}
const turns = async (count = 20): Promise<void> => {
  for (let i = 0; i < count; i += 1) await Promise.resolve();
};

describe('P-04-iOS QA : restauration et rappels / actions N-03', () => {
  let source: FakeNotificationActionSource;
  let h: ReminderHarness;
  beforeEach(async () => {
    source = createFakeNotificationActionSource();
    h = await setupReminders({ parts: { notificationActions: source } });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.db.close();
    useAppStatusStore.setState({ sources: {} });
  });

  it('critère 6 : une action N-03 en cours d’application est attendue ; aucun passage ne démarre ensuite avant la reprise', async () => {
    const task = await seedReminderTask(h.container, { title: 'Appeler le médecin', date: '2026-10-08', time: '12:00', offsets: [0] });
    const rid = await reminderOf(h.container, task.id);
    await replanNotifications(h.container, 'open');
    const realDrain = source.drain.bind(source);
    let releaseDrain: (() => void) | undefined;
    vi.spyOn(source, 'drain').mockImplementationOnce(() => new Promise((resolve) => (releaseDrain = () => resolve(realDrain()))));
    source.push(line(h, `task:${rid}`, 'done'), { wake: false });
    const runner = getNotificationRunner(h.container);
    const acting = runner.request('action');
    await turns();
    expect(releaseDrain).toBeDefined();

    let quiet: Awaited<ReturnType<typeof quiesceForRestore>> | undefined;
    const quiescing = quiesceForRestore(h.container, 60_000).then((handle) => (quiet = handle));
    await turns();
    expect(quiet, 'la base ne doit pas être fermée tant que l’action n’est pas écrite').toBeUndefined();
    expect((await h.db.data.repos.tasks.getById(task.id))?.status).toBe('todo');

    releaseDrain?.();
    await acting;
    await quiescing;
    expect(typeof quiet).toBe('object');
    // L'action a été écrite AVANT que la restauration puisse continuer.
    expect((await h.db.data.repos.tasks.getById(task.id))?.status).toBe('done');

    // En pause, une demande (retour au premier plan, synchro) attend ; rien n'est lu dans le fichier natif.
    const drains = source.calls.filter((call) => call === 'drain').length;
    const later = runner.request('resume');
    await turns();
    expect(source.calls.filter((call) => call === 'drain').length).toBe(drains);
    if (typeof quiet === 'object') quiet.release();
    await later;
    expect(source.calls.filter((call) => call === 'drain').length).toBeGreaterThan(drains);
  });

  it('critère 14 : après le rechargement, le plan des rappels est remplacé par celui des données restaurées', async () => {
    const kept = await seedReminderTask(h.container, { title: 'Dans la version restaurée', date: '2026-10-08', time: '12:00', offsets: [0] });
    const absent = await seedReminderTask(h.container, { title: 'Absente de la version restaurée', date: '2026-10-08', time: '14:00', offsets: [0] });
    const keptRid = await reminderOf(h.container, kept.id);
    const absentRid = await reminderOf(h.container, absent.id);
    await replanNotifications(h.container, 'open');
    expect(lastRequests(h).filter((r) => r.kind === 'task').map((r) => r.id).sort()).toEqual([`task:${absentRid}`, `task:${keptRid}`].sort());
    // La restauration remplace la base : la tâche n'existe plus du tout (ni ligne supprimée logiquement).
    await h.db.driver.execute('DELETE FROM reminder WHERE target_id = ?', [absent.id]);
    await h.db.driver.execute('DELETE FROM task WHERE id = ?', [absent.id]);
    const reloaded = reopenReminders(h, { parts: { notificationActions: source } });
    await replanNotifications(reloaded, 'open');
    expect(lastRequests(h).filter((r) => r.kind === 'task').map((r) => r.id)).toEqual([`task:${keptRid}`]);
  });
});
