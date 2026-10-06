import { describe, expect, it } from 'vitest';
import type { DeviceSyncStatus } from '../../platform/sync/types';
import type { DeviceState } from './compat';
import { DEVICE_STATES, deviceStateOf, keyMismatchFromDevices } from './devices';

describe('statuts d’appareil partagés par le moteur et les bandeaux (A-09, revue 5 et 10)', () => {
  it('DEVICE_STATES, DeviceState et DeviceSyncStatus sont la même union', () => {
    const forth: readonly DeviceSyncStatus[] = DEVICE_STATES;
    const back: readonly DeviceState[] = forth;
    expect(new Set(back).size).toBe(8);
  });

  it('statut connu : tel quel ; statut inconnu (version plus récente, base abîmée) : signalé comme illisible, jamais « actif »', () => {
    for (const state of DEVICE_STATES) expect(deviceStateOf(state)).toBe(state);
    expect(deviceStateOf('lost')).toBe('corrupt');
    expect(deviceStateOf('')).toBe('corrupt');
  });

  it('clé différente : au moins un autre appareil, et tous les autres d’une autre clé', () => {
    expect(keyMismatchFromDevices([])).toBe(false);
    expect(keyMismatchFromDevices([{ self: true, foreign: true }])).toBe(false);
    expect(keyMismatchFromDevices([{ self: true, foreign: false }, { self: false, foreign: true }])).toBe(true);
    expect(keyMismatchFromDevices([{ self: false, foreign: true }, { self: false, foreign: false }])).toBe(false);
  });
});
