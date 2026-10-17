import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManualClock } from '../../domain/clock';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createMemoryBackup, type BackupVersion, type MemoryBackup } from '../../platform/backup';
import type { SyncDeviceStatus } from '../../platform/sync/types';
import { AppContainerProvider } from '../app/AppContainerContext';
import { createAppContainer, type AppContainer } from '../app/container';
import { createFakeSyncService } from '../sync/testKit';
import { BackupSheet } from './BackupSheet';

/**
 * Y-TECH-04 partie C, critères 18 à 24 : l'écran de restauration montre pour chaque fichier l'appareil (nom lisible), la date et l'heure
 * réelles (24 h) et l'époque ; la restauration choisie depuis la ligne reste inchangée.
 */
const OWN = '7d0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
const PHONE = 'a1b2c3d4-0000-4000-8000-00000000abcd';
const FORGOTTEN = '56d40a0a-ffff-4fff-8fff-ffffffffffff';
const NEVER_SEEN = '9f8e7d6c-1111-4222-8333-444455556666';
const OWN_ID = asEntityId<DeviceId>(OWN);
const local = (iso: string): number => new Date(iso).getTime();

const entry = (day: string, at: string, extra: Partial<BackupVersion>): BackupVersion => ({
  name: `circletasks-daily-${day}.db`,
  kind: 'daily',
  stamp: day,
  size: 40_960,
  modifiedMs: local(at),
  tasks: 3,
  schemaVersion: 17,
  ...extra,
});

const device = (deviceId: string, platform: 'windows' | 'ios', extra: Partial<SyncDeviceStatus> = {}): SyncDeviceStatus => ({
  deviceId: deviceId as DeviceId,
  platform,
  self: false,
  lastReadAt: null,
  status: 'active',
  seen: true,
  ...extra,
});

describe('Y-TECH-04 partie C : appareil, date et époque sur chaque ligne de restauration', () => {
  let db: TestDb;
  let backups: MemoryBackup;
  let container: AppContainer;

  async function open(versions: BackupVersion[], options: { currentEpoch?: string | null; devices?: SyncDeviceStatus[] } = {}): Promise<HTMLElement> {
    db = await openTestDb(OWN_ID, '2026-10-08T08:00:00.000Z');
    await db.data.repos.settings.set('device.id', OWN_ID);
    if (options.currentEpoch) await db.data.repos.sync.setMeta('epoch', JSON.stringify(options.currentEpoch));
    backups = createMemoryBackup({ versions, nowMs: () => db.clock.nowMs() });
    const sync = createFakeSyncService({ phase: 'idle', devices: options.devices ?? [device(OWN, 'windows', { self: true }), device(PHONE, 'ios'), device(FORGOTTEN, 'windows', { status: 'forgotten' })] });
    container = createAppContainer({ clock: createManualClock(local('2026-10-08T08:00:00')), hlc: createHlcClock({ clock: db.clock, deviceId: OWN_ID }), data: db.data, backups, sync });
    render(
      <AppContainerProvider container={container}>
        <BackupSheet onClose={() => undefined} />
      </AppContainerProvider>,
    );
    return screen.findByRole('list', { name: 'Versions sauvegardées' });
  }

  beforeEach(() => {
    window.localStorage.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    await db.close();
  });

  const versions = (): BackupVersion[] => [
    entry('20261007', '2026-10-07T18:05:00', { deviceId: OWN, platform: 'windows', epoch: `e0002-${OWN}` }),
    entry('20261006', '2026-10-06T07:30:00', { deviceId: PHONE, platform: 'ios', epoch: `e0001-${PHONE}` }),
    entry('20261005', '2026-10-05T22:10:00', { deviceId: FORGOTTEN, platform: 'windows', epoch: `e0001-${FORGOTTEN}` }),
    entry('20261004', '2026-10-04T03:12:00', { deviceId: NEVER_SEEN, platform: 'windows', epoch: `e0003-${NEVER_SEEN}` }),
    entry('20261003', '2026-10-03T03:12:00', { deviceId: null, platform: null, epoch: null }),
  ];

  const row = (list: HTMLElement, date: RegExp): HTMLElement => within(list).getByRole('button', { name: date });

  it('chaque ligne lit l’appareil, la date et l’heure réelles en 24 h, et l’époque', async () => {
    const list = await open(versions(), { currentEpoch: `e0002-${OWN}` });
    await waitFor(() => expect(row(list, /^7 oct\./).textContent).toContain('Cet appareil'));
    expect(row(list, /^7 oct\./).textContent).toBe('7 oct. à 18:05Cet appareilépoque 2, ouverte par cet appareil40 Ko · 3 tâches');
    expect(row(list, /^6 oct\./).textContent).toBe('6 oct. à 07:30iPhoneépoque 1, ouverte par iPhoneautre époque40 Ko · 3 tâches');
    expect(row(list, /^5 oct\./).textContent).toBe('5 oct. à 22:10PC 56d4 (oublié)époque 1, ouverte par PC 56d4 (oublié)autre époque40 Ko · 3 tâches');
    expect(row(list, /^4 oct\./).textContent).toBe('4 oct. à 03:12Appareil 9f8e7d6cépoque 3autre époque40 Ko · 3 tâches');
    expect(row(list, /^3 oct\./).textContent).toBe('3 oct. à 03:12Appareil inconnu40 Ko · 3 tâches');
    expect(list.textContent).not.toContain(PHONE);
    expect(list.textContent).not.toContain(NEVER_SEEN);
  });

  it('le nom accessible de la ligne lit la date, l’appareil et l’époque', async () => {
    const list = await open(versions(), { currentEpoch: `e0002-${OWN}` });
    await waitFor(() => expect(row(list, /^6 oct\./)).toHaveAccessibleName('6 oct. à 07:30, iPhone, époque 1, ouverte par iPhone, autre époque, 40 Ko · 3 tâches'));
  });

  it('époque courante inconnue : aucune mention « autre époque » (pas de fausse alerte)', async () => {
    const list = await open(versions(), { currentEpoch: null });
    await waitFor(() => expect(row(list, /^6 oct\./).textContent).toContain('iPhone'));
    expect(list.textContent).not.toContain('autre époque');
  });

  it('identité propre lue dans les réglages quand la synchro n’est pas configurée', async () => {
    const list = await open([entry('20261007', '2026-10-07T18:05:00', { deviceId: OWN, platform: 'windows', epoch: null })], { devices: [] });
    await waitFor(() => expect(row(list, /^7 oct\./).textContent).toContain('Cet appareil'));
    expect(row(list, /^7 oct\./).textContent).toBe('7 oct. à 18:05Cet appareil40 Ko · 3 tâches');
  });

  it('sauvegarde sans les champs d’origine (service qui ne les fournit pas) : ligne inchangée', async () => {
    const list = await open([entry('20261007', '2026-10-07T18:05:00', {})]);
    expect(row(list, /^7 oct\./).textContent).toBe('7 oct. à 18:0540 Ko · 3 tâches');
  });

  it('la restauration depuis la ligne reste inchangée : confirmation, puis restauration de ce fichier', async () => {
    const list = await open(versions(), { currentEpoch: `e0002-${OWN}` });
    fireEvent.click(row(list, /^6 oct\./));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText('Les données actuelles seront remplacées par celles du 6 oct. à 07:30. Une copie de l’état actuel est faite avant.')).toBeInTheDocument();
    expect(backups.restores).toEqual([]);
    fireEvent.click(within(confirm).getByRole('button', { name: 'Restaurer' }));
    await waitFor(() => expect(backups.restores).toEqual([{ name: 'circletasks-daily-20261006.db', stamp: expect.stringMatching(/^\d{8}T\d{6}Z$/) as string }]));
  });
});
