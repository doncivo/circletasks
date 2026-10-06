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
  type SyncBannerStatus,
  type SyncPhase,
} from './syncBanners';
import { asEntityId, type DeviceId } from './types';

const SELF = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000a1');
const PHONE = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000b2');
const LAPTOP = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000c3');

const device = (deviceId: DeviceId, status: DeviceState, self = false): SyncBannerDevice => ({ deviceId, self, status });
const NONE: PersistedSyncFacts = { join: null, devices: null, blocking: null, readFailed: false };
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
  // Y-10 : appareil local oublié.
  forgotten: { kind: 'trouble', code: 'forgotten' },
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

  it('une valeur hors liste (version plus récente) : repli visible, jamais une erreur ni « aucun bandeau » (revue 2)', () => {
    expect(phaseBanner('reset-required' as SyncPhase)).toEqual({ kind: 'trouble', code: 'error' });
    expect(deviceTrouble('lost' as DeviceState)).toBe('device-corrupt');
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
    for (const code of [...phaseCodes, ...deviceCodes, 'join-failed' as const, 'state-unreadable' as const]) expect(SYNC_TROUBLE_ORDER).toContain(code);
    // Revue 1 : base illisible juste après l'échec.
    expect(SYNC_TROUBLE_ORDER.indexOf('state-unreadable')).toBe(SYNC_TROUBLE_ORDER.indexOf('error') + 1);
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
    const settled: SyncBannerStatus = { phase: 'error', devices: [] };
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
      const codes = syncBannerFor({ phase, devices: [] }, { ...NONE, join: JOIN }).troubles.map((t) => t.code);
      expect(codes, phase).toContain('join-failed');
    }
    expect(syncBannerFor({ phase: 'not-configured', devices: [] }, { ...NONE, join: JOIN, devices: [] }).troubles).toEqual([{ code: 'join-failed', join: JOIN }]);
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
    expect(syncBannerFor({ phase: 'not-configured', devices: [] }, { ...NONE, devices: stored }).troubles).toEqual([{ code: 'key-mismatch' }]);
    const mixed = [device(SELF, 'active', true), device(PHONE, 'foreign'), device(LAPTOP, 'active')];
    const banners = syncBannerFor({ phase: 'not-configured', devices: [] }, { ...NONE, devices: mixed });
    expect(banners.troubles).toEqual([{ code: 'device-foreign', device: mixed[1] }]);
    expect(banners.devices).toBe(mixed);
    // Seul : aucun autre appareil, aucune clé différente.
    expect(syncBannerFor({ phase: 'not-configured', devices: [] }, { ...NONE, devices: [device(SELF, 'active', true)] }).troubles).toEqual([]);
  });
});

describe('un seul bandeau, le plus urgent (critère 9 g, D4)', () => {
  it('ordre fixe, quel que soit l’ordre des appareils', () => {
    const devices = [device(SELF, 'active', true), device(LAPTOP, 'rollback'), device(PHONE, 'foreign')];
    const reversed = [devices[0], devices[2], devices[1]] as SyncBannerDevice[];
    for (const list of [devices, reversed]) {
      const codes = syncBannerFor({ phase: 'clock-ahead', devices: list }, { ...NONE, join: JOIN }).troubles.map((t) => t.code);
      expect(codes).toEqual(['clock-ahead', 'join-failed', 'device-foreign', 'device-rollback']);
    }
  });

  it('l’ordre suit SYNC_TROUBLE_ORDER pour chaque phase en échec', () => {
    const devices = [device(SELF, 'active', true), device(PHONE, 'corrupt')];
    for (const phase of SYNC_PHASES) {
      const codes = syncBannerFor({ phase, devices }, { ...NONE, join: JOIN }).troubles.map((t) => t.code);
      const ranks = codes.map((code) => SYNC_TROUBLE_ORDER.indexOf(code));
      expect(ranks, phase).toEqual([...ranks].sort((a, b) => a - b));
    }
  });
});

describe('revue A-09 : lecture en échec, attente gardée, phase bloquante persistée, texte (points 1, 6, 7, 9)', () => {
  it('lecture de la base en échec : « state-unreadable », compté avec l’échec gardé qu’il ne remplace pas', () => {
    const banners = syncBannerFor({ phase: 'idle', devices: [] }, { ...NONE, join: JOIN, readFailed: true });
    expect(banners.troubles.map((t) => t.code)).toEqual(['state-unreadable', 'join-failed']);
    expect(syncBannerFor({ phase: 'not-configured', devices: [] }, { ...NONE, readFailed: true }).troubles).toEqual([{ code: 'state-unreadable' }]);
  });

  it('« En attente d’iCloud » reste pendant le cycle suivant, avec sa cause (QA-2)', () => {
    const settled: SyncBannerStatus = { phase: 'waiting-icloud', errorCode: 'cloud-provider-stopped', devices: [] };
    const during = syncBannerFor({ phase: 'syncing', devices: [] }, NONE, settled);
    expect(during.waitingIcloud).toEqual({ cause: 'cloud-provider-stopped' });
    expect(during.syncing).toBe(true);
    expect(during.textStatus).toBe(settled);
  });

  it('phase bloquante persistée (avant le premier cycle) : bandeau de cette phase, texte d’un état composé avec ses codes', () => {
    const devices = [device(SELF, 'active', true), device(PHONE, 'clock-ahead')];
    const status = { phase: 'not-configured' as const, devices: [] };
    const banners = syncBannerFor(status, { ...NONE, devices, blocking: { phase: 'clock-ahead', errorCode: null, clockAheadDevice: PHONE } });
    expect(banners.troubles).toEqual([{ code: 'clock-ahead' }]);
    expect(banners.textStatus).toMatchObject({ phase: 'clock-ahead', clockAheadDevice: PHONE, devices });
    const error = syncBannerFor(status, { ...NONE, blocking: { phase: 'error', errorCode: 'folder-unreachable', clockAheadDevice: null } });
    expect(error.textStatus).toMatchObject({ phase: 'error', errorCode: 'folder-unreachable' });
  });

  it('une phase en échec actuelle passe avant la phase persistée ; sans échec, l’état affiché est le texte', () => {
    const status = { phase: 'key-mismatch' as const, devices: [] };
    const banners = syncBannerFor(status, { ...NONE, blocking: { phase: 'error', errorCode: 'io', clockAheadDevice: null } });
    expect(banners.troubles).toEqual([{ code: 'key-mismatch' }]);
    expect(banners.textStatus).toBe(status);
  });
});
