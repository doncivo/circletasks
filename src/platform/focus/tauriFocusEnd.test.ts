import { describe, expect, it } from 'vitest';
import type { NotificationLedgerV1 } from '../../domain/notificationLedger';
import { createLedgerStore } from '../notifications/notificationLedger';
import type { IosNotificationBridge, PendingItem, ShowPayload } from '../notifications/tauriNotifications';
import { NotificationSchedulerError, type NotificationPermission } from '../notifications/types';
import { createTauriFocusEndScheduler, FOCUS_END_NUMERIC_ID } from './tauriFocusEnd';
import { openFocusEndScheduler } from './index';

const NOW = Date.UTC(2026, 9, 8, 10, 0, 0); // 12:00 à Paris

function setup() {
  const pending = new Map<number, PendingItem>();
  const shown: ShowPayload[] = [];
  const cancels: number[][] = [];
  const state = { permission: 'granted' as NotificationPermission | 'unavailable', failShow: false, failCancel: false, drop: false, now: NOW, ledgerFails: false };
  const bridge: IosNotificationBridge = {
    show: (payload) => {
      if (state.failShow) return Promise.reject(new Error('refusé'));
      shown.push(payload);
      if (!state.drop) pending.set(payload.id, { id: payload.id, title: payload.title, body: payload.body });
      return Promise.resolve();
    },
    cancel: (ids) => {
      cancels.push([...ids]);
      if (state.failCancel) return Promise.reject(new Error('refusé'));
      for (const id of ids) pending.delete(id);
      return Promise.resolve();
    },
    pending: () => Promise.resolve([...pending.values()]),
    permission: () => (state.permission === 'unavailable' ? Promise.reject(new NotificationSchedulerError('unavailable')) : Promise.resolve(state.permission)),
    requestPermission: () => Promise.resolve('granted'),
  };
  let ledger: NotificationLedgerV1 | null = null;
  const store = createLedgerStore({
    load: () => Promise.resolve(ledger === null ? { state: 'missing' } : { state: 'valid', ledger }),
    save: (next) => {
      if (state.ledgerFails) return Promise.reject(new Error('écriture impossible'));
      ledger = next;
      return Promise.resolve();
    },
  });
  const scheduler = createTauriFocusEndScheduler({
    bridge,
    ledger: store,
    clock: { nowMs: () => state.now, zone: () => 'Europe/Paris' },
    compose: (title, minutes) => ({ title: `Session terminée · ${String(minutes)} min`, body: title }),
  });
  return { scheduler, pending, shown, cancels, state, ledger: () => ledger, store };
}

/** F-04 critères 11 à 16 : notification de fin de session, identifiant réservé 1. */
describe('notification de fin de Focus, adaptateur iOS (F-04 critères 11 et 12)', () => {
  const END = new Date(NOW + 25 * 60_000); // 12:25 à Paris

  it('schedule : identifiant numérique 1, heure murale du fuseau courant (constat 7), pas de catégorie, son, texte composé', async () => {
    const { scheduler, shown, pending } = setup();
    await scheduler.schedule('s1', END, 'Envoyer la facture', 25);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toMatchObject({
      id: FOCUS_END_NUMERIC_ID,
      title: 'Session terminée · 25 min',
      body: 'Envoyer la facture',
      sound: 'default',
      extra: { sid: 'focus:s1' },
      schedule: { at: { date: '2026-10-08T12:25:00.000Z', repeating: false } },
    });
    expect(shown[0]).not.toHaveProperty('actionTypeId');
    expect([...pending.keys()]).toEqual([1]);
  });

  it('schedule remplace l’identifiant 1 (pause puis reprise : une seule notification, au nouveau terme)', async () => {
    const { scheduler, shown, pending } = setup();
    await scheduler.schedule('s1', END, 'T', 25);
    await scheduler.cancel('s1');
    expect(pending.size).toBe(0);
    await scheduler.schedule('s1', new Date(NOW + 30 * 60_000), 'T', 25);
    await scheduler.schedule('s1', new Date(NOW + 35 * 60_000), 'T', 25);
    expect(pending.size).toBe(1);
    expect(shown.map((payload) => payload.schedule.at.date)).toEqual(['2026-10-08T12:25:00.000Z', '2026-10-08T12:30:00.000Z', '2026-10-08T12:35:00.000Z']);
  });

  it('cancel(sessionId) ne retire que la notification de CETTE session', async () => {
    const { scheduler, pending, cancels } = setup();
    await scheduler.schedule('s1', END, 'T', 25);
    await scheduler.cancel('autre-session');
    expect(pending.size).toBe(1);
    expect(cancels).toEqual([]);
    await scheduler.cancel('s1');
    expect(pending.size).toBe(0);
    expect(cancels).toEqual([[1]]);
    await scheduler.cancel('s1');
    expect(cancels).toHaveLength(1);
  });

  it('une session plus récente a pris la place : l’annulation de l’ancienne est sans effet', async () => {
    const { scheduler, pending } = setup();
    await scheduler.schedule('s1', END, 'T', 25);
    await scheduler.schedule('s2', new Date(NOW + 40 * 60_000), 'T', 40);
    await scheduler.cancel('s1');
    expect(pending.size).toBe(1);
  });

  it('un fireAt déjà passé (ou dans la marge) n’est pas envoyé et retire la notification précédente', async () => {
    const { scheduler, shown, pending } = setup();
    await scheduler.schedule('s1', END, 'T', 25);
    await scheduler.schedule('s1', new Date(NOW - 60_000), 'T', 25);
    expect(shown).toHaveLength(1);
    expect(pending.size).toBe(0);
  });

  it('ne touche jamais une notification du plan (identifiants à partir de 65 536)', async () => {
    const { scheduler, pending, cancels } = setup();
    pending.set(70_000, { id: 70_000, title: 'Rappel', body: 'x' });
    await scheduler.schedule('s1', END, 'T', 25);
    await scheduler.cancel('s1');
    expect([...pending.keys()]).toEqual([70_000]);
    expect(cancels.flat()).toEqual([1]);
  });

  it('rejets typés : autorisation refusée, moteur indisponible, envoi refusé, notification absente, registre non écrit', async () => {
    const t = setup();
    t.state.permission = 'denied';
    await expect(t.scheduler.schedule('s1', END, 'T', 25)).rejects.toMatchObject({ reason: 'permission-denied' });
    t.state.permission = 'undetermined';
    await expect(t.scheduler.schedule('s1', END, 'T', 25)).rejects.toMatchObject({ reason: 'permission-denied' });
    t.state.permission = 'unavailable';
    await expect(t.scheduler.schedule('s1', END, 'T', 25)).rejects.toMatchObject({ reason: 'unavailable' });
    t.state.permission = 'granted';
    t.state.failShow = true;
    await expect(t.scheduler.schedule('s1', END, 'T', 25)).rejects.toMatchObject({ reason: 'schedule-failed' });
    t.state.failShow = false;
    t.state.drop = true;
    await expect(t.scheduler.schedule('s1', END, 'T', 25)).rejects.toMatchObject({ reason: 'verify-failed' });
    t.state.drop = false;
    t.state.ledgerFails = true;
    await expect(t.scheduler.schedule('s1', END, 'T', 25)).rejects.toMatchObject({ reason: 'ledger-failed' });
    t.state.ledgerFails = false;
    await t.scheduler.schedule('s1', END, 'T', 25);
    t.state.failCancel = true;
    await expect(t.scheduler.cancel('s1')).rejects.toMatchObject({ reason: 'schedule-failed' });
  });

  it('la fin de Focus écrite dans le registre survit à une mise à jour du plan (même registre partagé)', async () => {
    const t = setup();
    await t.scheduler.schedule('s1', END, 'T', 25);
    await t.store.update((current) => ({ ...current, zone: 'Europe/Paris', entries: [] }));
    expect(t.ledger()?.focusEnd).toEqual({ sessionId: 's1', at: END.getTime() });
  });
});

describe('résolveur de la fin de Focus (F-04 critère 11)', () => {
  const deps = {
    ledger: createLedgerStore({ load: () => Promise.resolve({ state: 'missing' as const }), save: () => Promise.resolve() }),
    clock: { nowMs: () => NOW, zone: () => 'Europe/Paris' },
    compose: () => ({ title: 'x', body: 'y' }),
  };

  it.each([
    ['tauri', 'windows'],
    ['web', 'ios'],
    ['web', 'windows'],
    ['tauri', 'other'],
  ] as const)('(%s, %s) : implémentation vide, aucun envoi', async (runtime, os) => {
    const scheduler = openFocusEndScheduler(runtime, os, deps);
    await expect(scheduler.schedule('s', new Date(NOW + 60_000_000), 'T', 25)).resolves.toBeUndefined();
    await expect(scheduler.cancel('s')).resolves.toBeUndefined();
  });
});
