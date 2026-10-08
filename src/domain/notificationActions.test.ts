import { describe, expect, it } from 'vitest';
import {
  ACTION_APPLIED_TTL_MS,
  ACTION_QUEUE_MAX_APPLIED,
  ACTION_QUEUE_MAX_ENTRIES,
  ACTION_QUEUE_MAX_SNOOZES,
  actionKey,
  dismissQueueTrouble,
  EMPTY_ACTION_QUEUE,
  enqueueActions,
  hasQueueTrouble,
  originOf,
  parseActionQueue,
  parseActionTarget,
  snoozeFireAt,
  snoozeNotificationId,
  trimApplied,
  upsertSnooze,
  type NotificationActionQueueV1,
  type RawNotificationAction,
} from './notificationActions';
import { asLocalDate, asLocalDateTime } from './types';

const NOW = Date.parse('2026-10-08T08:00:00.000Z'); // 10:00 à Paris
const raw = (over: Partial<RawNotificationAction> = {}): RawNotificationAction => ({
  numericId: 70001,
  actionId: 'done',
  receivedAtMs: NOW,
  sid: 'task:r1',
  deliveredAt: NOW - 60_000,
  ...over,
});

describe('clé d’idempotence (N-03 critère 5)', () => {
  it('identifiant stable + action + instant de la notification livrée', () => {
    expect(actionKey(raw())).toBe(`task:r1|done|${String(NOW - 60_000)}`);
  });

  it('sans identifiant stable : l’identifiant numérique ; sans instant livré : l’instant de la réponse', () => {
    expect(actionKey(raw({ sid: null, deliveredAt: null }))).toBe(`n:70001|done|${String(NOW)}`);
  });

  it('la même notification avec deux actions, ou deux jours d’un même rappel, donne des clés différentes', () => {
    expect(actionKey(raw({ actionId: 'snooze15' }))).not.toBe(actionKey(raw()));
    expect(actionKey(raw({ deliveredAt: NOW - 86_400_000 }))).not.toBe(actionKey(raw()));
  });
});

describe('file durable : entrée, doublons, plafonds (N-03 critères 2, 5 et 8)', () => {
  it('une action nouvelle est inscrite, la même action reçue deux fois ne l’est qu’une fois', () => {
    const first = enqueueActions(EMPTY_ACTION_QUEUE, [raw(), raw()], 0, NOW);
    expect(first.added).toBe(1);
    expect(first.duplicates).toBe(1);
    expect(first.queue.entries).toHaveLength(1);
    expect(first.queue.entries[0]).toMatchObject({ sid: 'task:r1', action: 'done', tries: 0, lastError: null });
    const again = enqueueActions(first.queue, [raw()], 0, NOW);
    expect(again.added).toBe(0);
    expect(again.queue.entries).toHaveLength(1);
  });

  it('une action déjà appliquée (clé dans `applied`) est écartée : relecture après un arrêt', () => {
    const applied: NotificationActionQueueV1 = { ...EMPTY_ACTION_QUEUE, applied: [{ key: actionKey(raw()), at: NOW }] };
    const result = enqueueActions(applied, [raw()], 0, NOW);
    expect(result.added).toBe(0);
    expect(result.duplicates).toBe(1);
    expect(result.queue.entries).toEqual([]);
  });

  it('ordre d’application : instant de réception, puis clé', () => {
    const queue = enqueueActions(EMPTY_ACTION_QUEUE, [raw({ sid: 'task:b', receivedAtMs: NOW + 5 }), raw({ sid: 'task:z', receivedAtMs: NOW }), raw({ sid: 'task:a', receivedAtMs: NOW })], 0, NOW).queue;
    expect(queue.entries.map((entry) => entry.sid)).toEqual(['task:a', 'task:z', 'task:b']);
  });

  it('file pleine : la plus ancienne est écartée et `dropped` augmente (visible)', () => {
    const many = Array.from({ length: ACTION_QUEUE_MAX_ENTRIES + 3 }, (_, index) => raw({ sid: `task:r${String(index)}`, receivedAtMs: NOW + index, deliveredAt: null }));
    const result = enqueueActions(EMPTY_ACTION_QUEUE, many, 0, NOW);
    expect(result.queue.entries).toHaveLength(ACTION_QUEUE_MAX_ENTRIES);
    expect(result.queue.dropped).toBe(3);
    expect(result.queue.entries[0]?.sid).toBe('task:r3');
    expect(hasQueueTrouble(result.queue)).toBe(true);
  });

  it('les lignes perdues côté natif s’ajoutent à `lost`', () => {
    const result = enqueueActions({ ...EMPTY_ACTION_QUEUE, lost: 1 }, [], 2, NOW);
    expect(result.queue.lost).toBe(3);
  });

  it('`applied` est purgée au-delà de 30 jours et de 200 clés', () => {
    const old = { key: 'old', at: NOW - ACTION_APPLIED_TTL_MS - 1 };
    const many = Array.from({ length: ACTION_QUEUE_MAX_APPLIED + 5 }, (_, index) => ({ key: `k${String(index)}`, at: NOW - index }));
    const trimmed = trimApplied([old, ...many], NOW);
    expect(trimmed.some((item) => item.key === 'old')).toBe(false);
    expect(trimmed).toHaveLength(ACTION_QUEUE_MAX_APPLIED);
  });

  it('« Ignorer » retire les entrées en échec et remet les compteurs à zéro, garde les autres', () => {
    const queue: NotificationActionQueueV1 = {
      ...EMPTY_ACTION_QUEUE,
      dropped: 2,
      lost: 1,
      entries: [
        { key: 'a', sid: 'task:a', numericId: 1, action: 'done', receivedAt: 1, tries: 2, lastError: 'target-not-found' },
        { key: 'b', sid: 'task:b', numericId: 2, action: 'done', receivedAt: 2, tries: 0, lastError: null },
      ],
    };
    const cleared = dismissQueueTrouble(queue);
    expect(cleared.entries.map((entry) => entry.key)).toEqual(['b']);
    expect(cleared.dropped).toBe(0);
    expect(cleared.lost).toBe(0);
    expect(hasQueueTrouble(cleared)).toBe(false);
  });
});

describe('lecture stricte de la file', () => {
  it('jamais écrite = vide valide', () => {
    expect(parseActionQueue(null)).toEqual({ state: 'valid', queue: EMPTY_ACTION_QUEUE });
    expect(parseActionQueue(undefined)).toEqual({ state: 'valid', queue: EMPTY_ACTION_QUEUE });
  });

  it('une file écrite se relit à l’identique', () => {
    const queue = enqueueActions(EMPTY_ACTION_QUEUE, [raw()], 0, NOW).queue;
    const withSnooze = { ...queue, snoozes: upsertSnooze([], 'task:r1', asLocalDateTime('2026-10-08T10:15')) };
    expect(parseActionQueue(JSON.parse(JSON.stringify(withSnooze)) as unknown)).toEqual({ state: 'valid', queue: withSnooze });
  });

  it.each([
    ['version inconnue', { ...EMPTY_ACTION_QUEUE, v: 2 }],
    ['entrées absentes', { v: 1, applied: [], snoozes: [], dropped: 0, lost: 0 }],
    ['compteur négatif', { ...EMPTY_ACTION_QUEUE, dropped: -1 }],
    ['action inconnue', { ...EMPTY_ACTION_QUEUE, entries: [{ key: 'a', sid: null, numericId: 1, action: 'delete', receivedAt: 1, tries: 0, lastError: null }] }],
    ['erreur inconnue', { ...EMPTY_ACTION_QUEUE, entries: [{ key: 'a', sid: null, numericId: 1, action: 'done', receivedAt: 1, tries: 0, lastError: 'boom' }] }],
    ['répétition sans échéance valide', { ...EMPTY_ACTION_QUEUE, snoozes: [{ id: 'snooze:task:a', originId: 'task:a', fireAt: 'demain' }] }],
    ['texte', 'x'],
  ])('illisible : %s', (_label, value) => {
    expect(parseActionQueue(value)).toEqual({ state: 'unreadable' });
  });
});

describe('cible d’une action (identifiants de l’ADR 0012 §3.1)', () => {
  it('tâche, routine et événement', () => {
    expect(parseActionTarget('task:r1')).toEqual({ kind: 'task', reminderId: 'r1' });
    expect(parseActionTarget('routine:r2:2026-10-08')).toEqual({ kind: 'routine', reminderId: 'r2', date: asLocalDate('2026-10-08') });
    expect(parseActionTarget('event:r3:2027-03-12')).toEqual({ kind: 'event', reminderId: 'r3', date: asLocalDate('2027-03-12') });
  });

  it('une répétition se résout sur son origine, même répétée', () => {
    expect(parseActionTarget('snooze:task:r1')).toEqual({ kind: 'task', reminderId: 'r1' });
    expect(parseActionTarget('snooze:snooze:routine:r2:2026-10-08')).toEqual({ kind: 'routine', reminderId: 'r2', date: asLocalDate('2026-10-08') });
    expect(originOf('snooze:snooze:task:r1')).toBe('task:r1');
    expect(snoozeNotificationId('snooze:task:r1')).toBe('snooze:task:r1');
  });

  it('récapitulatif et fin de Focus : aucune action', () => {
    expect(parseActionTarget('recap:evening:2026-10-08')).toEqual({ kind: 'none' });
    expect(parseActionTarget('focus:abc')).toEqual({ kind: 'none' });
  });

  it.each(['', 'task', 'task:', 'routine:r2', 'routine:r2:hier', 'event:r3', 'autre:x'])('format inconnu : %j', (sid) => {
    expect(parseActionTarget(sid)).toBeNull();
  });
});

describe('« +15 min » : échéance et répétitions (N-03 critère 6)', () => {
  it('réception + 15 min, arrondie à la minute SUIVANTE (jamais plus tôt), en heure locale', () => {
    const received = Date.parse('2026-10-08T08:00:30.000Z'); // 10:00:30 à Paris
    expect(snoozeFireAt(received, received + 1_000, 'Europe/Paris')).toBe('2026-10-08T10:16');
    expect(snoozeFireAt(NOW, NOW + 1_000, 'Europe/Paris')).toBe('2026-10-08T10:15');
  });

  it('appliquée longtemps après : maintenant + 2 min, jamais une action perdue', () => {
    const late = NOW + 3_600_000;
    expect(snoozeFireAt(NOW, late, 'Europe/Paris')).toBe('2026-10-08T11:02');
  });

  it('suit le fuseau passé en argument', () => {
    expect(snoozeFireAt(NOW, NOW + 1_000, 'America/New_York')).toBe('2026-10-08T04:15');
  });

  it('une seule répétition par origine : la seconde remplace la première', () => {
    const one = upsertSnooze([], 'task:r1', asLocalDateTime('2026-10-08T10:15'));
    const two = upsertSnooze(one, 'snooze:task:r1', asLocalDateTime('2026-10-08T10:30'));
    expect(two).toEqual([{ id: 'snooze:task:r1', originId: 'task:r1', fireAt: '2026-10-08T10:30' }]);
  });

  it('au plus 100 répétitions, les plus proches d’abord', () => {
    let snoozes = upsertSnooze([], 'task:far', asLocalDateTime('2027-01-01T10:00'));
    for (let index = 0; index < ACTION_QUEUE_MAX_SNOOZES; index += 1) {
      snoozes = upsertSnooze(snoozes, `task:r${String(index).padStart(3, '0')}`, asLocalDateTime('2026-10-08T10:15'));
    }
    expect(snoozes).toHaveLength(ACTION_QUEUE_MAX_SNOOZES);
    expect(snoozes.some((snooze) => snooze.originId === 'task:far')).toBe(false);
  });
});
