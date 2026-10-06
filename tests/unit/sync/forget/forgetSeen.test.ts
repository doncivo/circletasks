import { describe, expect, it } from 'vitest';
import { epochId, type DeviceAck, type ForgottenDevice, type PublishedDeviceState } from '../../../../src/domain/sync/format';
import { forgetOrder, forgottenDeleteCheck } from '../../../../src/domain/sync/retention';
import type { DeviceId, Hlc } from '../../../../src/domain/types';
import type { FolderScan } from '../../../../src/platform/sync/types';
import { forgetKnownDevices, type ForgetView } from '../../../../src/sync/forget';

/**
 * Y-10, seconde revue point 4 : « appareil vu » a la même définition chez le moteur et chez Rust (`seenDevices` / `seen_devices`, table
 * commune section `seen`) : anti-rejeu du registre rendu par le scan (`FolderScan.forgotten.accepted`, identifiants seuls), ou cité par
 * un actif. Un appareil déjà accepté dont le dossier a disparu bloque la suppression des deux côtés (Rust le refuserait sinon).
 */

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as DeviceId;
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as DeviceId;
const X = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' as DeviceId;
const E1 = epochId(1, A);
const h = (n: number, dev: DeviceId): Hlc => `${String(1_791_000_000_000 + n).padStart(15, '0')}-0000-${dev}` as Hlc;
const ack = (dev: DeviceId, stateSeq: number): DeviceAck => ({ epoch: E1, segment: 1, record: 1, hlc: h(11, dev), stateSeq });
const MASTER: ForgottenDevice[] = [{ deviceId: X, at: h(100, A), lastAck: null }];

const state = (deviceId: DeviceId, acks: [DeviceId, DeviceAck][]): PublishedDeviceState => ({
  deviceId,
  platform: 'windows',
  appVersion: '1.0.0',
  sm: 1,
  sv: 1,
  epoch: E1,
  stateSeq: 5,
  head: { epoch: E1, segment: 1, record: 1, hlc: h(11, deviceId), stateSeq: 5 },
  acks: new Map(acks),
  snapshot: null,
  purgeHorizon: null,
  lastSyncHlc: h(11, deviceId),
  forgotten: MASTER,
  reset: null,
});

const view: ForgetView = { order: forgetOrder(MASTER), master: MASTER, done: new Set(), selfForgotten: false };
const scanOf = (accepted: DeviceId[]): FolderScan => ({
  devices: [],
  ignored: 0,
  totalBytes: 0,
  tooManyDevices: false,
  incomplete: false,
  forgotten: { entries: MASTER, done: [], overflow: false, accepted },
});

describe('appareil vu : même définition que Rust (seconde revue, point 4)', () => {
  it('B accepté par le registre de Rust, dossier disparu, non cité : vu et absent, la suppression attend B (comme Rust)', () => {
    const own = state(A, [[X, ack(X, 4)]]);
    const known = forgetKnownDevices(scanOf([A, B, X]), view, new Map<DeviceId, PublishedDeviceState>(), A, own);
    expect(known.find((d) => d.deviceId === B)).toEqual({ deviceId: B, status: 'missing', state: null, seen: true });
    expect(forgottenDeleteCheck(X, A, MASTER, [], known)).toEqual({ kind: 'waiting', device: B, code: 'state-mismatch' });
  });

  it('jamais accepté ni cité : absent de la liste (fantôme), la suppression ne l’attend pas', () => {
    const own = state(A, [[X, ack(X, 4)]]);
    const known = forgetKnownDevices(scanOf([A, X]), view, new Map<DeviceId, PublishedDeviceState>(), A, own);
    expect(known.some((d) => d.deviceId === B)).toBe(false);
    expect(forgottenDeleteCheck(X, A, MASTER, [], known).kind).toBe('ready');
  });

  it('cité seulement par l’état de l’appareil oublié : pas vu', () => {
    const own = state(A, [[X, ack(X, 4)]]);
    const xState = state(X, [[B, ack(B, 2)]]);
    const known = forgetKnownDevices(scanOf([A, X]), view, new Map([[X, xState]]), A, own);
    expect(known.find((d) => d.deviceId === B)?.seen ?? false).toBe(false);
  });
});
