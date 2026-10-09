import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import { asEntityId, type DeviceId } from '../../domain/types';
import { openTestDb } from '../../db/repositories/sql/testSetup';
import { t } from '../../i18n';
import { tUpdateRestore } from '../../i18n/appUpdateRestoreText';
import { BackupError, type BackupService } from '../../platform/backup';
import type { DbEnvironment } from '../../platform/dbDiagnostics';
import { AboutSection } from '../settings/AboutSection';
import { AppContainerProvider } from './AppContainerContext';
import type { DbFailure } from './appStore';
import { createAppContainer } from './container';
import { DbFailureDetails, failureAlertKey, formatDbFailure } from './DbFailureDetails';
import { restoreUpdateBackup, updateRestoreFailureText } from './updateRestore';

/**
 * I-06 critères 8, 13 et 14 (ADR 0007 avenant I-06 points 4 et 7) : écran d'échec après une mise à jour (versions, trois actions,
 * restauration confirmée), base plus récente que l'app (consigne, pas de restauration), « À propos » de l'iPhone.
 */

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const ENV: DbEnvironment = { runtime: 'tauri', os: 'ios', buildPlatform: 'ios', appVersion: '0.3.0', paths: null, pathsError: null };
const readEnvironment = () => Promise.resolve(ENV);
const BACKUP = 'circletasks-pre-migration-v0018-to-v0019-20261009T080000Z.db';
const MIGRATION_FAILURE: DbFailure = {
  phase: 'open',
  step: 'migration',
  migration: 19,
  errorName: 'DbError',
  message: 'near "INSTRUCTION": syntax error',
  kind: 'migration',
  appVersion: '0.3.0',
  schemaVersion: 18,
  appSchemaVersion: 19,
  updateBackup: { name: BACKUP },
};
const NEWER_FAILURE: DbFailure = { phase: 'open', step: 'schema', errorName: 'SchemaNewerThanApp', message: 'schéma de la base 19 > schéma de l’app 18', kind: 'schema-newer', appVersion: '0.2.3', schemaVersion: 19, appSchemaVersion: 18, updateBackup: null };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('critère 13 : migration en échec après la mise à jour', () => {
  it('diagnostic : étape « migration 19 », nom de l’erreur, version de l’app, schéma de la base et de l’app, sauvegarde, chemin de la base', () => {
    const text = formatDbFailure(MIGRATION_FAILURE, ENV);
    expect(text).toContain(t('app.diag.step', { step: t('app.diag.steps.migration', { version: '19' }) }));
    expect(text).toContain(t('app.diag.error', { name: 'DbError', message: 'near "INSTRUCTION": syntax error' }));
    expect(text).toContain(t('app.update.appVersionLine', { version: '0.3.0' }));
    expect(text).toContain(t('app.update.schemaLine', { database: '18', app: '19' }));
    expect(text).toContain(t('app.update.backupLine', { name: BACKUP }));
    expect(text).toContain('sqlite:circletasks.db');
    expect(formatDbFailure({ ...MIGRATION_FAILURE, appVersion: null, schemaVersion: null }, ENV)).toContain(t('app.update.appVersionLine', { version: t('app.diag.unknown') }));
  });

  it('trois actions : Réessayer, Copier le détail, Restaurer ; confirmation avec « Annuler » par défaut, Annuler ne fait rien', async () => {
    const restore = vi.fn(() => Promise.resolve({ ok: true } as const));
    render(<DbFailureDetails failure={MIGRATION_FAILURE} readEnvironment={readEnvironment} canRestore restore={restore} />);
    expect(screen.getByText('Vos données sont intactes. Ne supprimez pas CircleTasks. Envoyez le détail pour obtenir un correctif.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('app.diag.retry') })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('app.diag.copy') })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: tUpdateRestore('restore') }));
    const dialog = await screen.findByRole('alertdialog', { name: tUpdateRestore('restoreConfirmTitle') });
    expect(dialog).toHaveTextContent(tUpdateRestore('restoreConfirmBody'));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: t('common.cancel') })));
    fireEvent.click(screen.getByRole('button', { name: t('common.cancel') }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(restore).not.toHaveBeenCalled();
  });

  it('restauration confirmée : la sauvegarde de ce démarrage est restaurée, annonce pendant l’opération', async () => {
    let finish: (value: { ok: true }) => void = () => undefined;
    const restore = vi.fn((_name: string) => new Promise<{ ok: true }>((resolve) => (finish = resolve)));
    render(<DbFailureDetails failure={MIGRATION_FAILURE} readEnvironment={readEnvironment} canRestore restore={restore} />);
    fireEvent.click(await screen.findByRole('button', { name: tUpdateRestore('restore') }));
    fireEvent.click(await screen.findByRole('button', { name: tUpdateRestore('restoreConfirm') }));
    expect(restore).toHaveBeenCalledWith(BACKUP);
    expect(await screen.findByText(tUpdateRestore('restoring'))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: tUpdateRestore('restore') })).toBeDisabled();
    finish({ ok: true });
  });

  it('échec de la restauration : raison de P-04 et code affichés, l’écran reste avec ses actions', async () => {
    const restore = vi.fn(() => Promise.resolve({ ok: false as const, message: t('backup.errorNotFound'), code: 'not-found' as const }));
    render(<DbFailureDetails failure={MIGRATION_FAILURE} readEnvironment={readEnvironment} canRestore restore={restore} />);
    fireEvent.click(await screen.findByRole('button', { name: tUpdateRestore('restore') }));
    fireEvent.click(await screen.findByRole('button', { name: tUpdateRestore('restoreConfirm') }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(tUpdateRestore('restoreFailed', { reason: t('backup.errorNotFound') }));
    expect(alert).toHaveTextContent(t('backup.errorCode', { code: 'not-found' }));
    expect(screen.getByRole('button', { name: tUpdateRestore('restore') })).toBeEnabled();
    expect(screen.getByRole('button', { name: t('app.diag.copy') })).toBeInTheDocument();
  });

  it('sans sauvegarde de ce démarrage, ou sans restauration possible ici : pas de troisième action', () => {
    const view = render(<DbFailureDetails failure={{ ...MIGRATION_FAILURE, updateBackup: null }} readEnvironment={readEnvironment} canRestore />);
    expect(screen.queryByRole('button', { name: tUpdateRestore('restore') })).toBeNull();
    view.unmount();
    render(<DbFailureDetails failure={MIGRATION_FAILURE} readEnvironment={readEnvironment} canRestore={false} />);
    expect(screen.queryByRole('button', { name: tUpdateRestore('restore') })).toBeNull();
  });

  it('navigateur de développement (jsdom) : restauration non proposée par défaut', () => {
    render(<DbFailureDetails failure={MIGRATION_FAILURE} readEnvironment={readEnvironment} />);
    expect(screen.queryByRole('button', { name: tUpdateRestore('restore') })).toBeNull();
  });
});

describe('critère 13 : service de restauration de l’écran d’échec', () => {
  const clock = { nowMs: () => Date.parse('2026-10-09T08:00:00.000Z') } as never;

  function fakeService(restore: BackupService['restore']): BackupService & { restarted: number } {
    const service = {
      restarted: 0,
      available: () => true,
      list: () => Promise.resolve({ directory: null, versions: [] }),
      createDaily: () => Promise.resolve({ created: true }),
      restore,
      restart: () => {
        service.restarted += 1;
        return Promise.resolve();
      },
    };
    return service;
  }

  it('réussite : nom et horodatage de la copie de sécurité transmis, issue mémorisée comme une restauration P-04, redémarrage', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const restore = vi.fn(() => Promise.resolve({ marker: 'written' as const, markerCode: null }));
    const service = fakeService(restore);
    await expect(restoreUpdateBackup(BACKUP, clock, service)).resolves.toEqual({ ok: true });
    expect(restore).toHaveBeenCalledWith({ name: BACKUP, stamp: '20261009T080000Z' });
    expect(service.restarted).toBe(1);
    expect(JSON.parse(localStorage.getItem('ct.restore.result') ?? 'null')).toMatchObject({ outcome: 'done', marker: 'written' });
    localStorage.clear();
  });

  it('marqueur de synchro non écrit : gardé pour un nouvel essai (P-04-iOS critère 12), la restauration reste faite', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const service = fakeService(() => Promise.resolve({ marker: 'failed', markerCode: 'io' }));
    await expect(restoreUpdateBackup(BACKUP, clock, service)).resolves.toEqual({ ok: true });
    expect(JSON.parse(localStorage.getItem('ct.restore.markerFailed') ?? 'null')).toMatchObject({ backup: BACKUP, code: 'io' });
    localStorage.clear();
  });

  it('échec : raison P-04, aucun redémarrage ; base fermée et io : « redémarrez » ; aucun service : message et code', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const service = fakeService(() => Promise.reject(new BackupError('corrupt')));
    await expect(restoreUpdateBackup(BACKUP, clock, service)).resolves.toEqual({ ok: false, message: t('backup.errorCorrupt'), code: 'corrupt' });
    expect(service.restarted).toBe(0);
    expect(updateRestoreFailureText('io', true)).toBe(t('backup.errorClosed'));
    expect(updateRestoreFailureText('db-open', false)).not.toBe('');
    await expect(restoreUpdateBackup(BACKUP, clock, null)).resolves.toEqual({ ok: false, message: tUpdateRestore('restoreUnavailable'), code: 'unavailable' });
  });
});

describe('critère 14 : base plus récente que l’app', () => {
  it('message de consigne (iPhone : SideStore ; PC : page des versions), jamais le message brut ; pas de restauration', () => {
    vi.stubGlobal('navigator', { ...navigator, userAgent: IPHONE });
    expect(failureAlertKey(NEWER_FAILURE, false)).toBe('app.update.schemaNewer');
    expect(t('app.update.schemaNewer')).toBe('Cette version de CircleTasks est plus ancienne que vos données. Installez la dernière version depuis SideStore. Vos données ne sont pas modifiées.');
    vi.stubGlobal('navigator', { ...navigator, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
    expect(failureAlertKey(NEWER_FAILURE, false)).toBe('app.update.schemaNewerPc');
    expect(t('app.update.schemaNewer')).not.toMatch(/inconnue de cette version/);
    // Même avec une sauvegarde par erreur dans l'état : jamais de restauration pour une base plus récente.
    render(<DbFailureDetails failure={{ ...NEWER_FAILURE, updateBackup: { name: BACKUP } }} readEnvironment={readEnvironment} canRestore />);
    expect(screen.queryByRole('button', { name: tUpdateRestore('restore') })).toBeNull();
    expect(screen.getByRole('button', { name: t('app.diag.copy') })).toBeInTheDocument();
  });

  it('autres échecs : messages existants inchangés', () => {
    expect(failureAlertKey({ phase: 'start', step: 'x', errorName: 'E', message: 'm' }, false)).toBe('app.startError');
    expect(failureAlertKey(MIGRATION_FAILURE, false)).toBe('app.dbError');
    expect(failureAlertKey({ ...MIGRATION_FAILURE, kind: 'backup' }, true)).toBe('app.dbBackupError');
    expect(failureAlertKey(null, false)).toBe('app.dbError');
  });
});

describe('critère 8 : « À propos » affiche la version sur l’iPhone', () => {
  const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000fb');

  async function renderAbout(os: 'ios' | 'windows', appVersion: Parameters<typeof createAppContainer>[0]['appVersion']) {
    const db = await openTestDb(DEVICE, '2026-10-09T08:00:00.000Z');
    const desktop = os === 'windows' ? ({ getVersion: () => Promise.resolve('0.3.0'), openLatestRelease: () => Promise.resolve() } as never) : null;
    const container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data, desktop, platform: { runtime: 'tauri', os }, ...(appVersion ? { appVersion } : {}) });
    render(
      <AppContainerProvider container={container}>
        <AboutSection />
      </AppContainerProvider>,
    );
    return db;
  }

  it('iPhone : « Version 0.3.0 », sans « Rechercher une mise à jour » ni lien de version', async () => {
    const db = await renderAbout('ios', { ok: true, version: '0.3.0', source: 'runtime' });
    expect(screen.getByText(t('app.version', { version: '0.3.0' }))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('settings.checkUpdates') })).toBeNull();
    expect(screen.queryByText(t('settings.latestRelease'))).toBeNull();
    await db.close();
  });

  it('version illisible : « Version inconnue » (jamais 0.0.0)', async () => {
    const db = await renderAbout('ios', { ok: false, version: null });
    expect(screen.getByText(t('app.versionUnknown'))).toBeInTheDocument();
    expect(screen.queryByText(/0\.0\.0/)).toBeNull();
    await db.close();
  });

  it('PC : même ligne de version, et la ligne de mise à jour reste', async () => {
    const db = await renderAbout('windows', { ok: true, version: '0.3.0', source: 'runtime' });
    expect(screen.getByText(t('app.version', { version: '0.3.0' }))).toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('settings.checkUpdates') })).toBeInTheDocument();
    await db.close();
  });
});
