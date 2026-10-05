import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import type { NewTask } from '../../domain/model';
import { asEntityId, type DeviceId, type LocalDate, type ProjectId, type TaskId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { createMemoryFiles, type MemoryFiles } from '../../platform/files';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { createAppContainer, type AppContainer } from '../app/container';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { ImportScreen } from './ImportScreen';
import { importStore } from './importStore';
import { createImportUseCases, IMPORT_BATCH_SIZE, type ImportPreview } from './importUseCases';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-0000000000f7');
const TODAY = '2026-10-02' as LocalDate;
const HEADER = 'titre;date;heure;espace;projet;note';

describe('Import CSV (P-07)', () => {
  let db: TestDb;
  let files: MemoryFiles;
  let container: AppContainer;

  beforeEach(async () => {
    db = await openTestDb(DEVICE, '2026-10-02T10:00:00.000Z');
    files = createMemoryFiles();
    container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data, files });
    useAppStore.getState().setSpaces(await container.data.repos.spaces.listAll());
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    useAppStore.setState({ spaceFilter: 'all', spaces: [], projects: [], projectFilter: null, day: null });
    useNavigationStore.setState(INITIAL_NAVIGATION);
    await db.close();
  });

  const taskCount = async (): Promise<number> => (await db.driver.select<{ n: number }>('SELECT COUNT(*) AS n FROM task WHERE deleted_at IS NULL'))[0]?.n ?? 0;

  async function addProject(name: string): Promise<ProjectId> {
    const id = asEntityId<ProjectId>('50000000-0000-4000-8000-000000000001');
    await db.data.repos.projects.create({ id, spaceId: SPACE_PRO_ID, name, color: '#2f6b7a' as never, archived: false, sortOrder: 1 });
    return id;
  }

  describe('cas d’usage (critères 4, 5, 7, 10)', () => {
    it('analyse puis import : tâches créées avec espace, projet, date, heure et note ; ordre du fichier en fin de liste', async () => {
      const projectId = await addProject('Mission client');
      const useCases = createImportUseCases(container);
      const text = `${HEADER}\nAppeler Paul;2026-10-03;10:00;Perso;;à rappeler\nRapport;03/10/2026;;Pro;Mission client;\nSans date;;;;;`;
      const analyzed = await useCases.analyze('taches.csv', text, 'today');
      expect(analyzed.ok).toBe(true);
      if (!analyzed.ok) return;
      expect(analyzed.preview.validation.valid).toHaveLength(3);
      await useCases.run(analyzed.preview);
      const tasks = await db.data.repos.tasks.listForDay('2026-10-03' as LocalDate, 'all');
      expect(tasks.map((task) => [task.title, task.spaceId, task.projectId, task.time, task.note])).toEqual([
        ['Appeler Paul', SPACE_PERSO_ID, null, '10:00', 'à rappeler'],
        ['Rapport', SPACE_PRO_ID, projectId, null, ''],
      ]);
      const today = await db.data.repos.tasks.listForDay(TODAY, 'all');
      expect(today.map((task) => task.title)).toEqual(['Sans date']);
      expect(tasks[0] && tasks[1] && tasks[0].sortOrder < tasks[1].sortOrder).toBe(true);
    });

    it('rappels par défaut seulement pour une tâche avec date et heure (comme une saisie à la main)', async () => {
      await db.data.repos.settings.set('reminders.defaultOffsets', [0, 15]);
      const useCases = createImportUseCases(container);
      const analyzed = await useCases.analyze('x.csv', `${HEADER}\nAvec heure;2026-10-03;09:30;;;\nSans heure;2026-10-03;;;;`, 'today');
      if (!analyzed.ok) throw new Error('analyse');
      const { created } = await useCases.run(analyzed.preview);
      const withTime = created.find((task) => task.title === 'Avec heure');
      const without = created.find((task) => task.title === 'Sans heure');
      expect((await db.data.repos.reminders.listForTarget({ type: 'task', id: withTime?.id as TaskId })).map((row) => row.offsetMin).sort()).toEqual([0, 15]);
      expect(await db.data.repos.reminders.listForTarget({ type: 'task', id: without?.id as TaskId })).toEqual([]);
    });

    it('« Un jour » pour les lignes sans date', async () => {
      const useCases = createImportUseCases(container);
      const analyzed = await useCases.analyze('x.csv', `${HEADER}\nÀ plus tard;;;;;\nDatée;2026-10-05;;;;`, 'someday');
      if (!analyzed.ok) throw new Error('analyse');
      await useCases.run(analyzed.preview);
      expect((await db.data.repos.tasks.listSomeday('all')).map((task) => task.title)).toEqual(['À plus tard']);
    });

    it('critère 10 : doublons (même titre et même date) comptés, jamais bloqués', async () => {
      const useCases = createImportUseCases(container);
      const text = `${HEADER}\nA;2026-10-03;;;;\nB;2026-10-03;;;;\nC;;;;;`;
      const first = await useCases.analyze('x.csv', text, 'today');
      if (!first.ok) throw new Error('analyse');
      expect(first.preview.duplicates).toBe(0);
      await useCases.run(first.preview);
      const second = await useCases.analyze('x.csv', text, 'today');
      if (!second.ok) throw new Error('analyse');
      expect(second.preview.duplicates).toBe(3); // C est aussi « aujourd’hui » : même titre, même date
      await useCases.run(second.preview);
      expect(await taskCount()).toBe(6);
    });

    it('critère 10 : un titre identique à une autre date, ou une tâche supprimée, n’est pas un doublon', async () => {
      const useCases = createImportUseCases(container);
      const first = await useCases.analyze('x.csv', `${HEADER}\nA;2026-10-03;;;;`, 'today');
      if (!first.ok) throw new Error('analyse');
      const { created } = await useCases.run(first.preview);
      const other = await useCases.analyze('x.csv', `${HEADER}\nA;2026-10-04;;;;`, 'today');
      if (!other.ok) throw new Error('analyse');
      expect(other.preview.duplicates).toBe(0);
      await db.data.repos.tasks.softDelete(created.map((task) => task.id));
      const again = await useCases.analyze('x.csv', `${HEADER}\nA;2026-10-03;;;;`, 'today');
      if (!again.ok) throw new Error('analyse');
      expect(again.preview.duplicates).toBe(0);
    });

    it('critère 7 : un seul « Annuler » (et Ctrl+Z) retire toutes les tâches importées d’un coup', async () => {
      const useCases = createImportUseCases(container);
      const analyzed = await useCases.analyze('x.csv', `${HEADER}\nA;;;;;\nB;;;;;\nC;;;;;`, 'today');
      if (!analyzed.ok) throw new Error('analyse');
      await useCases.run(analyzed.preview);
      expect(await taskCount()).toBe(3);
      expect(container.undo.getSnapshot().size).toBe(1);
      expect(container.undo.getSnapshot().top?.labelParams).toEqual({ count: 3 });
      expect(await container.undo.undoLast()).toMatchObject({ status: 'undone' });
      expect(await taskCount()).toBe(0);
    });

    it('critère 7 : annuler écarte aussi les rappels du lot, et laisse en place une tâche modifiée depuis (filtre hlc)', async () => {
      await db.data.repos.settings.set('reminders.defaultOffsets', [0]);
      const useCases = createImportUseCases(container);
      const analyzed = await useCases.analyze('x.csv', `${HEADER}\nA;2026-10-03;09:00;;;\nB;2026-10-03;10:00;;;\nC;2026-10-03;;;;`, 'today');
      if (!analyzed.ok) throw new Error('analyse');
      const { created } = await useCases.run(analyzed.preview);
      const liveReminders = async (): Promise<number> => (await db.driver.select<{ n: number }>('SELECT COUNT(*) AS n FROM reminder WHERE deleted_at IS NULL'))[0]?.n ?? 0;
      expect(await liveReminders()).toBe(2);
      // B est modifiée après l'import : son hlc change, elle n'est pas retirée.
      db.clock.advance(1000);
      await db.data.repos.tasks.update(created[1]?.id as TaskId, { note: 'modifiée' });
      expect(await container.undo.undoLast()).toMatchObject({ status: 'undone' });
      expect((await db.data.repos.tasks.getById(created[0]?.id as TaskId))).toBeNull();
      expect((await db.data.repos.tasks.getById(created[1]?.id as TaskId))?.note).toBe('modifiée');
      expect((await db.data.repos.tasks.getById(created[2]?.id as TaskId))).toBeNull();
      expect(await liveReminders()).toBe(1); // seul le rappel de B reste
    });

    it('critère 7 : toutes les tâches modifiées depuis -> « stale », rien n’est retiré', async () => {
      const useCases = createImportUseCases(container);
      const analyzed = await useCases.analyze('x.csv', `${HEADER}\nA;;;;;`, 'today');
      if (!analyzed.ok) throw new Error('analyse');
      const { created } = await useCases.run(analyzed.preview);
      db.clock.advance(1000);
      await db.data.repos.tasks.update(created[0]?.id as TaskId, { note: 'x' });
      expect(await container.undo.undoLast()).toMatchObject({ status: 'stale' });
      expect(await taskCount()).toBe(1);
    });

    it('critère 7 : tout ou rien — un échec au deuxième lot ne laisse aucune tâche', async () => {
      const useCases = createImportUseCases(container);
      const analyzed = await useCases.analyze('x.csv', `${HEADER}\n${Array.from({ length: IMPORT_BATCH_SIZE + 1 }, (_, i) => `T${String(i)};;;;;`).join('\n')}`, 'today');
      if (!analyzed.ok) throw new Error('analyse');
      const drafts = analyzed.preview.validation.valid;
      const broken: ImportPreview = {
        ...analyzed.preview,
        validation: { ...analyzed.preview.validation, valid: [...drafts.slice(0, IMPORT_BATCH_SIZE), { ...(drafts[IMPORT_BATCH_SIZE] as NonNullable<(typeof drafts)[number]>), spaceId: asEntityId('00000000-0000-4000-8000-00000000dead') }] },
      };
      await expect(useCases.run(broken)).rejects.toBeDefined();
      expect(await taskCount()).toBe(0);
      expect(container.undo.getSnapshot().size).toBe(0);
    });

    it('critère 12 : l’avancement est signalé à chaque lot', async () => {
      const useCases = createImportUseCases(container);
      const total = IMPORT_BATCH_SIZE * 2 + 5;
      const analyzed = await useCases.analyze('x.csv', `${HEADER}\n${Array.from({ length: total }, (_, i) => `T${String(i)};;;;;`).join('\n')}`, 'today');
      if (!analyzed.ok) throw new Error('analyse');
      const progress = vi.fn();
      await useCases.run(analyzed.preview, progress);
      expect(progress.mock.calls).toEqual([
        [IMPORT_BATCH_SIZE, total],
        [IMPORT_BATCH_SIZE * 2, total],
        [total, total],
      ]);
      expect(await taskCount()).toBe(total);
    });

    it('critère 2 : colonne titre absente, fichier vide, trop de lignes', async () => {
      const useCases = createImportUseCases(container);
      expect(await useCases.analyze('x.csv', 'date;heure\n2026-10-03;10:00', 'today')).toEqual({ ok: false, error: 'no-title-column' });
      expect(await useCases.analyze('x.csv', '', 'today')).toEqual({ ok: false, error: 'empty' });
      expect(await useCases.analyze('x.csv', `titre\n${Array.from({ length: 5001 }, () => 'x').join('\n')}`, 'today')).toEqual({ ok: false, error: 'too-many-rows' });
    });

    it('filtre Pro / Perso / Tout : l’espace par défaut des lignes sans espace suit le filtre actif (ES-02)', async () => {
      useAppStore.setState({ spaceFilter: SPACE_PERSO_ID });
      const useCases = createImportUseCases(container);
      const analyzed = await useCases.analyze('x.csv', `${HEADER}\nA;;;;;\nB;;;Pro;;`, 'today');
      if (!analyzed.ok) throw new Error('analyse');
      expect(analyzed.preview.validation.valid.map((draft) => draft.spaceName)).toEqual(['Perso', 'Pro']);
    });
  });

  describe('écran (critères 1, 3, 5, 6, 7, 8, 13, 14)', () => {
    const renderScreen = () =>
      render(
        <AppContainerProvider container={container}>
          <ImportScreen />
        </AppContainerProvider>,
      );
    const click = (element: HTMLElement) => act(async () => void fireEvent.click(element));
    const csv = `${HEADER}\nAppeler Paul;2026-10-03;10:00;Perso;;\nRapport;03/10/2026;;Pro;Inconnu;\n;2026-10-03;;;;\nSoirée;31/02/2026;;;;\nHeure seule;;09:00;;;\nAilleurs;;;Famille;;`;

    it('critère 1 : choisir un fichier, télécharger un modèle et rappel des colonnes', async () => {
      renderScreen();
      expect(screen.getByRole('heading', { level: 1, name: 'Importer des tâches' })).toBeInTheDocument();
      expect(screen.getByText('titre;date;heure;espace;projet;note')).toBeInTheDocument();
      // Critère 14 : la région d'annonce des compteurs existe dès l'ouverture, vide et sans nom accessible.
      const region = screen.getByRole('status');
      expect(region).toBeEmptyDOMElement();
      expect(region).not.toHaveAttribute('aria-label');
      expect(screen.getByRole('button', { name: 'Choisir un fichier' })).toBeEnabled();
      await click(screen.getByRole('button', { name: 'Télécharger un modèle' }));
      await waitFor(() => expect(files.saved).toHaveLength(1));
      expect(files.saved[0]?.suggestedName).toBe('circletasks-modele-import.csv');
      expect(new TextDecoder().decode(files.saved[0]?.data)).toContain('titre;date;heure;espace;projet;note\r\nAppeler Paul;2026-10-03;10:00;Pro;;\r\n');
      expect(await screen.findByText('Modèle enregistré')).toBeInTheDocument();
    });

    it('critères 3, 4, 5 : compteurs, tableau avec en-têtes, rejets avec numéro de ligne et motif, avertissements', async () => {
      files.setPick({ name: 'taches.csv', text: csv });
      renderScreen();
      await click(screen.getByRole('button', { name: 'Choisir un fichier' }));
      expect(await screen.findByText('2 tâches à importer · 4 lignes rejetées · 1 avertissement')).toHaveAttribute('role', 'status');
      const table = screen.getByRole('table');
      expect(within(table).getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual(['Titre', 'Date', 'Heure', 'Espace', 'Projet']);
      expect(within(table).getAllByRole('row').slice(1).map((row) => row.textContent)).toEqual(['Appeler Paulsam. 3 oct.10:00Perso', 'Rapportsam. 3 oct.Pro']);
      expect(screen.getByText('Ligne 4 : titre vide')).toBeInTheDocument();
      expect(screen.getByText('Ligne 5 : date invalide « 31/02/2026 »')).toBeInTheDocument();
      expect(screen.getByText('Ligne 6 : heure sans date « 09:00 »')).toBeInTheDocument();
      expect(screen.getByText('Ligne 7 : espace inconnu « Famille »')).toBeInTheDocument();
      expect(screen.getByText('Ligne 3 : projet inconnu « Inconnu », tâche importée sans projet')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Importer 2 tâches' })).toBeEnabled();
      // Le fichier d’origine n’est pas écrit tant que rien n’est validé.
      expect(await taskCount()).toBe(0);
    });

    it('critère 3 : « Importer N tâches » est inactif quand aucune ligne n’est valide', async () => {
      files.setPick({ name: 'x.csv', text: `${HEADER}\n;;;;;titre vide\nA;31/02/2026;;;;` });
      renderScreen();
      await click(screen.getByRole('button', { name: 'Choisir un fichier' }));
      expect(await screen.findByText('0 tâche à importer · 2 lignes rejetées · 0 avertissement')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Importer 0 tâches' })).toBeDisabled();
      expect(screen.getByText('Aucune tâche à importer dans ce fichier.')).toBeInTheDocument();
    });

    it('critère 4 : le choix « Un jour » des tâches sans date met l’aperçu à jour', async () => {
      files.setPick({ name: 'x.csv', text: `${HEADER}\nSans date;;;;;` });
      renderScreen();
      await click(screen.getByRole('button', { name: 'Choisir un fichier' }));
      const table = await screen.findByRole('table');
      expect(within(table).getByText('ven. 2 oct.')).toBeInTheDocument();
      await click(screen.getByRole('radio', { name: 'Un jour' }));
      await waitFor(() => expect(within(screen.getByRole('table')).getByText('Un jour')).toBeInTheDocument());
    });

    it('critère 6 : le rapport des lignes rejetées est proposé à l’enregistrement (ligne d’origine + motif)', async () => {
      files.setPick({ name: 'taches.csv', text: csv });
      renderScreen();
      await click(screen.getByRole('button', { name: 'Choisir un fichier' }));
      await click(await screen.findByRole('button', { name: 'Télécharger le rapport des lignes rejetées' }));
      await waitFor(() => expect(files.saved).toHaveLength(1));
      const report = new TextDecoder().decode(files.saved[0]?.data);
      expect(files.saved[0]?.suggestedName).toBe('circletasks-import-lignes-rejetees.csv');
      expect(report).toContain('ligne;motif;titre;date;heure;espace;projet;note');
      expect(report).toContain('5;date invalide « 31/02/2026 »;Soirée;31/02/2026;;;;');
      expect(report).toContain('7;espace inconnu « Famille »;Ailleurs;;;Famille;;');
      expect(await screen.findByText('Rapport enregistré')).toBeInTheDocument();
    });

    it('critères 7 et 8 : import, message « 2 tâches importées », « Voir dans Aujourd’hui », un seul Annuler', async () => {
      files.setPick({ name: 'taches.csv', text: csv });
      renderScreen();
      await click(screen.getByRole('button', { name: 'Choisir un fichier' }));
      await click(await screen.findByRole('button', { name: 'Importer 2 tâches' }));
      expect(await screen.findByText('2 tâches importées')).toHaveAttribute('role', 'status');
      expect(await taskCount()).toBe(2);
      expect(container.undo.getSnapshot().top?.labelKey).toBe('importCsv.undoLabel');
      await click(screen.getByRole('button', { name: 'Voir dans Aujourd’hui' }));
      expect(useNavigationStore.getState().route).toMatchObject({ tab: 'tasks', screen: 'today' });
    });

    it('une seule tâche : singulier', async () => {
      files.setPick({ name: 'x.csv', text: `${HEADER}\nSeule;;;;;` });
      renderScreen();
      await click(screen.getByRole('button', { name: 'Choisir un fichier' }));
      expect(await screen.findByText('1 tâche à importer · 0 ligne rejetée · 0 avertissement')).toBeInTheDocument();
      await click(screen.getByRole('button', { name: 'Importer 1 tâche' }));
      expect(await screen.findByText('1 tâche importée')).toBeInTheDocument();
    });

    it('critère 10 : avertissement « N tâches existent déjà »', async () => {
      const useCases = createImportUseCases(container);
      const first = await useCases.analyze('x.csv', `${HEADER}\nA;2026-10-03;;;;\nB;2026-10-03;;;;`, 'today');
      if (!first.ok) throw new Error('analyse');
      await useCases.run(first.preview);
      files.setPick({ name: 'x.csv', text: `${HEADER}\nA;2026-10-03;;;;\nB;2026-10-03;;;;\nC;2026-10-03;;;;` });
      renderScreen();
      await click(screen.getByRole('button', { name: 'Choisir un fichier' }));
      expect(await screen.findByText('2 tâches existent déjà (même titre et même date) : elles seront créées en double.')).toBeInTheDocument();
      expect(screen.getByText('3 tâches à importer · 0 ligne rejetée · 1 avertissement')).toBeInTheDocument();
    });

    it('critère 2 : messages pour un fichier sans colonne titre, trop gros, illisible', async () => {
      files.setPick({ name: 'x.csv', text: 'date;heure\n2026-10-03;10:00' });
      renderScreen();
      await click(screen.getByRole('button', { name: 'Choisir un fichier' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('La colonne « titre » est absente : rien ne peut être importé.');
      files.failNextPick('too-large');
      await click(screen.getByRole('button', { name: 'Choisir un fichier' }));
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Le fichier dépasse 2 Mo'));
      files.failNextPick('unreadable');
      await click(screen.getByRole('button', { name: 'Choisir un fichier' }));
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Impossible de lire ce fichier.'));
    });

    it('annuler la boîte de choix ne change rien', async () => {
      files.setPick(null);
      renderScreen();
      await click(screen.getByRole('button', { name: 'Choisir un fichier' }));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Choisir un fichier' })).toBeEnabled();
    });

    it('critère 13 : sans enregistrement de fichier (iPhone), le modèle et le rapport sont masqués mais le choix reste possible', async () => {
      const phone = createMemoryFiles({ canSave: false });
      phone.setPick({ name: 'x.csv', text: csv });
      const c = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data, files: phone });
      render(
        <AppContainerProvider container={c}>
          <ImportScreen />
        </AppContainerProvider>,
      );
      expect(screen.queryByRole('button', { name: 'Télécharger un modèle' })).not.toBeInTheDocument();
      await click(screen.getByRole('button', { name: 'Choisir un fichier' }));
      await screen.findByText('2 tâches à importer · 4 lignes rejetées · 1 avertissement');
      expect(screen.queryByRole('button', { name: 'Télécharger le rapport des lignes rejetées' })).not.toBeInTheDocument();
    });

    it('le store est isolé par conteneur', () => {
      const other = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data });
      expect(importStore.get(other)).not.toBe(importStore.get(container));
    });
  });

  it('NewTask importée : toutes les colonnes d’une tâche locale', async () => {
    const useCases = createImportUseCases(container);
    const analyzed = await useCases.analyze('x.csv', `${HEADER}\nA;2026-10-03;;;;`, 'today');
    if (!analyzed.ok) throw new Error('analyse');
    const { created } = await useCases.run(analyzed.preview);
    const task: NewTask | undefined = created[0];
    expect(task).toMatchObject({ status: 'todo', source: 'local', recurrenceId: null, goalId: null, someday: false, carriedOver: false });
  });
});
