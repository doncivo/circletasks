// Y-TECH-02 (audit, point bas 8) : une attente d'iCloud qui dure (segment clos tronqué par un tiers, fichier qui n'arrive jamais) ne passe
// pas pour un simple délai : au-delà de WAITING_ICLOUD_LONG_MS depuis la dernière synchro complète (horloge injectée), formulation
// d'attente prolongée qui invite à vérifier iCloud pour Windows et le dossier, dans Réglages et le bandeau. Aucun délai réel.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { WAITING_ICLOUD_LONG_MS } from '../../domain/sync/limits';
import { asEntityId, type DeviceId, type IsoDateTime } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { t } from '../../i18n';
import { INITIAL_STATUS, type SyncStatus } from '../../platform/sync/types';
import { useAppStatusStore } from '../app/appStatus';
import { createAppContainer, type AppContainer } from '../app/container';
import { startSyncIntegration } from './startSync';
import { formatSyncAge, statusLine } from './syncText';
import { createFakeSyncService, type FakeSyncService } from './testKit';

const SELF = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000f4');
const LAST = '2026-10-05T08:00:00.000Z' as IsoDateTime;
const last = Date.parse(LAST);

const waiting = (patch: Partial<SyncStatus> = {}): SyncStatus => ({ ...INITIAL_STATUS, phase: 'waiting-icloud', lastSyncAt: LAST, pendingFiles: ['aaaaaaaa/e0001-x/j-00000001.ctj'], ...patch });

describe('ligne de Réglages', () => {
  it('sous le seuil : « En attente d’iCloud » ; au seuil : attente prolongée, avec l’âge de la dernière synchro complète', () => {
    expect(statusLine(waiting(), last + WAITING_ICLOUD_LONG_MS - 1)).toBe(t('sync.status.waitingIcloud'));
    const now = last + WAITING_ICLOUD_LONG_MS;
    expect(statusLine(waiting(), now)).toBe(t('sync.status.waitingIcloudLong', { age: formatSyncAge(LAST, now) }));
    // Même avec une cause (iCloud en erreur), la durée prime.
    expect(statusLine(waiting({ errorCode: 'cloud-pending' }), now)).toBe(t('sync.status.waitingIcloudLong', { age: formatSyncAge(LAST, now) }));
    // Jamais synchronisé : aucune référence, texte ordinaire.
    expect(statusLine(waiting({ lastSyncAt: null }), now)).toBe(t('sync.status.waitingIcloud'));
  });

  it('seconde revue, point 2 : texte selon la plateforme de cet appareil (PC, iPhone), neutre si elle est inconnue', () => {
    const now = last + WAITING_ICLOUD_LONG_MS;
    const self = (platform: 'windows' | 'ios') => [{ deviceId: SELF, platform, self: true, lastReadAt: null, status: 'active' as const }];
    const age = formatSyncAge(LAST, now);
    expect(statusLine(waiting({ devices: self('windows') }), now)).toBe(t('sync.status.waitingIcloudLongWindows', { age }));
    expect(statusLine(waiting({ devices: self('ios') }), now)).toBe(t('sync.status.waitingIcloudLongIos', { age }));
    expect(t('sync.status.waitingIcloudLongWindows', { age })).toMatch(/iCloud pour Windows/);
    expect(t('sync.status.waitingIcloudLongIos', { age })).toMatch(/Réglages/);
    expect(t('sync.status.waitingIcloudLongIos', { age })).not.toMatch(/Windows/);
    expect(t('sync.status.waitingIcloudLong', { age })).not.toMatch(/Windows/);
    expect(t('sync.status.waitingIcloudLong', { age })).toMatch(/dossier/);
  });
});

describe('bandeau', () => {
  let db: TestDb;
  let sync: FakeSyncService;
  let container: AppContainer;
  beforeEach(async () => {
    db = await openTestDb(SELF, new Date(last + WAITING_ICLOUD_LONG_MS).toISOString());
    sync = createFakeSyncService(waiting());
    container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data, sync });
  });
  afterEach(async () => {
    useAppStatusStore.setState({ sources: {} });
    await db.close();
  });

  it('attente prolongée : le bandeau « En attente d’iCloud » porte le texte prolongé', async () => {
    const integration = startSyncIntegration(container, { setInterval: () => 0, clearInterval: () => undefined, setTimeout: () => 0, clearTimeout: () => undefined });
    await integration.refreshed();
    expect(useAppStatusStore.getState().sources.waitingIcloud?.message).toBe(statusLine(sync.status(), db.clock.nowMs()));
    expect(useAppStatusStore.getState().sources.waitingIcloud?.message).toContain('24 h');
    integration.dispose();
  });
});
