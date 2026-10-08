import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../../domain/hlc';
import { asEntityId, type DeviceId } from '../../../domain/types';
import { openTestDb, type TestDb } from '../../../db/repositories/sql/testSetup';
import { createMemoryBackup } from '../../../platform/backup';
import { installLogJournal, logFailure } from '../../../platform/desktop/log';
import { createMemoryFiles } from '../../../platform/files';
import { createLogJournal, createMemoryLogTransport } from '../../../platform/logs';
import { defaultSyncLogger } from '../../../sync/log';
import { createAppContainer, type AppContainer } from '../../app/container';
import { saveFile } from '../../app/saveFile';
import { backupStore } from '../backupStore';
import { importStore } from '../importStore';
import { buildLogExport } from './logExport';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000fb');
const SENTINEL = 'TITRE-SECRET-123';

/**
 * I-04 critère 6 (même technique que l'audit B6 de la synchro) : un parcours avec des titres sentinelles déclenche des échecs réels
 * (import CSV, enregistrement de fichiers, sauvegarde et restauration, journal de la synchro, rappels) ; le journal persistant, son export
 * et le tampon de la session ne contiennent jamais la sentinelle. Scan et dictée n'écrivent rien au journal hors des plugins natifs
 * (CAP-IOS-01, lot C) : couverts par le contrôle des appels de `logFailure` (sanitize.test.ts, 40 entrées réelles).
 */
describe('I-04 critère 6 : aucune sentinelle de titre dans le journal', () => {
  let db: TestDb;
  let container: AppContainer;
  const transport = createMemoryLogTransport();
  const journal = createLogJournal(transport, { document: null, window: null });
  installLogJournal(journal);

  beforeEach(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    db = await openTestDb(DEVICE, '2026-10-08T08:00:00.000Z');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close();
  });

  it('parcours complet en échec : rien de la sentinelle dans le fichier, l’export ni le tampon', async () => {
    const files = createMemoryFiles();
    const backups = createMemoryBackup({ versions: [] });
    container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data, files, backups });

    // Import CSV (P-07) : rejets, enregistrement du rapport et du modèle en échec, import en échec réel (contrainte SQLite).
    const csv = ['titre;date;heure;espace;projet;note', `${SENTINEL} A;2026-10-09;;;;${SENTINEL} note`, `${SENTINEL} B;31/02/2026;;;;`, `${SENTINEL} C;;;Inconnu-${SENTINEL};;`].join('\n');
    files.setPick({ name: `${SENTINEL}.csv`, text: csv });
    const store = importStore.get(container);
    await store.getState().choose();
    files.failNext('write-failed', 'io');
    await store.getState().downloadReport();
    files.failNext('write-failed', 'unsafe-folder');
    await store.getState().downloadTemplate();
    const preview = store.getState().preview;
    expect(preview).not.toBeNull();
    if (!preview) return;
    const [first] = preview.validation.valid;
    if (!first) throw new Error('aperçu sans ligne valide');
    store.setState({ preview: { ...preview, validation: { ...preview.validation, valid: [{ ...first, spaceId: asEntityId('00000000-0000-4000-8000-00000000dead') }] } } });
    await store.getState().run();
    expect(store.getState().errorKey).toBe('importCsv.errorFailed');
    files.failNextPick('unreadable');
    await store.getState().choose();

    // Export H-03 : nom proposé et contenu porteurs de la sentinelle, enregistrement en échec.
    files.failNext('write-failed', 'io');
    await saveFile(files, { suggestedName: `circletasks-${SENTINEL}.csv`, mime: 'text/csv', data: new TextEncoder().encode(`${SENTINEL};2026-10-09`) }, 'export-save');

    // Sauvegarde et restauration (P-04) en échec.
    const backup = backupStore.get(container);
    backups.failNext('daily', 'io');
    await backup.getState().backupNow();
    backups.versions.push({ name: 'circletasks-daily-20261007.db', kind: 'daily', stamp: '20261007', size: 10, modifiedMs: 0, tasks: 1, schemaVersion: 17 });
    backups.failNext('restore', 'corrupt');
    await backup.getState().restore(backups.versions[0] ?? (() => { throw new Error('version'); })());
    expect(backup.getState().restorePhase).toBe('failed');

    // Synchro et rappels : leurs journaux ne portent que des codes et des compteurs.
    defaultSyncLogger.log('cycle-failed', { code: 'io', pending: 3 });
    logFailure('notifications', 'replan open: unreadable (3)');

    await journal.flush();
    const stored = JSON.stringify(transport.stored);
    expect(transport.stored.length).toBeGreaterThanOrEqual(8);
    expect(stored).not.toContain(SENTINEL);
    expect(stored).not.toContain('TITRE-SECRET');
    const read = await journal.read();
    expect(JSON.stringify(read)).not.toContain(SENTINEL);
    const exported = buildLogExport(read, { version: '0.2.0', os: 'ios', schemaVersion: 17, now: new Date('2026-10-08T08:00:00.000Z') });
    expect(exported.text).not.toContain(SENTINEL);
    expect(read.map((entry) => entry.scope)).toEqual(expect.arrayContaining(['import-report', 'import-template', 'import-run', 'import-pick', 'export-save', 'backup-now', 'backup-restore', 'sync', 'notifications']));
  });
});
