import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManualClock, type ManualClock } from '../../domain/clock';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { createMemoryBackup, type BackupVersion, type MemoryBackup } from '../../platform/backup';
import { AppContainerProvider } from '../app/AppContainerContext';
import { createAppContainer, type AppContainer } from '../app/container';
import { BackupRow } from './BackupRow';
import { startBackupScheduler } from './backupScheduler';
import { backupStore, RESTART_ANNOUNCE_MS } from './backupStore';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000e4');
const local = (iso: string): number => new Date(iso).getTime();

const daily = (day: string, at: string, extra: Partial<BackupVersion> = {}): BackupVersion => ({
  name: `circletasks-daily-${day}.db`,
  kind: 'daily',
  stamp: day,
  size: 51_200,
  modifiedMs: local(at),
  tasks: 12,
  schemaVersion: 14,
  ...extra,
});

describe('Sauvegarde et restauration (P-04)', () => {
  let db: TestDb;
  let clock: ManualClock;
  let backups: MemoryBackup;
  let container: AppContainer;
  let warn: ReturnType<typeof vi.spyOn>;

  function make(options: { versions?: BackupVersion[]; available?: boolean; directory?: string | null } = {}): void {
    backups = createMemoryBackup({ ...options, nowMs: () => clock.nowMs() });
    container = createAppContainer({ clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data, backups });
  }

  const renderRow = () =>
    render(
      <AppContainerProvider container={container}>
        <BackupRow />
      </AppContainerProvider>,
    );

  beforeEach(async () => {
    db = await openTestDb(DEVICE);
    clock = createManualClock(local('2026-10-05T10:00:00'));
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    await db.close();
  });

  describe('planificateur « une par jour » (critères 1 et 10)', () => {
    const env = () => ({
      document: { visibilityState: 'visible' as DocumentVisibilityState, addEventListener: vi.fn(), removeEventListener: vi.fn() },
      window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
      setInterval: vi.fn(() => 'timer'),
      clearInterval: vi.fn(),
    });

    it('à l’ouverture sans sauvegarde du jour : une seule sauvegarde, pas de remplacement', async () => {
      make({ versions: [daily('20261004', '2026-10-04T21:40:00')] });
      const scheduler = startBackupScheduler(container, env());
      await scheduler.ready;
      expect(backups.dailyCalls).toEqual([{ day: '20261005', replace: false }]);
      expect(backupStore.get(container).getState().versions).toHaveLength(2);
      scheduler.dispose();
    });

    it('sauvegarde du jour déjà présente : rien n’est recréé, même après plusieurs sondages', async () => {
      make({ versions: [daily('20261005', '2026-10-05T03:12:00')] });
      const scheduler = startBackupScheduler(container, env());
      await scheduler.ready;
      await scheduler.tick();
      await scheduler.tick();
      expect(backups.dailyCalls).toEqual([]);
      scheduler.dispose();
    });

    it('après minuit, le premier sondage ou retour au premier plan crée la sauvegarde du nouveau jour', async () => {
      clock.set(local('2026-10-05T23:59:00'));
      make();
      const scheduler = startBackupScheduler(container, env());
      await scheduler.ready;
      await scheduler.tick();
      expect(backups.dailyCalls).toHaveLength(1);
      clock.advance(2 * 60_000); // 00:01 le 6 octobre
      await scheduler.tick();
      expect(backups.dailyCalls.map((c) => c.day)).toEqual(['20261005', '20261006']);
      scheduler.dispose();
    });

    it('fenêtre masquée : aucune sauvegarde en arrière-plan', async () => {
      make();
      const hidden = env();
      hidden.document.visibilityState = 'hidden';
      const scheduler = startBackupScheduler(container, hidden);
      await scheduler.ready;
      expect(backups.dailyCalls).toEqual([]);
      scheduler.dispose();
    });

    it('le minuteur et les écouteurs sont installés puis retirés', async () => {
      make();
      const e = env();
      const scheduler = startBackupScheduler(container, e);
      await scheduler.ready;
      expect(e.setInterval).toHaveBeenCalledTimes(1);
      expect(e.document.addEventListener).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
      expect(e.window.addEventListener).toHaveBeenCalledWith('focus', expect.any(Function));
      scheduler.dispose();
      scheduler.dispose();
      expect(e.clearInterval).toHaveBeenCalledTimes(1);
      expect(e.document.removeEventListener).toHaveBeenCalledTimes(1);
    });

    it('plateforme sans sauvegarde (iPhone) : ne fait rien', async () => {
      make({ available: false });
      const e = env();
      await startBackupScheduler(container, e).ready;
      expect(e.setInterval).not.toHaveBeenCalled();
    });

    it('critère 3 : une erreur de sauvegarde est consignée et affichée en rouge ; la prochaine occasion réessaie', async () => {
      make();
      backups.failNext('daily', 'io');
      const scheduler = startBackupScheduler(container, env());
      await scheduler.ready;
      expect(backupStore.get(container).getState().failed).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[desktop:backup-daily]'));
      await scheduler.tick();
      expect(backupStore.get(container).getState().failed).toBe(true); // délai de reprise : pas de nouvelle tentative tout de suite
      clock.advance(61_000);
      await scheduler.tick();
      expect(backupStore.get(container).getState().failed).toBe(false);
      expect(backups.dailyCalls).toHaveLength(1);
      scheduler.dispose();
    });

    it('échec persistant : journalisé une seule fois par jour, avec un délai croissant entre les tentatives', async () => {
      make();
      const attempts = vi.spyOn(backups, 'list');
      for (let i = 0; i < 4; i += 1) backups.failNext('list', 'io');
      const store = backupStore.get(container);
      await store.getState().runDaily();
      expect(attempts).toHaveBeenCalledTimes(1);
      await store.getState().runDaily(); // dans la minute : rien
      expect(attempts).toHaveBeenCalledTimes(1);
      clock.advance(61_000);
      backups.failNext('list', 'io');
      await store.getState().runDaily();
      expect(attempts).toHaveBeenCalledTimes(2);
      clock.advance(61_000); // le délai a doublé (2 min) : encore trop tôt
      await store.getState().runDaily();
      expect(attempts).toHaveBeenCalledTimes(2);
      clock.advance(61_000);
      backups.failNext('list', 'io');
      await store.getState().runDaily();
      expect(attempts).toHaveBeenCalledTimes(3);
      expect(warn.mock.calls.filter((call: unknown[]) => String(call[0]).includes('backup-daily'))).toHaveLength(1);
    });

    it('pendant une restauration (en cours ou terminée), ni sauvegarde automatique ni « Sauvegarder maintenant »', async () => {
      make({ versions: [daily('20261003', '2026-10-03T03:12:00')] });
      const store = backupStore.get(container);
      for (const phase of ['running', 'done'] as const) {
        backupStore.get(container).setState({ restorePhase: phase });
        await store.getState().runDaily();
        await store.getState().backupNow();
        expect(backups.dailyCalls).toEqual([]);
      }
      backupStore.get(container).setState({ restorePhase: 'idle' });
      await store.getState().runDaily();
      expect(backups.dailyCalls).toHaveLength(1);
    });
  });

  describe('ligne de Réglages (critère 3)', () => {
    it('« Aujourd’hui 03:12 · 14 versions »', async () => {
      const versions = Array.from({ length: 13 }, (_, i) => daily(`202609${String(20 + i).padStart(2, '0')}`, `2026-09-${String(20 + i).padStart(2, '0')}T03:00:00`));
      make({ versions: [...versions, daily('20261005', '2026-10-05T03:12:00')] });
      renderRow();
      await waitFor(() => expect(screen.getByTestId('backup-summary')).toHaveTextContent('Aujourd’hui 03:12 · 14 versions'));
      expect(screen.getByText('Sauvegarde automatique')).toBeInTheDocument();
    });

    it('« Hier 21:40 · 6 versions » et « Aucune sauvegarde »', async () => {
      const older = Array.from({ length: 5 }, (_, i) => daily(`2026092${String(i)}`, `2026-09-2${String(i)}T08:00:00`));
      make({ versions: [...older, daily('20261004', '2026-10-04T21:40:00')] });
      renderRow();
      await waitFor(() => expect(screen.getByTestId('backup-summary')).toHaveTextContent('Hier 21:40 · 6 versions'));
      cleanup();
      make();
      renderRow();
      await waitFor(() => expect(screen.getByTestId('backup-summary')).toHaveTextContent('Aucune sauvegarde'));
    });

    it('le format d’heure choisi (P-03) s’applique à l’heure de la sauvegarde', async () => {
      make({ versions: [daily('20261005', '2026-10-05T03:12:00')] });
      renderRow();
      await waitFor(() => expect(screen.getByTestId('backup-summary')).toHaveTextContent('03:12'));
    });

    it('échec : « Dernière sauvegarde échouée » en rouge', async () => {
      make({ versions: [daily('20261004', '2026-10-04T21:40:00')] });
      backups.failNext('daily', 'io');
      renderRow();
      await startBackupScheduler(container, { document: { visibilityState: 'visible', addEventListener: vi.fn(), removeEventListener: vi.fn() }, window: { addEventListener: vi.fn(), removeEventListener: vi.fn() }, setInterval: () => 0, clearInterval: () => undefined }).ready;
      // QA du lot F (critère 13) : le code de l'échec suit le message.
      const summary = await screen.findByText('Dernière sauvegarde échouée Code : io');
      expect(summary).toHaveClass('ct-settings__hint--danger');
      expect(summary).toHaveAttribute('role', 'alert');
    });

    it('plateforme sans sauvegarde : la ligne n’est pas affichée', () => {
      make({ available: false });
      renderRow();
      expect(screen.queryByText('Sauvegarde automatique')).not.toBeInTheDocument();
    });
  });

  describe('feuille des versions (critères 4, 5, 9 et 12)', () => {
    const versions = [
      daily('20261003', '2026-10-03T03:12:00', { tasks: 48, size: 2_411_725 }),
      daily('20261004', '2026-10-04T21:40:00', { tasks: 1, size: 40_960 }),
      { name: 'circletasks-pre-migration-v0013-to-v0014-20261001T080000Z.db', kind: 'pre-migration' as const, stamp: '20261001T080000Z', size: 30_720, modifiedMs: local('2026-10-01T10:00:00'), tasks: null, schemaVersion: 13 },
    ];

    async function openSheet() {
      const user = { click: (element: HTMLElement) => act(async () => { fireEvent.click(element); }), escape: () => act(async () => { fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' }); }) };
      renderRow();
      await user.click(await screen.findByRole('button', { name: 'Restaurer une sauvegarde' }));
      const dialog = await screen.findByRole('dialog', { name: 'Restaurer une sauvegarde' });
      return { user, dialog };
    }

    it('liste les versions, plus récentes d’abord, avec date, heure, taille, tâches et « Avant mise à jour »', async () => {
      make({ versions, directory: 'C:\\Données\\backups' });
      const { dialog } = await openSheet();
      const rows = await within(dialog).findAllByRole('button', { name: /à \d\d:\d\d/ });
      expect(rows.map((row) => row.textContent)).toEqual([
        '4 oct. à 21:4040 Ko · 1 tâche',
        '3 oct. à 03:122,3 Mo · 48 tâches',
        '1 oct. à 10:0030 KoAvant mise à jour',
      ]);
      expect(within(dialog).getByText('Avant mise à jour')).toBeInTheDocument();
      expect(within(dialog).getByText('Dossier des sauvegardes : C:\\Données\\backups')).toBeInTheDocument();
      expect(within(dialog).getByText(/ne sont pas chiffrées et ne sont jamais synchronisées/)).toBeInTheDocument();
    });

    it('« Sauvegarder maintenant » remplace la version du jour', async () => {
      make({ versions: [daily('20261005', '2026-10-05T03:12:00')] });
      const { user, dialog } = await openSheet();
      clock.set(local('2026-10-05T11:30:00'));
      await user.click(within(dialog).getByRole('button', { name: 'Sauvegarder maintenant' }));
      await waitFor(() => expect(backups.dailyCalls).toContainEqual({ day: '20261005', replace: true }));
      expect(await within(dialog).findByText('Sauvegarde du jour mise à jour')).toBeInTheDocument();
      expect(await within(dialog).findByRole('button', { name: /5 oct\. à 11:30/ })).toBeInTheDocument();
    });

    it('aucune sauvegarde : message avec l’action « Sauvegarder maintenant »', async () => {
      make();
      const { dialog } = await openSheet();
      expect(await within(dialog).findByText('Aucune sauvegarde pour l’instant.')).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Sauvegarder maintenant' })).toBeEnabled();
    });

    it('critères 5 et 12 : une confirmation avec le focus sur « Annuler » ; annuler ne restaure rien', async () => {
      make({ versions });
      const { user, dialog } = await openSheet();
      await user.click(await within(dialog).findByRole('button', { name: /3 oct\. à 03:12/ }));
      const confirm = await screen.findByRole('alertdialog', { name: 'Restaurer cette version ?' });
      expect(within(confirm).getByText('Les données actuelles seront remplacées par celles du 3 oct. à 03:12. Une copie de l’état actuel est faite avant.')).toBeInTheDocument();
      await waitFor(() => expect(within(confirm).getByRole('button', { name: 'Annuler' })).toHaveFocus());
      await user.click(within(confirm).getByRole('button', { name: 'Annuler' }));
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(backups.restores).toEqual([]);
    });

    it('un seul clic de confirmation : restaure, annonce « Restauration terminée, redémarrage » puis redémarre', async () => {
      make({ versions });
      const { user, dialog } = await openSheet();
      await user.click(await within(dialog).findByRole('button', { name: /3 oct\. à 03:12/ }));
      vi.useFakeTimers({ shouldAdvanceTime: true });
      await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Restaurer' }));
      expect(await screen.findByText('Restauration terminée, redémarrage')).toHaveAttribute('role', 'status');
      expect(backups.restores).toEqual([{ name: 'circletasks-daily-20261003.db', stamp: expect.stringMatching(/^20261005T\d{6}Z$/) as string }]);
      expect(backups.restarts.count).toBe(0);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(RESTART_ANNOUNCE_MS + 10);
      });
      expect(backups.restarts.count).toBe(1);
    });

    it('critère 7 : une version refusée affiche un message et ne redémarre pas', async () => {
      make({ versions });
      backups.failNext('restore', 'newer-schema');
      const { user, dialog } = await openSheet();
      await user.click(await within(dialog).findByRole('button', { name: /3 oct\. à 03:12/ }));
      await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Restaurer' }));
      expect(await screen.findByText('Cette sauvegarde vient d’une version plus récente de CircleTasks. Rien n’a été modifié.')).toBeInTheDocument();
      expect(backups.restarts.count).toBe(0);
      expect(screen.queryByRole('button', { name: 'Redémarrer' })).not.toBeInTheDocument();
    });

    it('critère 8 : échec après la fermeture de la base : message et bouton « Redémarrer »', async () => {
      make({ versions });
      backups.failNext('restore', 'io', { databaseClosed: true });
      const { user, dialog } = await openSheet();
      await user.click(await within(dialog).findByRole('button', { name: /3 oct\. à 03:12/ }));
      await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Restaurer' }));
      expect(await screen.findByText('La restauration a échoué. Redémarrez CircleTasks pour retrouver vos données actuelles.')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Redémarrer' }));
      expect(backups.restarts.count).toBe(1);
    });

    it('critère 9 : « Afficher dans le dossier » appelle le service (PC)', async () => {
      make({ versions, directory: 'C:\\x\\backups' });
      const { user, dialog } = await openSheet();
      await user.click(within(dialog).getByRole('button', { name: 'Afficher dans le dossier' }));
      expect(backups.revealed.count).toBe(1);
    });

    it('Échap ferme la feuille', async () => {
      make({ versions });
      const { user } = await openSheet();
      await user.escape();
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Restaurer une sauvegarde' })).not.toBeInTheDocument());
    });
  });
});
