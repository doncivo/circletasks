import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EPOCH_CARRY_REPORT_READ_FAILED_EVENT } from '../../../src/domain/sync/epochCarryReportView';
import { warmSimDevices, type SimDevice } from '../../sim/syncDevice';
import { projectP, rounds, rowsOf, twoDevices } from './epochCarryKit';

/**
 * Y-TECH-05 contre-revue, point 5 : le chargement du bloc `epochCarryReportBanner` (import dynamique du moteur, bloc à la demande) peut lui-même
 * échouer (fichier absent, réseau de l'app Tauri) : le cycle ne doit pas échouer avant la publication ; l'échec est journalisé et
 * `carry-report` est levé (visible, sans bloquer), comme pour une lecture impossible (revue S2).
 */
vi.mock('../../../src/sync/epochCarryReportBanner', () => {
  throw new Error('chargement du bloc impossible');
});

let devices: SimDevice[] = [];
beforeAll(async () => {
  await warmSimDevices();
});
afterEach(async () => {
  await Promise.all(devices.map((d) => d.close()));
  devices = [];
});

describe('Y-TECH-05 contre-revue 5 : import du bloc du compte rendu en échec dans le cycle', () => {
  it('le cycle ne tombe pas : échec journalisé, carry-report levé, publication et réception intactes', async () => {
    const [a, b] = await twoDevices();
    devices = [a, b];
    await rounds(devices);
    await a.data.repos.projects.create(projectP);
    await a.cycle();
    const status = await b.cycle();
    expect(status.phase, 'cycle de B').not.toBe('error');
    expect(status.warnings ?? []).toContain('carry-report');
    expect(b.logger.entries.filter((e) => e.event === EPOCH_CARRY_REPORT_READ_FAILED_EVENT && e.detail.code === 'import-failed')).not.toHaveLength(0);
    await rounds(devices);
    expect((await rowsOf(b, 'project')).length).toBe((await rowsOf(a, 'project')).length);
  });
});
