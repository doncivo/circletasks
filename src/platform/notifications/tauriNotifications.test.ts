import { describe, expect, it } from 'vitest';
import { EMPTY_LEDGER, type NotificationLedgerV1 } from '../../domain/notificationLedger';
import { fireAtInstant } from '../../domain/notificationInstant';
import { NUMERIC_ID_MAX, NUMERIC_ID_MIN, notificationNumericId } from '../../domain/notificationId';
import type { LocalDateTime } from '../../domain/types';
import { createFakeBridge, createMemoryLedger, type FakeBridge, type MemoryLedger } from './fakeBridge';
import { createLedgerStore } from './notificationLedger';
import { assignPlanIds, createIosNotificationBridge, createTauriNotificationScheduler, requestFingerprint, type ShowPayload } from './tauriNotifications';
import { NotificationSchedulerError, type NotificationRequest, type NotificationScheduler } from './types';

const NOW = Date.UTC(2026, 9, 8, 10, 0, 0); // 2026-10-08 12:00 à Paris (UTC+2)
const clock = { now: NOW, zoneName: 'Europe/Paris' as string | null };

interface Rig {
  readonly bridge: FakeBridge;
  readonly ledger: MemoryLedger;
  readonly scheduler: NotificationScheduler;
  /** Un autre processus : mêmes pont et registre, état en mémoire neuf (l'app a été tuée puis relancée). */
  restart(): NotificationScheduler;
}

function rig(): Rig {
  clock.now = NOW;
  clock.zoneName = 'Europe/Paris';
  const bridge = createFakeBridge();
  const ledger = createMemoryLedger();
  const store = createLedgerStore(ledger);
  const make = (): NotificationScheduler => createTauriNotificationScheduler({ bridge, ledger: store, clock: { nowMs: () => clock.now, zone: () => clock.zoneName } });
  return { bridge, ledger, scheduler: make(), restart: make };
}

const req = (id: string, fireAt: string, over: Partial<NotificationRequest> = {}): NotificationRequest => ({
  id,
  fireAt: fireAt as LocalDateTime,
  title: `Titre ${id}`,
  body: 'À l’heure',
  kind: 'task',
  ...over,
});

describe('adaptateur iOS : envoi (N-01 critère 4)', () => {
  it('show élément par élément, jamais sendNotification : date en heure murale avec Z littéral, son, extra en chaînes', async () => {
    const { bridge, scheduler } = rig();
    const report = await scheduler.replace([req('task:a', '2026-10-09T09:00')]);
    expect(report).toEqual({ scheduled: 1, cancelled: 0, kept: 0 });
    expect(bridge.shown).toHaveLength(1);
    const payload = bridge.shown[0] as ShowPayload;
    // 09:00 à Paris, jamais l'UTC (07:00).
    expect(payload.schedule).toEqual({ at: { date: '2026-10-09T09:00:00.000Z', repeating: false, allowWhileIdle: false } });
    expect(payload.sound).toBe('default');
    expect(payload.title).toBe('Titre task:a');
    expect(payload.extra).toEqual({ sid: 'task:a', at: String(fireAtInstant('2026-10-09T09:00' as LocalDateTime, 'Europe/Paris')) });
    expect(payload).not.toHaveProperty('actionTypeId');
    expect(payload.id).toBe(notificationNumericId('task:a'));
    expect(payload.id).toBeGreaterThanOrEqual(NUMERIC_ID_MIN);
    expect(bridge.calls.filter((call) => call !== 'show' && call !== 'pending' && call !== 'permission')).toEqual([]);
  });

  it('envoie par ordre chronologique : une coupure laisse les plus proches planifiés', async () => {
    const { bridge, scheduler } = rig();
    await scheduler.replace([req('task:c', '2026-10-11T09:00'), req('task:a', '2026-10-09T09:00'), req('task:b', '2026-10-10T09:00')]);
    expect(bridge.shown.map((payload) => payload.extra['sid'])).toEqual(['task:a', 'task:b', 'task:c']);
  });

  it('deux appels identiques : { 0, 0, n } et aucun nouvel envoi', async () => {
    const { bridge, scheduler } = rig();
    const plan = [req('task:a', '2026-10-09T09:00'), req('task:b', '2026-10-10T09:00')];
    await scheduler.replace(plan);
    const sentBefore = bridge.shown.length;
    expect(await scheduler.replace(plan)).toEqual({ scheduled: 0, cancelled: 0, kept: 2 });
    expect(bridge.shown).toHaveLength(sentBefore);
  });

  it('même identifiant stable, échéance ou texte changé : remplacé (même identifiant numérique, compté une fois)', async () => {
    const { bridge, scheduler } = rig();
    await scheduler.replace([req('task:a', '2026-10-09T09:00')]);
    const id = bridge.shown[0]?.id;
    expect(await scheduler.replace([req('task:a', '2026-10-09T10:00')])).toEqual({ scheduled: 1, cancelled: 0, kept: 0 });
    expect(await scheduler.replace([req('task:a', '2026-10-09T10:00', { title: 'Autre titre' })])).toEqual({ scheduled: 1, cancelled: 0, kept: 0 });
    expect(bridge.shown.map((payload) => payload.id)).toEqual([id, id, id]);
    expect(bridge.pendingMap.size).toBe(1);
    expect(bridge.pendingMap.get(id as number)?.date).toBe('2026-10-09T10:00:00.000Z');
  });

  it('absent du nouveau plan : annulé par cancel avec la liste des identifiants numériques (jamais sans liste, jamais vide)', async () => {
    const { bridge, scheduler } = rig();
    await scheduler.replace([req('task:a', '2026-10-09T09:00'), req('task:b', '2026-10-10T09:00')]);
    expect(bridge.cancels).toEqual([]);
    expect(await scheduler.replace([req('task:b', '2026-10-10T09:00')])).toEqual({ scheduled: 0, cancelled: 1, kept: 1 });
    expect(bridge.cancels).toEqual([[notificationNumericId('task:a')]]);
    expect(bridge.pendingMap.size).toBe(1);
    await scheduler.replace([req('task:b', '2026-10-10T09:00')]);
    expect(bridge.cancels).toHaveLength(1);
  });

  it('une échéance passée à l’envoi n’est pas transmise, sans erreur, et reste absente de pending()', async () => {
    const { bridge, scheduler } = rig();
    // 12:00:03 à Paris : dans la marge de 5 s ; 11:00 : passée.
    clock.now = NOW + 3_000;
    const report = await scheduler.replace([req('task:soon', '2026-10-08T12:00'), req('task:past', '2026-10-08T11:00'), req('task:ok', '2026-10-09T09:00')]);
    expect(report).toEqual({ scheduled: 1, cancelled: 0, kept: 0 });
    expect(bridge.shown.map((payload) => payload.extra['sid'])).toEqual(['task:ok']);
    expect((await scheduler.pending()).map((request) => request.id)).toEqual(['task:ok']);
  });

  it('une notification sur le point de sonner (dans la marge) et déjà planifiée n’est jamais annulée', async () => {
    const { bridge, scheduler } = rig();
    await scheduler.replace([req('task:a', '2026-10-08T12:01')]);
    clock.now = NOW + 57_000; // 12:00:57 : l'échéance de 12:01 est dans 3 s
    const report = await scheduler.replace([req('task:a', '2026-10-08T12:01')]);
    expect(report).toEqual({ scheduled: 0, cancelled: 0, kept: 1 });
    expect(bridge.cancels).toEqual([]);
    expect(bridge.pendingMap.size).toBe(1);
  });

  it('identifiant numérique : 65 536 + FNV-1a mod (2^31 - 65 536), jamais dans [1 ; 65 535]', async () => {
    const { bridge, scheduler } = rig();
    const ids = Array.from({ length: 30 }, (_, index) => `task:${String(index)}`);
    await scheduler.replace(ids.map((id, index) => req(id, `2026-10-${String(9 + (index % 10)).padStart(2, '0')}T09:00`)));
    for (const payload of bridge.shown) {
      expect(payload.id).toBeGreaterThanOrEqual(NUMERIC_ID_MIN);
      expect(payload.id).toBeLessThanOrEqual(NUMERIC_ID_MAX);
      expect(payload.id).toBe(notificationNumericId(payload.extra['sid'] as string));
    }
  });
});

describe('adaptateur iOS : validation et état du système avant tout effet (N-01 critère 4)', () => {
  it('liste fautive : refus typé, rien envoyé ni annulé', async () => {
    const { bridge, scheduler } = rig();
    await expect(scheduler.replace([req('task:a', '2026-10-09T09:00', { title: '  ' })])).rejects.toMatchObject({ reason: 'invalid-request', ids: ['task:a'] });
    await expect(scheduler.replace([req('task:a', '2026-10-09T09:00'), req('task:a', '2026-10-09T10:00')])).rejects.toMatchObject({ reason: 'duplicate-id' });
    expect(bridge.calls.filter((call) => call === 'show' || call === 'cancel')).toEqual([]);
  });

  it('plafond : 64 demandés avec la fin de Focus (identifiant 1) en attente = over-limit, rien modifié', async () => {
    const { bridge, scheduler } = rig();
    bridge.pendingMap.set(1, { id: 1, title: 'Session terminée', body: 'x', date: '2026-10-09T09:00:00.000Z' });
    const many = Array.from({ length: 64 }, (_, index) => req(`task:${String(index)}`, `2026-10-${String(10 + (index % 15))}T09:00`));
    await expect(scheduler.replace(many)).rejects.toMatchObject({ reason: 'over-limit' });
    expect(bridge.shown).toEqual([]);
    expect(await scheduler.reservedCount()).toBe(1);
    expect(await scheduler.replace(many.slice(0, 63))).toMatchObject({ scheduled: 63 });
  });

  it.each(['denied', 'undetermined'] as const)('autorisation %s : permission-denied avant tout effet', async (state) => {
    const { bridge, scheduler } = rig();
    bridge.permissionState = state;
    await expect(scheduler.replace([req('task:a', '2026-10-09T09:00')])).rejects.toMatchObject({ reason: 'permission-denied' });
    expect(bridge.calls.filter((call) => call === 'show' || call === 'cancel')).toEqual([]);
  });

  it('moteur indisponible : unavailable avant tout effet', async () => {
    const { bridge, scheduler } = rig();
    bridge.permissionState = 'unavailable';
    await expect(scheduler.replace([req('task:a', '2026-10-09T09:00')])).rejects.toMatchObject({ reason: 'unavailable' });
    expect(await scheduler.availability()).toBe('unavailable');
    expect(bridge.shown).toEqual([]);
  });

  it('get_pending illisible : verify-failed avant tout effet', async () => {
    const { bridge, scheduler } = rig();
    bridge.failPending = true;
    await expect(scheduler.replace([req('task:a', '2026-10-09T09:00')])).rejects.toMatchObject({ reason: 'verify-failed' });
    expect(bridge.shown).toEqual([]);
  });
});

describe('adaptateur iOS : vérification et échecs (N-01 critère 4)', () => {
  it('un rejet de show : schedule-failed APRÈS avoir tenté les autres, partial exact, registre = ce qu’iOS confirme', async () => {
    const { bridge, ledger, scheduler } = rig();
    bridge.failShow = (payload) => payload.extra['sid'] === 'task:b';
    const error = await scheduler.replace([req('task:a', '2026-10-09T09:00'), req('task:b', '2026-10-10T09:00'), req('task:c', '2026-10-11T09:00')]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotificationSchedulerError);
    expect(error).toMatchObject({ reason: 'schedule-failed', ids: ['task:b'], partial: { scheduled: 2, cancelled: 0, kept: 0 } });
    expect(bridge.shown.map((payload) => payload.extra['sid'])).toEqual(['task:a', 'task:c']);
    expect(ledger.saves.at(-1)?.entries.map((entry) => entry.sid).sort()).toEqual(['task:a', 'task:c']);
    // Au passage suivant (iOS accepte), seul l'élément manquant est envoyé.
    bridge.failShow = () => false;
    expect(await scheduler.replace([req('task:a', '2026-10-09T09:00'), req('task:b', '2026-10-10T09:00'), req('task:c', '2026-10-11T09:00')])).toEqual({ scheduled: 1, cancelled: 0, kept: 2 });
  });

  it('un identifiant attendu absent de get_pending après l’envoi : verify-failed (échec silencieux de iOS)', async () => {
    const { bridge, scheduler } = rig();
    bridge.dropOnShow = (payload) => payload.extra['sid'] === 'task:b';
    await expect(scheduler.replace([req('task:a', '2026-10-09T09:00'), req('task:b', '2026-10-10T09:00')])).rejects.toMatchObject({
      reason: 'verify-failed',
      ids: ['task:b'],
      partial: { scheduled: 2, cancelled: 0, kept: 0 },
    });
  });

  it('un rejet de cancel : schedule-failed, les envois sont quand même tentés', async () => {
    const { bridge, scheduler } = rig();
    await scheduler.replace([req('task:a', '2026-10-09T09:00')]);
    bridge.failCancel = true;
    await expect(scheduler.replace([req('task:b', '2026-10-10T09:00')])).rejects.toMatchObject({ reason: 'schedule-failed', partial: { scheduled: 1, cancelled: 0, kept: 0 } });
    expect(bridge.shown.map((payload) => payload.extra['sid'])).toEqual(['task:a', 'task:b']);
  });

  it('get_pending illisible à la relecture : verify-failed, registre inchangé', async () => {
    const { bridge, ledger, scheduler } = rig();
    await scheduler.replace([req('task:a', '2026-10-09T09:00')]);
    const saves = ledger.saves.length;
    let reads = 0;
    const original = bridge.pending;
    bridge.pending = () => {
      reads += 1;
      return reads === 2 ? Promise.reject(new Error('illisible')) : original();
    };
    await expect(scheduler.replace([req('task:a', '2026-10-09T09:00'), req('task:b', '2026-10-10T09:00')])).rejects.toMatchObject({ reason: 'verify-failed' });
    expect(ledger.saves).toHaveLength(saves);
  });
});

describe('adaptateur iOS : fin de Focus et plage réservée (N-01 critère 5)', () => {
  it('cancelAll et pending() ne portent que sur la plage du plan : l’identifiant 1 reste en attente', async () => {
    const { bridge, scheduler } = rig();
    bridge.pendingMap.set(1, { id: 1, title: 'Session terminée', body: 'x', date: '2026-10-09T09:00:00.000Z' });
    await scheduler.replace([req('task:a', '2026-10-09T09:00')]);
    expect(bridge.pendingMap.size).toBe(2);
    expect((await scheduler.pending()).map((request) => request.id)).toEqual(['task:a']);
    await scheduler.cancelAll();
    expect([...bridge.pendingMap.keys()]).toEqual([1]);
    expect(bridge.cancels.at(-1)).toEqual([notificationNumericId('task:a')]);
    expect(await scheduler.reservedCount()).toBe(1);
  });

  it('un replace ne retire jamais l’identifiant 1, même s’il est en attente et absent du plan', async () => {
    const { bridge, scheduler } = rig();
    bridge.pendingMap.set(1, { id: 1, title: 'Session terminée', body: 'x', date: '2026-10-09T09:00:00.000Z' });
    await scheduler.replace([req('task:a', '2026-10-09T09:00')]);
    await scheduler.replace([]);
    expect([...bridge.pendingMap.keys()]).toEqual([1]);
    expect(bridge.cancels.flat()).not.toContain(1);
  });

  it('pending() : échéance en heure locale, texte lu chez iOS, nature du registre', async () => {
    const { scheduler } = rig();
    await scheduler.replace([req('task:a', '2026-10-09T09:00'), req('recap:evening:2026-10-09', '2026-10-09T21:00', { kind: 'recap', title: 'Soir', body: 'Tout est fait' })]);
    expect(await scheduler.pending()).toEqual([
      { id: 'task:a', fireAt: '2026-10-09T09:00', title: 'Titre task:a', body: 'À l’heure', kind: 'task' },
      { id: 'recap:evening:2026-10-09', fireAt: '2026-10-09T21:00', title: 'Soir', body: 'Tout est fait', kind: 'recap' },
    ]);
  });
});

describe('adaptateur iOS : registre local (N-01 critère 6)', () => {
  const plan = [req('task:a', '2026-10-09T09:00'), req('task:b', '2026-10-10T09:00')];

  it('registre perdu (réinstallation) avec un plan encore en attente : tout est replanifié une fois, sans doublon', async () => {
    const { bridge, ledger, scheduler } = rig();
    await scheduler.replace(plan);
    const ids = [...bridge.pendingMap.keys()].sort();
    ledger.read = { state: 'missing' };
    expect(await scheduler.replace(plan)).toEqual({ scheduled: 2, cancelled: 0, kept: 0 });
    expect([...bridge.pendingMap.keys()].sort()).toEqual(ids);
    expect(await scheduler.replace(plan)).toEqual({ scheduled: 0, cancelled: 0, kept: 2 });
  });

  it('registre illisible : même résultat juste, et les notifications d’un plan disparu du nouveau plan sont annulées (get_pending fait foi)', async () => {
    const { bridge, ledger, scheduler } = rig();
    await scheduler.replace(plan);
    ledger.read = { state: 'unreadable' };
    expect(await scheduler.replace([plan[1] as NotificationRequest])).toEqual({ scheduled: 1, cancelled: 1, kept: 0 });
    expect([...bridge.pendingMap.keys()]).toEqual([notificationNumericId('task:b')]);
  });

  it('registre présent mais plan vidé par iOS : ce qui manque est replanifié', async () => {
    const { bridge, scheduler } = rig();
    await scheduler.replace(plan);
    bridge.pendingMap.clear();
    expect(await scheduler.replace(plan)).toEqual({ scheduled: 2, cancelled: 0, kept: 0 });
    expect(bridge.pendingMap.size).toBe(2);
  });

  it('un envoi réussi dont le registre n’est pas écrit : ledger-failed, puis le passage suivant remplace sans doublon', async () => {
    const { bridge, ledger, scheduler } = rig();
    ledger.failSave = true;
    await expect(scheduler.replace(plan)).rejects.toMatchObject({ reason: 'ledger-failed', partial: { scheduled: 2, cancelled: 0, kept: 0 } });
    const ids = [...bridge.pendingMap.keys()].sort();
    expect(ids).toHaveLength(2);
    ledger.failSave = false;
    expect(await scheduler.replace(plan)).toEqual({ scheduled: 2, cancelled: 0, kept: 0 });
    expect([...bridge.pendingMap.keys()].sort()).toEqual(ids);
    expect(await scheduler.replace(plan)).toEqual({ scheduled: 0, cancelled: 0, kept: 2 });
  });

  it('le registre ne contient ni titre ni texte, et la fin de Focus y est conservée par un replace', async () => {
    const { ledger, scheduler } = rig();
    ledger.read = { state: 'valid', ledger: { ...EMPTY_LEDGER, focusEnd: { sessionId: 's1', at: 42 } } };
    await scheduler.replace(plan);
    const saved = ledger.saves.at(-1) as NotificationLedgerV1;
    expect(saved.focusEnd).toEqual({ sessionId: 's1', at: 42 });
    expect(saved.zone).toBe('Europe/Paris');
    expect(JSON.stringify(saved)).not.toContain('Titre');
    expect(saved.entries[0]).toMatchObject({ sid: 'task:a', kind: 'task', h: requestFingerprint(plan[0] as NotificationRequest) });
  });
});

describe('adaptateur iOS : réaffirmation par processus (constat 9)', () => {
  it('au premier replace d’un processus, les inchangés sont renvoyés (même identifiant) mais comptés kept ; ensuite plus rien', async () => {
    const { bridge, restart, scheduler } = rig();
    const plan = [req('task:a', '2026-10-09T09:00'), req('task:b', '2026-10-10T09:00')];
    await scheduler.replace(plan);
    const before = bridge.shown.length;
    const relaunched = restart();
    expect(await relaunched.replace(plan)).toEqual({ scheduled: 0, cancelled: 0, kept: 2 });
    expect(bridge.shown.length - before).toBe(2);
    expect(bridge.pendingMap.size).toBe(2);
    expect(await relaunched.replace(plan)).toEqual({ scheduled: 0, cancelled: 0, kept: 2 });
    expect(bridge.shown.length - before).toBe(2);
  });
});

describe('adaptateur iOS : fuseau (N-06 critère 1)', () => {
  it('même plan, fuseau changé : l’instant change, l’adaptateur replanifie tout (le déclencheur iOS est relatif)', async () => {
    const { bridge, scheduler } = rig();
    const plan = [req('task:a', '2026-12-01T09:00'), req('task:b', '2026-12-02T09:00')];
    await scheduler.replace(plan);
    expect(await scheduler.replace(plan)).toEqual({ scheduled: 0, cancelled: 0, kept: 2 });
    clock.zoneName = 'America/New_York';
    expect(await scheduler.replace(plan)).toEqual({ scheduled: 2, cancelled: 0, kept: 0 });
    // L'heure murale reste 09:00 dans le nouveau fuseau ; l'instant est 6 h plus tard.
    expect(bridge.shown.at(-1)?.schedule.at.date).toBe('2026-12-02T09:00:00.000Z');
    expect(Number(bridge.shown.at(-1)?.extra['at']) - Number(bridge.shown[1]?.extra['at'])).toBe(6 * 3_600_000);
  });

  it('fuseau illisible (null) : le décalage courant du moteur JS, passage mené à bout', async () => {
    const { bridge, scheduler } = rig();
    clock.zoneName = null;
    await scheduler.replace([req('task:a', '2026-12-01T09:00')]);
    expect(bridge.shown[0]?.schedule.at.date).toBe('2026-12-01T09:00:00.000Z');
    expect(bridge.shown[0]?.extra['at']).toBe(String(new Date(2026, 11, 1, 9, 0).getTime()));
  });

  it('le registre garde le fuseau de l’envoi réussi ; un échec ne le change pas', async () => {
    const { bridge, ledger, scheduler } = rig();
    await scheduler.replace([req('task:a', '2026-12-01T09:00')]);
    expect(ledger.saves.at(-1)?.zone).toBe('Europe/Paris');
    clock.zoneName = 'America/New_York';
    bridge.failShow = () => true;
    await expect(scheduler.replace([req('task:a', '2026-12-01T09:00')])).rejects.toMatchObject({ reason: 'schedule-failed' });
    expect(ledger.saves.at(-1)?.zone).toBe('Europe/Paris');
    bridge.failShow = () => false;
    await scheduler.replace([req('task:a', '2026-12-01T09:00')]);
    expect(ledger.saves.at(-1)?.zone).toBe('America/New_York');
  });
});

describe('identifiants numériques du plan (N-01 critère 3)', () => {
  it('registre préféré s’il est libre ; collision : valeur libre suivante, sans erreur ; hors plage ignoré', () => {
    const a = notificationNumericId('task:a');
    const ids = assignPlanIds(['task:b', 'task:a'], new Map([['task:a', a], ['task:b', a]]));
    expect(ids.get('task:a')).toBe(a);
    expect(ids.get('task:b')).toBe(notificationNumericId('task:b'));
    const clash = assignPlanIds(['task:b', 'task:a'], new Map([['task:a', notificationNumericId('task:b')]]));
    expect(clash.get('task:a')).toBe(notificationNumericId('task:b'));
    expect(clash.get('task:b')).toBe(notificationNumericId('task:b') + 1);
    expect(assignPlanIds(['task:a'], new Map([['task:a', 1]])).get('task:a')).toBe(a);
    expect(new Set(clash.values()).size).toBe(2);
  });
});

describe('pont iOS : format des commandes du plugin', () => {
  it('appelle plugin:notification|show, cancel (liste), get_pending, is_permission_granted et request_permission', async () => {
    const calls: { command: string; args?: Record<string, unknown> | undefined }[] = [];
    const answers: Record<string, unknown> = {
      'plugin:notification|get_pending': [{ id: 70_000, title: 'T', body: 'B' }, { id: 'x' }, null],
      'plugin:notification|is_permission_granted': null,
      'plugin:notification|request_permission': 'prompt',
    };
    const bridge = createIosNotificationBridge((command, args) => {
      calls.push({ command, args });
      return Promise.resolve(answers[command]);
    });
    await bridge.show({ id: 70_000, title: 'T', body: 'B', sound: 'default', extra: { sid: 'x' }, schedule: { at: { date: '2026-10-09T09:00:00.000Z', repeating: false, allowWhileIdle: false } } });
    await bridge.cancel([70_000, 70_001]);
    expect(await bridge.pending()).toEqual([{ id: 70_000, title: 'T', body: 'B' }]);
    expect(await bridge.permission()).toBe('undetermined');
    expect(await bridge.requestPermission()).toBe('undetermined');
    answers['plugin:notification|is_permission_granted'] = true;
    expect(await bridge.permission()).toBe('granted');
    answers['plugin:notification|is_permission_granted'] = false;
    expect(await bridge.permission()).toBe('denied');
    answers['plugin:notification|request_permission'] = 'granted';
    expect(await bridge.requestPermission()).toBe('granted');
    expect(calls.map((call) => call.command)).toEqual([
      'plugin:notification|show',
      'plugin:notification|cancel',
      'plugin:notification|get_pending',
      'plugin:notification|is_permission_granted',
      'plugin:notification|request_permission',
      'plugin:notification|is_permission_granted',
      'plugin:notification|is_permission_granted',
      'plugin:notification|request_permission',
    ]);
    expect(calls[1]?.args).toEqual({ notifications: [70_000, 70_001] });
    expect(calls[0]?.args).toMatchObject({ id: 70_000, sound: 'default' });
  });

  it('plugin absent ou commande refusée par la capability : unavailable ; autre erreur : erreur simple', async () => {
    for (const message of ['Command show not allowed by ACL', 'plugin notification not found', 'unknown command']) {
      const bridge = createIosNotificationBridge(() => Promise.reject(new Error(message)));
      await expect(bridge.permission()).rejects.toMatchObject({ reason: 'unavailable' });
    }
    const failing = createIosNotificationBridge(() => Promise.reject(new Error('pastScheduledTime')));
    const error = await failing.show({ id: 1, title: 'T', body: 'B', sound: 'default', extra: {}, schedule: { at: { date: 'x', repeating: false, allowWhileIdle: false } } }).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(NotificationSchedulerError);
    expect((error as Error).message).toBe('pastScheduledTime');
  });
});
