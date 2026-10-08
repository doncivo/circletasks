import { describe, expect, it, vi } from 'vitest';
import type { RawNotificationAction } from '../../domain/notificationActions';
import { NotificationActionSourceError, type ActionTypeSpec } from './actions';
import { createFakeNotificationActionSource } from './fakeActions';
import { openNotificationActionSource } from './index';
import { createTauriNotificationActionSource, parseDrain } from './tauriNotificationActions';

/**
 * Source des actions de notification (N-03, avenant N3.2) : adaptateur du plugin Swift (faux `invoke`), faux testé (fichier natif en
 * mémoire) et résolveur (jamais de source sur le PC).
 */
const LINE = { n: 70001, a: 'done', t: 1_760_000_000_000, sid: 'task:r1', at: 1_759_999_940_000 };
const action = (over: Partial<RawNotificationAction> = {}): RawNotificationAction => ({ numericId: 70001, actionId: 'done', receivedAtMs: 1_760_000_000_000, sid: 'task:r1', deliveredAt: 1_759_999_940_000, ...over });
const SPEC: ActionTypeSpec = { id: 'ct.task', actions: [{ id: 'done', title: 'Fait', foreground: true }] };

describe('adaptateur du plugin (faux invoke)', () => {
  it('drain : analyse stricte des lignes, commande plugin:notification-actions|drain', async () => {
    const call = vi.fn().mockResolvedValue({ entries: [LINE, { ...LINE, sid: null, at: null }], lines: 2, unreadable: 0, writeFailures: 0 });
    const drain = await createTauriNotificationActionSource(call).drain();
    expect(call).toHaveBeenCalledWith('plugin:notification-actions|drain', undefined);
    expect(drain.entries).toEqual([action(), action({ sid: null, deliveredAt: null })]);
    expect(drain.lines).toBe(2);
  });

  it('une ligne mal formée rendue par le natif compte comme illisible, jamais comme une action', () => {
    const drain = parseDrain({ entries: [LINE, { ...LINE, a: 'delete' }, { ...LINE, t: 'x' }, 'x'], lines: 4, unreadable: 1, writeFailures: 2 });
    expect(drain.entries).toHaveLength(1);
    expect(drain.unreadable).toBe(4);
    expect(drain.writeFailures).toBe(2);
  });

  it.each([null, 'x', {}, { entries: [], lines: -1, unreadable: 0, writeFailures: 0 }, { entries: [], lines: 0, unreadable: 0 }])('réponse inattendue de drain : %j', (value) => {
    expect(() => parseDrain(value)).toThrow(NotificationActionSourceError);
  });

  it('ack : nombre de lignes physiques et compteur d’écritures impossibles', async () => {
    const call = vi.fn().mockResolvedValue({ removed: 3 });
    await createTauriNotificationActionSource(call).ack({ lines: 3, writeFailures: 1 });
    expect(call).toHaveBeenCalledWith('plugin:notification-actions|ack', { count: 3, writeFailures: 1 });
  });

  it('registerActionTypes : catégories et titres tels que fournis, au premier plan', async () => {
    const call = vi.fn().mockResolvedValue({ registered: 1 });
    await createTauriNotificationActionSource(call).registerActionTypes([SPEC]);
    expect(call).toHaveBeenCalledWith('plugin:notification-actions|register_action_types', { types: [{ id: 'ct.task', actions: [{ id: 'done', title: 'Fait', foreground: true }] }] });
  });

  it('status : délégué et catégories, sinon réponse inattendue', async () => {
    expect(await createTauriNotificationActionSource(vi.fn().mockResolvedValue({ delegate: true, delegateAtLaunch: true, categories: 3 })).status()).toEqual({ delegate: true, delegateAtLaunch: true, categories: 3 });
    await expect(createTauriNotificationActionSource(vi.fn().mockResolvedValue({ delegate: 'oui' })).status()).rejects.toMatchObject({ reason: 'bad-response' });
  });

  it('plugin absent ou commande refusée par la capability : unavailable ; autre rejet : rejected (jamais le message système)', async () => {
    const absent = createTauriNotificationActionSource(vi.fn().mockRejectedValue(new Error('plugin notification-actions not found')));
    await expect(absent.drain()).rejects.toMatchObject({ reason: 'unavailable' });
    const refused = createTauriNotificationActionSource(vi.fn().mockRejectedValue('io'));
    const error = await refused.drain().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotificationActionSourceError);
    expect((error as NotificationActionSourceError).reason).toBe('rejected');
    expect((error as Error).message).toBe('notification action source: rejected');
  });

  it('onWake : écoute l’événement `action` du plugin et rend le désabonnement', async () => {
    const stop = vi.fn();
    const listen = vi.fn().mockResolvedValue(stop);
    const handler = vi.fn();
    const unsubscribe = await createTauriNotificationActionSource(vi.fn(), listen).onWake(handler);
    expect(listen).toHaveBeenCalledWith('action', handler);
    unsubscribe();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe('faux de la source (fichier natif en mémoire)', () => {
  it('push écrit une ligne et réveille ; drain la rend sans l’effacer ; ack la retire', async () => {
    const source = createFakeNotificationActionSource();
    const wake = vi.fn();
    await source.onWake(wake);
    source.push(action());
    source.push(action({ sid: 'task:r2' }), { wake: false });
    expect(wake).toHaveBeenCalledTimes(1);
    const first = await source.drain();
    expect(first.entries).toHaveLength(2);
    expect((await source.drain()).entries).toHaveLength(2);
    await source.ack({ lines: first.lines, writeFailures: 0 });
    expect((await source.drain()).entries).toEqual([]);
  });

  it('ack retire les lignes lues, pas celles arrivées entre-temps', async () => {
    const source = createFakeNotificationActionSource();
    source.push(action());
    const seen = await source.drain();
    source.push(action({ sid: 'task:r2' }));
    await source.ack({ lines: seen.lines, writeFailures: 0 });
    expect((await source.drain()).entries.map((entry) => entry.sid)).toEqual(['task:r2']);
  });

  it('lignes illisibles et écritures impossibles : comptées, retirées à l’acquittement', async () => {
    const source = createFakeNotificationActionSource();
    source.addUnreadable(2);
    source.addWriteFailures(1);
    source.push(action());
    const drain = await source.drain();
    expect(drain).toMatchObject({ lines: 3, unreadable: 2, writeFailures: 1 });
    await source.ack({ lines: drain.lines, writeFailures: drain.writeFailures });
    expect(await source.drain()).toMatchObject({ lines: 0, unreadable: 0, writeFailures: 0 });
  });

  it('une panne injectée touche une seule commande', async () => {
    const source = createFakeNotificationActionSource();
    source.failNext('drain');
    await expect(source.drain()).rejects.toBeInstanceOf(NotificationActionSourceError);
    await expect(source.drain()).resolves.toMatchObject({ lines: 0 });
    source.setDelegate(false);
    expect(await source.status()).toEqual({ delegate: false, delegateAtLaunch: true, categories: 0 });
  });
});

describe('résolveur', () => {
  it('le PC et le navigateur n’ont aucune source d’actions', () => {
    expect(openNotificationActionSource('tauri', 'windows')).toBeNull();
    expect(openNotificationActionSource('web', 'other')).toBeNull();
    expect(openNotificationActionSource('tauri', 'other')).toBeNull();
  });

  it('l’iPhone installé a la source du plugin (chargée à la demande)', () => {
    expect(openNotificationActionSource('tauri', 'ios')).not.toBeNull();
  });
});
