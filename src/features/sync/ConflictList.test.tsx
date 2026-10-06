import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import type { DeviceId, Hlc, IsoDateTime, LocalDate, SpaceId, TaskId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import type { SyncDeviceStatus } from '../../platform/sync/types';
import { AppContainerProvider } from '../app/AppContainerContext';
import { createAppContainer, type AppContainer } from '../app/container';
import { UndoToast } from '../app/UndoToast';
import { SyncDetailsScreen } from './SyncDetailsScreen';
import { createFakeSyncService, type FakeSyncService } from './testKit';

/**
 * Bloc « JOURNAL DES CONFLITS » (Y-04 critères 1, 3, 4, 8 et 14 ; Synchro.html) : absent sans conflit, une ligne par conflit (titre ·
 * champ, date, valeur gardée et écartée avec appareil et heure, « Restaurer »), résultat annoncé dans la ligne, focus gardé, refus
 * affiché en permanence, lecture impossible dite, « Afficher plus », annulation par le bandeau T-13.
 */

const SELF = '60000000-0000-4000-8000-0000000000e1' as DeviceId;
const IPHONE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as DeviceId;
const PRO = '00000000-0000-4000-8000-000000000001' as SpaceId;
const NOW = '2026-10-05T16:00:00.000Z';
const hlcAt = (iso: string, device: string): Hlc => `${String(Date.parse(iso)).padStart(15, '0')}-0000-${device}` as Hlc;

const devices: SyncDeviceStatus[] = [
  { deviceId: SELF, platform: 'windows', self: true, lastReadAt: NOW as IsoDateTime, status: 'active' },
  { deviceId: IPHONE, platform: 'ios', self: false, lastReadAt: NOW as IsoDateTime, status: 'active' },
];

let db: TestDb;
let container: AppContainer;
let sync: FakeSyncService;

beforeEach(async () => {
  db = await openTestDb(SELF, NOW);
  sync = createFakeSyncService({ phase: 'idle', lastSyncAt: NOW as IsoDateTime, devices, conflictsThisWeek: 1 });
  container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: SELF }), data: db.data, sync });
});

afterEach(async () => {
  cleanup();
  await db.close();
});

const renderScreen = () =>
  render(
    <AppContainerProvider container={container}>
      <SyncDetailsScreen />
      <UndoToast />
    </AppContainerProvider>,
  );

let n = 0;
async function task(title: string, time: string | null = '09:00'): Promise<TaskId> {
  n += 1;
  const created = await db.data.repos.tasks.create({
    id: `${String(n).padStart(8, '0')}-0000-4000-8000-0000000000e1` as TaskId,
    spaceId: PRO,
    projectId: null,
    title,
    note: '',
    date: '2026-10-05' as LocalDate,
    time: time as never,
    status: 'todo',
    doneAt: null,
    sortOrder: n,
    carriedOver: false,
    recurrenceId: null,
    seriesIndex: null,
    seriesTemplate: null,
    goalId: null,
    icon: null,
    someday: false,
    source: 'local',
    externalId: null,
    externalEventId: null,
  });
  return created.id;
}

async function conflict(rowId: string, field: string, kept: unknown, discarded: unknown, detectedAt = '2026-09-22T10:00:00.000Z'): Promise<void> {
  const keptHlc = hlcAt(new Date(2026, 8, 22, 18, 4).toISOString(), IPHONE);
  const discardedHlc = hlcAt(new Date(2026, 8, 22, 17, 58).toISOString(), SELF);
  await db.driver.execute(
    `INSERT INTO conflict_log (table_name, row_id, field, kept_value, discarded_value, kept_device, discarded_device, kept_hlc, discarded_hlc, detected_at)
     VALUES ('task', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [rowId, field, JSON.stringify(kept), JSON.stringify(discarded), IPHONE, SELF, keptHlc, discardedHlc, detectedAt],
  );
}

const list = () => screen.findByRole('list', { name: 'Journal des conflits' });

describe('journal des conflits (critères 1, 3 et 4)', () => {
  it('sans conflit : bloc absent, la ligne « Aucun conflit » suffit', async () => {
    sync.setStatus({ conflictsThisWeek: 0 });
    renderScreen();
    expect(await screen.findByText('Aucun conflit cette semaine')).toBeTruthy();
    // Laisse la lecture du journal se terminer : toujours rien sous la ligne de Y-02 (un seul titre de section).
    await act(async () => {
      await db.data.repos.sync.listConflicts('2020-01-01T00:00:00.000Z' as IsoDateTime, 1);
    });
    expect(screen.getAllByText('JOURNAL DES CONFLITS')).toHaveLength(1);
    expect(screen.queryByRole('list', { name: 'Journal des conflits' })).toBeNull();
  });

  it('une ligne par conflit d’après Synchro.html : « Envoyer la facture · heure », « 22 sept. », 09:00 gardée · iPhone · 18:04, 10:00 écartée · PC · 17:58, « Restaurer »', async () => {
    const id = await task('Envoyer la facture');
    await conflict(id, 'time', '09:00', '10:00');
    renderScreen();
    expect(screen.getAllByText('JOURNAL DES CONFLITS')).toHaveLength(1);
    const item = within(await list()).getByRole('listitem', { name: 'Conflit : Envoyer la facture, heure' });
    expect(within(item).getByText('Envoyer la facture · heure')).toBeTruthy();
    expect(within(item).getByText('22 sept.')).toBeTruthy();
    expect(item.textContent).toContain('09:00 gardée');
    expect(item.textContent).toContain('10:00 écartée');
    expect(within(item).getByText(/^iPhone · /).textContent).toMatch(/18:04/);
    expect(within(item).getByText(/^PC · /).textContent).toMatch(/17:58/);
    expect(within(item).getByRole('button', { name: 'Restaurer la valeur écartée : Envoyer la facture, heure' }).textContent).toBe('Restaurer');
  });

  it('texte entre « » ; élément supprimé ; « Afficher plus » au-delà de 50', async () => {
    const id = await task('Courses');
    await conflict(id, 'note', 'lait, œufs, café', 'lait, œufs');
    const gone = await task('Partie');
    await db.data.repos.tasks.softDelete([gone]);
    await conflict(gone, 'title', 'Partie', 'Partie 2');
    for (let i = 0; i < 50; i += 1) await conflict(id, 'title', `t${String(i)}`, `u${String(i)}`);
    renderScreen();
    const ul = await list();
    expect(within(ul).getAllByRole('listitem')).toHaveLength(50);
    fireEvent.click(screen.getByRole('button', { name: 'Afficher plus' }));
    await waitFor(() => expect(within(ul).getAllByRole('listitem')).toHaveLength(52));
    expect(screen.queryByRole('button', { name: 'Afficher plus' })).toBeNull();
    const notes = within(ul).getByRole('listitem', { name: 'Conflit : Courses, note' });
    expect(notes.textContent).toContain('« lait, œufs, café » gardée');
    expect(within(ul).getByRole('listitem', { name: 'Conflit : Élément supprimé, titre' })).toBeTruthy();
  });
});

describe('restauration à l’écran (critères 5, 6, 8 et 14)', () => {
  it('« Restaurer » : valeur restaurée annoncée dans la ligne, focus sur la ligne, « Restaurée le … », puis « Annuler »', async () => {
    const id = await task('Envoyer la facture');
    await conflict(id, 'time', '09:00', '10:00');
    renderScreen();
    const item = within(await list()).getByRole('listitem', { name: 'Conflit : Envoyer la facture, heure' });
    const button = within(item).getByRole('button', { name: /Restaurer la valeur écartée/ });
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(within(item).getByRole('status').textContent).toBe('Valeur restaurée : Envoyer la facture, heure'));
    await waitFor(() => expect(within(item).getByText('Restaurée le 5 oct.')).toBeTruthy());
    expect(within(item).queryByRole('button')).toBeNull();
    expect(document.activeElement).toBe(item);
    expect((await db.data.repos.tasks.getById(id))?.time).toBe('10:00');
    // Bandeau T-13 « Valeur restaurée · Annuler ».
    expect(screen.getByText('Valeur restaurée')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    await waitFor(() => expect(within(item).getByRole('button', { name: /Restaurer la valeur écartée/ })).toBeTruthy());
    expect((await db.data.repos.tasks.getById(id))?.time).toBe('09:00');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('élément purgé : refus affiché en permanence dans la ligne, rien d’écrit, aucune boîte bloquante', async () => {
    const purged = '11111111-1111-4111-8111-111111111111';
    await db.driver.execute("INSERT INTO sync_tombstone (table_name, row_id, deleted_hlc, purged_at) VALUES ('task', ?, ?, ?)", [purged, hlcAt(NOW, IPHONE), NOW]);
    await conflict(purged, 'title', 'A', 'B');
    renderScreen();
    const item = within(await list()).getByRole('listitem', { name: 'Conflit : Élément supprimé, titre' });
    const refusal = 'Cet élément n’existe plus : la valeur ne peut pas être restaurée';
    expect(within(item).getByRole('status').textContent).toBe(refusal);
    const button = within(item).getByRole('button', { name: /Restaurer/ });
    expect(button.getAttribute('aria-describedby')).toBe(within(item).getByRole('status').id);
    // La restauration passe par une transaction : on attend qu'elle soit terminée (aucun délai).
    const real = db.driver.transaction.bind(db.driver);
    const done: Promise<unknown>[] = [];
    db.driver.transaction = ((fn: Parameters<typeof real>[0]) => {
      const run = real(fn);
      done.push(run.catch(() => undefined));
      return run;
    }) as typeof db.driver.transaction;
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(done).toHaveLength(1));
    await act(async () => {
      await Promise.all(done);
    });
    db.driver.transaction = real as typeof db.driver.transaction;
    expect(await db.data.repos.sync.listConflicts('2020-01-01T00:00:00.000Z' as IsoDateTime, 5)).toMatchObject([{ restored: false }]);
    expect(within(item).getByRole('status').textContent).toBe(refusal);
    expect(document.activeElement).toBe(button);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await db.driver.select('SELECT COUNT(*) AS n FROM sync_outbox')).toEqual([{ n: 0 }]);
  });

  it('échec inattendu de la base : message dans la ligne, il reste tant que rien n’a réussi', async () => {
    const id = await task('Envoyer la facture');
    await conflict(id, 'time', '09:00', '10:00');
    renderScreen();
    const item = within(await list()).getByRole('listitem', { name: 'Conflit : Envoyer la facture, heure' });
    const real = db.driver.transaction.bind(db.driver);
    db.driver.transaction = (() => Promise.reject(new Error('base verrouillée'))) as typeof db.driver.transaction;
    fireEvent.click(within(item).getByRole('button', { name: /Restaurer/ }));
    await waitFor(() => expect(within(item).getByRole('status').textContent).toBe('La restauration a échoué. Rien n’a été modifié : réessayez.'));
    expect(within(item).getByRole('status').getAttribute('data-trouble')).toBe('true');
    db.driver.transaction = real as typeof db.driver.transaction;
    // Une relecture du journal (nouveau cycle) ne fait pas disparaître le message.
    await act(async () => {
      sync.setStatus({ lastSyncAt: '2026-10-05T16:05:00.000Z' as IsoDateTime });
    });
    expect(within(item).getByRole('status').textContent).toBe('La restauration a échoué. Rien n’a été modifié : réessayez.');
  });

  it('journal illisible : dit à l’écran (jamais seulement dans le journal technique)', async () => {
    (db.data.repos.syncConflicts as { listLog: unknown }).listLog = () => Promise.reject(new Error('lecture impossible'));
    renderScreen();
    expect((await screen.findByText(/Le journal des conflits n’a pas pu être lu/)).getAttribute('role')).toBe('status');
  });
});

describe('messages de la ligne (revue 3) et lignes illisibles', () => {
  /** Attend la fin de la transaction lancée par un clic (aucun délai : la promesse de la transaction elle-même). */
  function trackTransactions(): Promise<unknown>[] {
    const real = db.driver.transaction.bind(db.driver);
    const done: Promise<unknown>[] = [];
    db.driver.transaction = ((fn: Parameters<typeof real>[0]) => {
      const run = real(fn);
      done.push(run.catch(() => undefined));
      return run;
    }) as typeof db.driver.transaction;
    return done;
  }

  it('après « Annuler », le message « Valeur restaurée » disparaît de la ligne', async () => {
    const id = await task('Envoyer la facture');
    await conflict(id, 'time', '09:00', '10:00');
    renderScreen();
    const item = within(await list()).getByRole('listitem', { name: 'Conflit : Envoyer la facture, heure' });
    fireEvent.click(within(item).getByRole('button', { name: /Restaurer la valeur écartée/ }));
    await waitFor(() => expect(within(item).getByRole('status').textContent).toBe('Valeur restaurée : Envoyer la facture, heure'));
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    await waitFor(() => expect(within(item).getByRole('button', { name: /Restaurer la valeur écartée/ })).toBeTruthy());
    expect(within(item).getByRole('status').textContent).toBe('');
  });

  it('un refus passé ne masque pas le blocage recalculé : parent disparu, puis tâche purgée → « n’existe plus »', async () => {
    const project = '40000000-0000-4000-8000-0000000000e1';
    await db.driver.execute(
      "INSERT INTO project (id, space_id, name, color, sort_order, created_at, updated_at, device_id, hlc) VALUES (?, ?, 'Clients', '#2f6b7a', 1, ?, ?, ?, ?)",
      [project, PRO, NOW, NOW, SELF, hlcAt(NOW, SELF)],
    );
    const id = await task('Relancer');
    await conflict(id, 'project_id', null, project);
    renderScreen();
    const item = within(await list()).getByRole('listitem', { name: 'Conflit : Relancer, projet' });
    expect(within(item).getByRole('status').textContent).toBe('');
    // Le projet part à la corbeille sans que l'écran l'ait relu : « Restaurer » est refusé (parent disparu).
    await db.driver.execute('UPDATE project SET deleted_at = ? WHERE id = ?', [NOW, project]);
    const done = trackTransactions();
    fireEvent.click(within(item).getByRole('button', { name: /Restaurer/ }));
    await waitFor(() => expect(done).toHaveLength(1));
    await act(async () => {
      await Promise.all(done);
    });
    await waitFor(() => expect(within(item).getByRole('status').textContent).toBe('L’élément lié n’existe plus : la valeur ne peut pas être restaurée'));
    // La tâche est purgée ensuite : le blocage recalculé à la lecture suivante est « n’existe plus », pas l'ancien refus.
    await db.driver.execute("INSERT INTO sync_tombstone (table_name, row_id, deleted_hlc, purged_at) VALUES ('task', ?, ?, ?)", [id, hlcAt(NOW, SELF), NOW]);
    await db.driver.execute('DELETE FROM reminder WHERE target_id = ?', [id]);
    await db.driver.execute('DELETE FROM task WHERE id = ?', [id]);
    await act(async () => {
      sync.setStatus({ lastSyncAt: '2026-10-05T16:10:00.000Z' as IsoDateTime });
    });
    const purged = within(await list()).getByRole('listitem', { name: 'Conflit : Élément supprimé, projet' });
    await waitFor(() => expect(within(purged).getByRole('status').textContent).toBe('Cet élément n’existe plus : la valeur ne peut pas être restaurée'));
  });

  it('bouton occupé pendant la restauration : désactivé et aria-busy', async () => {
    const id = await task('Envoyer la facture');
    await conflict(id, 'time', '09:00', '10:00');
    renderScreen();
    const item = within(await list()).getByRole('listitem', { name: 'Conflit : Envoyer la facture, heure' });
    const button = within(item).getByRole('button', { name: /Restaurer la valeur écartée/ });
    fireEvent.click(button);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(within(item).getByText('Restaurée le 5 oct.')).toBeTruthy());
  });

  it('une ligne du journal illisible n’empêche pas d’afficher les autres ; elle est signalée', async () => {
    const id = await task('Envoyer la facture');
    await conflict(id, 'time', '09:00', '10:00');
    await db.driver.execute(
      "INSERT INTO conflict_log (table_name, row_id, field, kept_value, discarded_value, detected_at) VALUES ('task', ?, 'title', '{altéré', '\"x\"', ?)",
      [id, '2026-10-01T10:00:00.000Z'],
    );
    renderScreen();
    expect(within(await list()).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('1 conflit du journal est illisible et n’est pas affiché').getAttribute('role')).toBe('status');
  });
});
