import type { Clock } from '../domain/clock';
import type { HlcClock } from '../domain/hlc';
import type { SyncDevicePlatform } from '../domain/sync/format';
import type { DeviceId } from '../domain/types';
import type { DataAccess } from '../db/repositories';
import type { SyncPlatform } from '../platform/sync/types';
import type { CycleDeadline } from './deadline';
import type { SyncLogger } from './log';

/** Dépendances du moteur de synchro (injectées : base, plateforme, horloges, identité, journal). */
export interface SyncDeps {
  readonly data: DataAccess;
  readonly platform: SyncPlatform;
  readonly hlc: HlcClock;
  /** Horloge physique (dérive, âges, 180 jours) : la même que celle de `HlcClock`. */
  readonly clock: Clock;
  readonly deviceId: DeviceId;
  readonly devicePlatform: SyncDevicePlatform;
  readonly appVersion: string;
  /** `schema_version` local = numéro de la dernière migration. */
  readonly sv: number;
  readonly logger: SyncLogger;
  /** ADR 0011 §22 point 6 : échéance du cycle `hide` de l'iPhone (comparée avant chaque unité atomique) ; absente : cycle non borné. */
  readonly deadline?: CycleDeadline;
}
