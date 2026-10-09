import { act, cleanup, fireEvent, render, screen, waitForElementToBeRemoved } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId, type IsoDateTime } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStatusStore } from '../app/appStatus';
import { createAppContainer, type AppContainer } from '../app/container';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { RestoreChoiceDialog } from './RestoreChoiceDialog';
import { SyncDetailsScreen } from './SyncDetailsScreen';
import { SyncStatusLine } from './SyncStatusLine';
import { t } from '../../i18n';
import { applyRemoteChanges } from './remoteChanges';
import { startSyncIntegration } from './startSync';
import { createFakeSyncService, nextCall, type FakeSyncService } from './testKit';

/**
 * Écrans de synchro sans maquette (ADR 0011 « Maquettes manquantes » ; Y-02 critères 13, 16 à 19, Y-09 critère 10).
 *
 * Attentes (Y-TECH-02, aucun sondage) : un appel au service par sa propre promesse (`nextCall`) ; une fenêtre qui apparaît ou disparaît par
 * `findBy…` ou `waitForElementToBeRemoved`, seulement parce qu'aucun délai réel n'est en jeu (faux service, aucune minuterie) : ils se
 * résolvent sur la mutation du DOM, jamais au bout d'une attente.
 */

const SELF = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000d1');
const IPHONE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as DeviceId;
const NOW = '2026-10-05T08:02:00.000Z';

let db: TestDb;
let container: AppContainer;
let sync: FakeSyncService;

beforeEach(async () => {
  db = await openTestDb(SELF, NOW);
  sync = createFakeSyncService({ phase: 'idle', lastSyncAt: '2026-10-05T08:00:00.000Z' as IsoDateTime, folderLabel: 'CircleTasks', folderKind: 'icloud' });
  container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data, sync });
});

afterEach(async () => {
  cleanup();
  useNavigationStore.setState(INITIAL_NAVIGATION);
  useAppStatusStore.setState({ sources: {} });
  await db.close();
});

const renderIn = (node: React.ReactNode) => render(<AppContainerProvider container={container}>{node}</AppContainerProvider>);

describe('ligne d’état de Réglages (Y-02 critère 16, Y-05 critère 2)', () => {
  it('« À jour · il y a 2 min », libellé du dossier, lien « Détails »', () => {
    renderIn(<SyncStatusLine />);
    expect(screen.getByText('iCloud Drive / CircleTasks')).toBeTruthy();
    expect(screen.getByTestId('sync-status-text').textContent).toBe('À jour · il y a 2 min');
    fireEvent.click(screen.getByRole('button', { name: 'Détails' }));
    expect(useNavigationStore.getState().route).toEqual({ tab: 'settings', screen: 'sync' });
  });

  it('la sous-ligne n’est pas une région vivante ; seule « À jour » (sans âge) est annoncée, rien pendant un problème (le bandeau l’annonce)', () => {
    renderIn(<SyncStatusLine />);
    expect(screen.getByTestId('sync-status-text').closest('[role="status"]')).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('À jour');
    cleanup();
    sync.setStatus({ phase: 'error', errorCode: 'folder-unreachable' });
    renderIn(<SyncStatusLine />);
    expect(screen.getByRole('status').textContent).toBe('');
  });

  it('revue point 1 : idle avec une réintégration en échec (sous-ligne rouge) n’annonce pas « À jour »', () => {
    sync.setStatus({ phase: 'idle', reintegrationFailure: { fields: 3, tables: ['task'], at: '2026-10-05T07:30:00.000Z' as IsoDateTime, errors: ['DbError'] } });
    renderIn(<SyncStatusLine />);
    expect(screen.getByTestId('sync-status-text')).toHaveAttribute('data-trouble', 'true');
    expect(screen.getByTestId('sync-status-live').textContent).toBe('');
  });

  it('revue point 2 : idle, syncing, idle ne change pas le texte de la région (pas de réannonce à chaque cycle)', () => {
    renderIn(<SyncStatusLine />);
    const live = screen.getByTestId('sync-status-live');
    expect(live.textContent).toBe('À jour');
    const seen: string[] = [];
    const observer = new MutationObserver(() => seen.push(live.textContent ?? ''));
    observer.observe(live, { childList: true, characterData: true, subtree: true });
    act(() => sync.setStatus({ phase: 'syncing' }));
    expect(live.textContent).toBe('À jour');
    act(() => sync.setStatus({ phase: 'idle', lastSyncAt: NOW as IsoDateTime }));
    expect(live.textContent).toBe('À jour');
    seen.push(...observer.takeRecords().map((r) => r.type));
    observer.disconnect();
    expect(seen).toEqual([]);
  });

  it('seconde revue point B : error, syncing (lastSyncAt gardé), error : la région ne change jamais', () => {
    sync.setStatus({ phase: 'error', errorCode: 'folder-unreachable' });
    renderIn(<SyncStatusLine />);
    const live = screen.getByTestId('sync-status-live');
    expect(live.textContent).toBe('');
    const seen: string[] = [];
    const observer = new MutationObserver(() => seen.push(live.textContent ?? ''));
    observer.observe(live, { childList: true, characterData: true, subtree: true });
    act(() => sync.setStatus({ phase: 'syncing' }));
    act(() => sync.setStatus({ phase: 'error', errorCode: 'folder-unreachable' }));
    seen.push(...observer.takeRecords().map((r) => r.type));
    observer.disconnect();
    expect(seen).toEqual([]);
    expect(live.textContent).toBe('');
  });

  it('erreurs explicites, jamais de boîte bloquante', () => {
    sync.setStatus({ phase: 'error', errorCode: 'folder-unreachable' });
    renderIn(<SyncStatusLine />);
    expect(screen.getByTestId('sync-status-text').textContent).toBe('Dossier de synchro introuvable : vos modifications seront envoyées au retour');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    cleanup();
    sync.setStatus({ phase: 'error', errorCode: 'cloud-provider-stopped' });
    renderIn(<SyncStatusLine />);
    expect(screen.getByTestId('sync-status-text').textContent).toBe('Ouvrez iCloud pour Windows : vos modifications seront envoyées au retour');
  });
});

describe('détails (Y-02 critère 17, Y-09 critère 10)', () => {
  it('appareils avec dernière lecture et statut, fichiers en attente, conflits de la semaine, horloge en avance', () => {
    sync.setStatus({
      phase: 'clock-ahead',
      clockAheadDevice: IPHONE,
      devices: [
        { deviceId: SELF, platform: 'windows', self: true, lastReadAt: '2026-10-05T08:00:00.000Z' as IsoDateTime, status: 'active' },
        { deviceId: IPHONE, platform: 'ios', self: false, lastReadAt: '2026-10-05T07:42:00.000Z' as IsoDateTime, status: 'clock-ahead' },
      ],
      pendingFiles: ['bbbbbbbb/e0001/j-00000002.ctj'],
      conflictsThisWeek: 2,
    });
    renderIn(<SyncDetailsScreen />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Synchronisation');
    expect(screen.getByText(/^Cet appareil · /)).toBeTruthy();
    expect(screen.getByText('iPhone')).toBeTruthy();
    expect(screen.getByText(/^Dernière modification lue : /)).toBeTruthy();
    expect(screen.getByText('Horloge en avance')).toBeTruthy();
    expect(screen.getByText('L’horloge de iPhone est en avance : vérifiez sa date et son heure')).toBeTruthy();
    expect(screen.getByText('1 fichier en attente d’iCloud')).toBeTruthy();
    expect(screen.getByText('2 conflits cette semaine')).toBeTruthy();
  });
});

describe('choix après restauration (Y-02 critère 13, Y-09 critère 8)', () => {
  it('ouvert de lui-même en phase restore-choice ; deux options ; le choix est transmis au service', async () => {
    sync.restore = { marker: { backup: 'x', backupTakenAt: NOW as IsoDateTime, restoredAt: NOW as IsoDateTime, schemaVersion: 17 }, options: ['apply-everywhere', 'keep-synced'] };
    sync.setStatus({ phase: 'restore-choice' });
    renderIn(<RestoreChoiceDialog />);
    await screen.findByRole('alertdialog');
    expect(screen.getByText('Les modifications que cet appareil avait déjà reçues seront remplacées sur tous vos appareils')).toBeTruthy();
    const chosen = nextCall(sync, 'chooseRestoreOption');
    fireEvent.click(screen.getByRole('button', { name: 'Garder les données synchronisées' }));
    await act(async () => {
      await chosen;
    });
    expect(sync.choices).toEqual(['keep-synced']);
  });

  it('la fenêtre se ferme quand le choix est exécuté ; elle reste ouverte s’il ne l’a pas été (revue Y2, point 12)', async () => {
    const context = { marker: { backup: 'x', backupTakenAt: NOW as IsoDateTime, restoredAt: NOW as IsoDateTime, schemaVersion: 17 }, options: ['apply-everywhere', 'keep-synced'] as const };
    sync.restore = context;
    sync.choiceExecuted = false;
    sync.setStatus({ phase: 'restore-choice' });
    renderIn(<RestoreChoiceDialog />);
    await screen.findByRole('alertdialog');
    const chosen = nextCall(sync, 'chooseRestoreOption');
    fireEvent.click(screen.getByRole('button', { name: 'Garder les données synchronisées' }));
    await act(async () => {
      await chosen;
    });
    expect(sync.choices).toEqual(['keep-synced']);
    // Choix non exécuté : la fenêtre reste, relue (mutation du DOM, aucun minuteur en jeu).
    await screen.findByRole('button', { name: 'Garder les données synchronisées' });
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    sync.choiceExecuted = true;
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(screen.getByRole('button', { name: 'Garder les données synchronisées' }));
    await waitForElementToBeRemoved(dialog);
    expect(sync.choices).toEqual(['keep-synced', 'keep-synced']);
  });

  it('règle 4 : une seule option, explication ; « Plus tard » ferme sans rien changer', async () => {
    sync.restore = { marker: { backup: 'x', backupTakenAt: NOW as IsoDateTime, restoredAt: NOW as IsoDateTime, schemaVersion: 17 }, options: ['apply-everywhere'] };
    sync.setStatus({ phase: 'restore-choice' });
    renderIn(<RestoreChoiceDialog />);
    await screen.findByRole('alertdialog');
    expect(screen.queryByRole('button', { name: 'Garder les données synchronisées' })).toBeNull();
    expect(screen.getByText(t('sync.restore.bodyOnlyApply'))).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Plus tard' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(sync.choices).toEqual([]);
  });
});

describe('branchements (Y-02 critères 17 à 19)', () => {
  it('bandeaux A-09 : « Synchro en cours » et « En attente d’iCloud » posés et retirés, « Hors ligne » jamais touché', () => {
    useAppStatusStore.getState().setStatus('offline', {});
    // A-09 critère 9 d : « Synchro en cours » après 1 s de cycle (minuteur factice déclenché à la main, aucun délai réel).
    const due: (() => void)[] = [];
    const integration = startSyncIntegration(container, { setInterval: () => 0, clearInterval: () => undefined, setTimeout: (handler) => due.push(handler), clearTimeout: () => undefined });
    expect(sync.calls).toEqual(['open']);
    sync.setStatus({ phase: 'syncing' });
    expect(useAppStatusStore.getState().sources.syncing).toBeUndefined();
    for (const fire of due.splice(0)) fire();
    expect(useAppStatusStore.getState().sources.syncing).toBeDefined();
    sync.setStatus({ phase: 'waiting-icloud' });
    expect(useAppStatusStore.getState().sources.syncing).toBeUndefined();
    expect(useAppStatusStore.getState().sources.waitingIcloud).toBeDefined();
    sync.setStatus({ phase: 'idle' });
    expect(useAppStatusStore.getState().sources.waitingIcloud).toBeUndefined();
    integration.dispose();
    expect(useAppStatusStore.getState().sources.offline).toBeDefined();
  });

  it('sans synchro : aucun planificateur, aucun bandeau', () => {
    const plain = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data });
    expect(plain.sync).toBeNull();
    startSyncIntegration(plain).dispose();
    expect(useAppStatusStore.getState().sources).toEqual({});
  });

  it('onRemoteChanges : taskEntities reçoit les tâches relues, une tâche supprimée en est retirée', async () => {
    const task = await db.data.repos.tasks.create({
      id: asEntityId('12000000-0000-4000-8000-000000000001'), spaceId: asEntityId('00000000-0000-4000-8000-000000000001'), projectId: null, title: 'Reçue', note: '', date: null, time: null,
      status: 'todo', doneAt: null, sortOrder: 1, carriedOver: false, recurrenceId: null, seriesIndex: null, seriesTemplate: null, goalId: null, icon: null, someday: false, source: 'local', externalId: null, appleListId: null, appleRecurring: false, externalEventId: null,
    });
    await applyRemoteChanges(container, { tables: new Set(['task']), ids: new Map([['task', new Set([task.id])]]) });
    expect(container.taskEntities.get(task.id)?.title).toBe('Reçue');
    await db.data.repos.tasks.softDelete([task.id]);
    await applyRemoteChanges(container, { tables: new Set(['task']), ids: new Map([['task', new Set([task.id])]]) });
    expect(container.taskEntities.get(task.id)).toBeUndefined();
  });
});

describe('choix après restauration pendant une réinitialisation (Y-11, ADR 0011 §18 point 16 ; QA-1)', () => {
  const marker = { backup: 'x', backupTakenAt: NOW as IsoDateTime, restoredAt: NOW as IsoDateTime, schemaVersion: 17 };
  it('« Appliquer partout » retiré : texte de la réinitialisation en cours ; règle 4 : aucune option, « terminez-la »', async () => {
    sync.restore = { marker, options: ['keep-synced'], notice: 'reset-in-progress' };
    sync.setStatus({ phase: 'restore-choice' });
    renderIn(<RestoreChoiceDialog />);
    await screen.findByRole('alertdialog');
    expect(screen.getByText(t('sync.restore.resetInProgress'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Appliquer cette version sur tous mes appareils' })).toBeNull();
    cleanup();
    sync.restore = { marker, options: [], notice: 'reset-finish' };
    renderIn(<RestoreChoiceDialog />);
    await screen.findByRole('alertdialog');
    expect(screen.getByText(t('sync.restore.resetFinish'))).toBeTruthy();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Plus tard']);
  });

  it('choix refusé ou en échec : gardé et dit dans la fenêtre (aucun échec silencieux)', async () => {
    sync.restore = { marker, options: ['apply-everywhere', 'keep-synced'], failure: { code: 'io', at: NOW as IsoDateTime, option: 'keep-synced' } };
    sync.setStatus({ phase: 'restore-choice' });
    renderIn(<RestoreChoiceDialog />);
    await screen.findByRole('alertdialog');
    expect(screen.getByText('Le choix n’a pas pu être appliqué (erreur d’écriture). Rien n’a été changé : vous pouvez réessayer.')).toBeTruthy();
    cleanup();
    sync.restore = { marker, options: ['keep-synced'], notice: 'reset-in-progress', failure: { code: 'state-mismatch', at: NOW as IsoDateTime, option: 'apply-everywhere' } };
    renderIn(<RestoreChoiceDialog />);
    await screen.findByRole('alertdialog');
    expect(screen.getByText(t('sync.restore.failedReset'))).toBeTruthy();
  });
});
