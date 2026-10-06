import { describe, expect, it } from 'vitest';
import type { DeviceSyncStatus, SyncPhase as PlatformSyncPhase } from '../platform/sync/types';
import type { DeviceState } from './sync/compat';
import {
  DEVICE_STATES,
  deviceTrouble,
  phaseBanner,
  SYNC_PHASES,
  SYNC_TROUBLE_ORDER,
  syncBannerFor,
  type PersistedSyncFacts,
  type PhaseBanner,
  type SyncBannerDevice,
  type SyncPhase,
} from './syncBanners';
import { asEntityId, type DeviceId } from './types';

const SELF = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000a1');
const PHONE = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000b2');
const LAPTOP = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000c3');

const device = (deviceId: DeviceId, status: DeviceState, self = false): SyncBannerDevice => ({ deviceId, self, status });
const NONE: PersistedSyncFacts = { join: null, devices: null };
const JOIN = { done: 1200, total: 5000, failure: 'io' };

/** Décision attendue de chaque phase (critère 9 b) : une ligne par phase, rien par défaut. */
const EXPECTED: { readonly [P in SyncPhase]: PhaseBanner } = {
  'not-configured': { kind: 'none', reason: 'not-configured' },
  'needs-pairing': { kind: 'trouble', code: 'needs-pairing' },
  idle: { kind: 'none', reason: 'normal' },
  syncing: { kind: 'syncing' },
  'waiting-icloud': { kind: 'waitingIcloud' },
  'restore-choice': { kind: 'trouble', code: 'restore-choice' },
  'update-required': { kind: 'none', reason: 'update-required' },
  'clock-ahead': { kind: 'trouble', code: 'clock-ahead' },
  'key-mismatch': { kind: 'trouble', code: 'key-mismatch' },
  error: { kind: 'trouble', code: 'error' },
};

describe('correspondance phase → bandeau (A-09 critère 9 b)', () => {
  it('SYNC_PHASES et SyncPhase de la plateforme sont la même union', () => {
    const forth: readonly PlatformSyncPhase[] = SYNC_PHASES;
    const back: readonly SyncPhase[] = forth;
    expect(back).toHaveLength(new Set(SYNC_PHASES).size);
  });

  it('chaque phase de la liste a une décision explicite, celle du tableau', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...SYNC_PHASES].sort());
    for (const phase of SYNC_PHASES) expect(phaseBanner(phase), phase).toEqual(EXPECTED[phase]);
  });

  it('une valeur hors liste est refusée (jamais « aucun bandeau » par défaut)', () => {
    expect(() => phaseBanner('forgotten' as SyncPhase)).toThrow(/non décidé/);
    expect(() => deviceTrouble('lost' as DeviceState)).toThrow(/non décidé/);
  });

  it('chaque statut d’appareil a une décision ; seuls foreign, corrupt et rollback sont des échecs', () => {
    const forth: readonly DeviceSyncStatus[] = DEVICE_STATES;
    const back: readonly DeviceState[] = forth;
    expect(back).toHaveLength(8);
    const troubles = DEVICE_STATES.filter((s) => deviceTrouble(s) !== null);
    expect(troubles).toEqual(['corrupt', 'foreign', 'rollback']);
  });

  it('chaque code d’échec a sa place dans l’ordre d’urgence, une seule fois', () => {
    expect(new Set(SYNC_TROUBLE_ORDER).size).toBe(SYNC_TROUBLE_ORDER.length);
    const phaseCodes = SYNC_PHASES.map(phaseBanner).flatMap((b) => (b.kind === 'trouble' ? [b.code] : []));
    const deviceCodes = DEVICE_STATES.map(deviceTrouble).filter((c) => c !== null);
    for (const code of [...phaseCodes, ...deviceCodes, 'join-failed' as const]) expect(SYNC_TROUBLE_ORDER).toContain(code);
  });
});

describe('syncBannerFor : phases (critères 9 c, 9 d, 9 e)', () => {
  it('phase en échec ou bloquée : un syncTrouble de son code ; idle, syncing, waiting-icloud, not-configured, update-required : aucun', () => {
    for (const phase of SYNC_PHASES) {
      const banners = syncBannerFor({ phase, devices: [] }, NONE);
      const expected = EXPECTED[phase];
      expect(banners.troubles, phase).toEqual(expected.kind === 'trouble' ? [{ code: expected.code }] : []);
      expect(banners.syncing, phase).toBe(phase === 'syncing');
      expect(banners.waitingIcloud !== null, phase).toBe(phase === 'waiting-icloud');
    }
  });

  it('« En attente d’iCloud » : cause quand errorCode l’explique, sinon aucune', () => {
    expect(syncBannerFor({ phase: 'waiting-icloud', errorCode: 'cloud-pending', devices: [] }, NONE).waitingIcloud).toEqual({ cause: 'cloud-pending' });
    expect(syncBannerFor({ phase: 'waiting-icloud', errorCode: 'cloud-provider-stopped', devices: [] }, NONE).waitingIcloud).toEqual({ cause: 'cloud-provider-stopped' });
    expect(syncBannerFor({ phase: 'waiting-icloud', errorCode: null, devices: [] }, NONE).waitingIcloud).toEqual({ cause: null });
    expect(syncBannerFor({ phase: 'waiting-icloud', devices: [] }, NONE).waitingIcloud).toEqual({ cause: null });
  });

  it('pendant un cycle, l’échec de la phase précédente reste jusqu’à la conclusion du cycle (pas de clignotement)', () => {
    const settled = { phase: 'error' as const, devices: [] };
    const during = syncBannerFor({ phase: 'syncing', devices: [] }, NONE, settled);
    expect(during.troubles).toEqual([{ code: 'error' }]);
    expect(during.syncing).toBe(true);
    // Le cycle conclut « à jour » : l'échec est résolu.
    expect(syncBannerFor({ phase: 'idle', devices: [] }, NONE, { phase: 'idle', devices: [] }).troubles).toEqual([]);
    // Sans état précédent connu : rien d'inventé.
    expect(syncBannerFor({ phase: 'syncing', devices: [] }, NONE, null).troubles).toEqual([]);
  });
});

describe('syncBannerFor : états persistés et appareils (critère 9 f)', () => {
  it('arrivée en échec : bandeau quelle que soit la phase, même avant le premier cycle', () => {
    for (const phase of SYNC_PHASES) {
      const codes = syncBannerFor({ phase, devices: [] }, { join: JOIN, devices: null }).troubles.map((t) => t.code);
      expect(codes, phase).toContain('join-failed');
    }
    expect(syncBannerFor({ phase: 'not-configured', devices: [] }, { join: JOIN, devices: [] }).troubles).toEqual([{ code: 'join-failed', join: JOIN }]);
  });

  it('appareils foreign, corrupt, rollback : un bandeau par appareil, avec l’appareil pour le nommer', () => {
    const devices = [device(SELF, 'active', true), device(PHONE, 'corrupt'), device(LAPTOP, 'rollback')];
    const banners = syncBannerFor({ phase: 'idle', devices }, NONE);
    expect(banners.troubles).toEqual([
      { code: 'device-corrupt', device: devices[1] },
      { code: 'device-rollback', device: devices[2] },
    ]);
    expect(banners.devices).toBe(devices);
    const foreign = [device(SELF, 'active', true), device(PHONE, 'foreign'), device(LAPTOP, 'active')];
    expect(syncBannerFor({ phase: 'idle', devices: foreign }, NONE).troubles).toEqual([{ code: 'device-foreign', device: foreign[1] }]);
  });

  it('soi-même et les statuts normaux ne produisent rien', () => {
    const devices = [device(SELF, 'corrupt', true), device(PHONE, 'active'), device(LAPTOP, 'expired')];
    expect(syncBannerFor({ phase: 'idle', devices }, NONE).troubles).toEqual([]);
  });

  it('clé différente : un seul état, jamais « Clé différente » de chaque appareil en plus', () => {
    const devices = [device(SELF, 'active', true), device(PHONE, 'foreign'), device(LAPTOP, 'foreign')];
    expect(syncBannerFor({ phase: 'key-mismatch', devices }, NONE).troubles).toEqual([{ code: 'key-mismatch' }]);
  });

  it('avant le premier cycle : appareils lus dans la base (même règle de clé différente que le moteur)', () => {
    const stored = [device(SELF, 'active', true), device(PHONE, 'foreign')];
    expect(syncBannerFor({ phase: 'not-configured', devices: [] }, { join: null, devices: stored }).troubles).toEqual([{ code: 'key-mismatch' }]);
    const mixed = [device(SELF, 'active', true), device(PHONE, 'foreign'), device(LAPTOP, 'active')];
    const banners = syncBannerFor({ phase: 'not-configured', devices: [] }, { join: null, devices: mixed });
    expect(banners.troubles).toEqual([{ code: 'device-foreign', device: mixed[1] }]);
    expect(banners.devices).toBe(mixed);
    // Seul : aucun autre appareil, aucune clé différente.
    expect(syncBannerFor({ phase: 'not-configured', devices: [] }, { join: null, devices: [device(SELF, 'active', true)] }).troubles).toEqual([]);
  });
});

describe('un seul bandeau, le plus urgent (critère 9 g, D4)', () => {
  it('ordre fixe, quel que soit l’ordre des appareils', () => {
    const devices = [device(SELF, 'active', true), device(LAPTOP, 'rollback'), device(PHONE, 'foreign')];
    const reversed = [devices[0], devices[2], devices[1]] as SyncBannerDevice[];
    for (const list of [devices, reversed]) {
      const codes = syncBannerFor({ phase: 'clock-ahead', devices: list }, { join: JOIN, devices: null }).troubles.map((t) => t.code);
      expect(codes).toEqual(['clock-ahead', 'join-failed', 'device-foreign', 'device-rollback']);
    }
  });

  it('l’ordre suit SYNC_TROUBLE_ORDER pour chaque phase en échec', () => {
    const devices = [device(SELF, 'active', true), device(PHONE, 'corrupt')];
    for (const phase of SYNC_PHASES) {
      const codes = syncBannerFor({ phase, devices }, { join: JOIN, devices: null }).troubles.map((t) => t.code);
      const ranks = codes.map((code) => SYNC_TROUBLE_ORDER.indexOf(code));
      expect(ranks, phase).toEqual([...ranks].sort((a, b) => a - b));
    }
  });
});
