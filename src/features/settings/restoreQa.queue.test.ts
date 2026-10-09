import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notificationNumericId } from '../../domain/notificationId';
import { parseActionQueue, type NotificationActionQueueV1, type RawNotificationAction } from '../../domain/notificationActions';
import { createFakeNotificationActionSource, type FakeNotificationActionSource, type NotificationRequest } from '../../platform/notifications';
import { useAppStatusStore } from '../app/appStatus';
import type { AppContainer } from '../app/container';
import { replanNotifications } from '../reminders/replanNotifications';
import { reopenReminders, seedReminderTask, setupReminders, type ReminderHarness } from '../reminders/testKit';
import { writeRestoreResult } from './restoreMemo';
import { announcePendingRestore, RESTORE_RESULT_KEY } from './restoreMemoPeek';
import { useNoticeStore } from '../app/notice';

/**
 * QA du lot F, P-04-iOS critères 6 et 14 : la mise au calme attend une action N-03 en cours d'application ; après une restauration, les
 * rappels sont replanifiés à partir des données restaurées. Horloge : jeu. 8 oct. 2026, 10:00 à Paris.
 */
const banner = () => useAppStatusStore.getState().sources.remindersTrouble;
const storedQueue = async (container: AppContainer): Promise<NotificationActionQueueV1> => {
  const read = parseActionQueue(await container.data.repos.settings.get('notifications.actionQueue'));
  if (read.state !== 'valid') throw new Error('file illisible');
  return read.queue;
};
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

describe('P-04-iOS QA : restauration et rappels / actions N-03', () => {
  let source: FakeNotificationActionSource;
  let h: ReminderHarness;
  beforeEach(async () => {
    source = createFakeNotificationActionSource();
    h = await setupReminders({ parts: { notificationActions: source } });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await h.db.close();
    useAppStatusStore.setState({ sources: {} });
  });


  it('critère 14 : la file d’actions N-03 est vidée de ce qui concerne des identifiants inconnus, sans erreur persistante', async () => {
    const task = await seedReminderTask(h.container, { title: 'Absente de la version restaurée', date: '2026-10-08', time: '12:00', offsets: [0] });
    const rid = await reminderOf(h.container, task.id);
    // Avant la restauration : un « +15 min » en attente (répétition planifiée) et un « Fait » reçu mais pas encore appliqué.
    source.push(line(h, `task:${rid}`, 'snooze15'), { wake: false });
    await replanNotifications(h.container, 'action');
    expect((await storedQueue(h.container)).snoozes).toHaveLength(1);
    source.push(line(h, `task:${rid}`, 'done'), { wake: false });
    // Restauration : la version restaurée ne connaît ni la tâche, ni son rappel (sa propre file, copiée de la sauvegarde, est reprise telle quelle).
    await h.db.driver.execute('DELETE FROM reminder WHERE target_id = ?', [task.id]);
    await h.db.driver.execute('DELETE FROM task WHERE id = ?', [task.id]);
    // Rechargement après la restauration : l'issue mémorisée est dite au lancement (chemin réel de startup.ts ; stockage de la page simulé).
    const memory = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k) });
    vi.stubGlobal('window', { localStorage: globalThis.localStorage });
    writeRestoreResult({ outcome: 'done', reason: null, databaseClosed: false, marker: 'not-configured', markerCode: null });
    announcePendingRestore({ actionQueue: true });
    // Revue du lot F : le mémo reste jusqu'au nettoyage de la file (un arrêt avant lui le refait au lancement suivant, sans redire l'issue).
    expect(memory.has(RESTORE_RESULT_KEY)).toBe(true);
    useNoticeStore.getState().clear();
    announcePendingRestore({ actionQueue: true });
    expect(useNoticeStore.getState().notice, 'issue dite une seule fois').toBeNull();
    const reloaded = reopenReminders(h, { parts: { notificationActions: source } });
    await replanNotifications(reloaded, 'open');
    expect(memory.has(RESTORE_RESULT_KEY), 'mémo effacé APRÈS le nettoyage de la file N-03').toBe(false);
    const queue = await storedQueue(reloaded);
    expect(queue.entries, 'aucune action en échec pour un identifiant inconnu').toEqual([]);
    expect(queue.snoozes, 'aucune répétition d’un rappel absent').toEqual([]);
    expect(banner(), 'aucun bandeau persistant').toBeUndefined();
    expect(lastRequests(h).some((r) => r.kind === 'snooze')).toBe(false);
  });
});
