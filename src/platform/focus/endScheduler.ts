import type { FocusEndScheduler } from './types';

/**
 * Implémentation vide du planificateur de fin de session (F-04 critère 8) : l'envoi réel d'une notification locale sur l'iPhone est de
 * l'ordre 5 (plugin Swift : I-05, N-01, N-03, N-05). Le PC n'émet jamais de notification (PRD section 7) : il garde aussi cette
 * implémentation et ne joue que le son de fin.
 */
export function createNoopFocusEndScheduler(): FocusEndScheduler {
  return {
    schedule: () => Promise.resolve(),
    cancel: () => Promise.resolve(),
  };
}

/** Appel enregistré par le faux planificateur. */
export type FakeSchedulerCall = { readonly type: 'schedule'; readonly sessionId: string; readonly fireAt: Date; readonly title: string } | { readonly type: 'cancel'; readonly sessionId: string };

/** Faux testé (F-04 critère 9) : enregistre les appels et sait quelle notification est planifiée par session. */
export interface FakeFocusEndScheduler extends FocusEndScheduler {
  readonly calls: FakeSchedulerCall[];
  /** Notifications actuellement planifiées : session -> échéance et titre. */
  pending(): ReadonlyMap<string, { readonly fireAt: Date; readonly title: string }>;
}

export function createFakeFocusEndScheduler(): FakeFocusEndScheduler {
  const calls: FakeSchedulerCall[] = [];
  const pending = new Map<string, { readonly fireAt: Date; readonly title: string }>();
  return {
    calls,
    pending: () => pending,
    schedule: (sessionId, fireAt, title) => {
      calls.push({ type: 'schedule', sessionId, fireAt, title });
      pending.set(sessionId, { fireAt, title });
      return Promise.resolve();
    },
    cancel: (sessionId) => {
      calls.push({ type: 'cancel', sessionId });
      pending.delete(sessionId);
      return Promise.resolve();
    },
  };
}
