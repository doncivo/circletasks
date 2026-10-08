import type { IsoDateTime } from '../../domain/types';
import { NotificationSchedulerError } from '../notifications/types';
import type { SigningAlert, SigningAlertRequest, SigningRead, SigningSource } from './types';

/** Faux pour les tests et les e2e (jamais importé par le code de l'app hors résolveur de développement). */
export interface FakeSigningSource extends SigningSource {
  /** Nombre de lectures faites. */
  reads: number;
  /** Prochaines lectures : la dernière valeur se répète. */
  set(...results: SigningRead[]): void;
  /** Expiration réussie à `expiresAt` (ISO) ; `issuedAt` facultatif. */
  expireAt(expiresAt: string, issuedAt?: string | null): void;
  fail(code: 'profile-missing' | 'profile-unreadable' | 'unavailable'): void;
}

export function createFakeSigningSource(supported = true): FakeSigningSource {
  let queue: SigningRead[] = [{ ok: false, code: 'profile-missing' }];
  const source: FakeSigningSource = {
    supported,
    reads: 0,
    set: (...results) => {
      queue = results.length > 0 ? [...results] : queue;
    },
    expireAt: (expiresAt, issuedAt = null) => source.set({ ok: true, expiresAt: expiresAt as IsoDateTime, issuedAt: issuedAt as IsoDateTime | null }),
    fail: (code) => source.set({ ok: false, code }),
    read: () => {
      source.reads += 1;
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return Promise.resolve(next ?? { ok: false, code: 'unavailable' });
    },
  };
  return source;
}

export interface FakeSigningAlert extends SigningAlert {
  readonly scheduled: SigningAlertRequest[];
  cancels: number;
  /** Alerte en attente chez « iOS ». */
  pending: SigningAlertRequest | null;
  failSchedule: boolean;
  failCancel: boolean;
  failPending: boolean;
  /** `schedule` réussit mais iOS ne garde rien. */
  dropOnSchedule: boolean;
}

export function createFakeSigningAlert(): FakeSigningAlert {
  const alert: FakeSigningAlert = {
    scheduled: [],
    cancels: 0,
    pending: null,
    failSchedule: false,
    failCancel: false,
    failPending: false,
    dropOnSchedule: false,
    schedule: (request) => {
      if (alert.failSchedule) return Promise.reject(new NotificationSchedulerError('schedule-failed'));
      alert.scheduled.push(request);
      if (!alert.dropOnSchedule) alert.pending = request;
      return Promise.resolve();
    },
    cancel: () => {
      if (alert.failCancel) return Promise.reject(new NotificationSchedulerError('schedule-failed'));
      alert.cancels += 1;
      alert.pending = null;
      return Promise.resolve();
    },
    isPending: () => (alert.failPending ? Promise.reject(new NotificationSchedulerError('verify-failed')) : Promise.resolve(alert.pending !== null)),
  };
  return alert;
}
