import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHlcClock } from '../../domain/hlc';
import type { Task } from '../../domain/model';
import { asEntityId, asLocalDate, asLocalTime, type DeviceId, type ReminderId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { AppContainerProvider } from '../app/AppContainerContext';
import { UndoToast } from '../app/UndoToast';
import { useAppStore } from '../app/appStore';
import { createAppContainer, type AppContainer } from '../app/container';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { createTaskUseCases } from './createTaskUseCases';
import { TaskDetail } from './TaskDetail';

const DEVICE = asEntityId<DeviceId>('60000000-0000-4000-8000-000000000a08');
const NOW = new Date(2026, 8, 23, 20, 0).getTime();

function mockViewport(width: number): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width >= 1024 && query.includes('min-width: 1024px'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

describe('Fiche détail d’une tâche (A-08)', () => {
  let db: TestDb;
  let container: AppContainer;

  beforeEach(async () => {
    db = await openTestDb(DEVICE, NOW);
    container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: DEVICE }), data: db.data });
    useAppStore.getState().setSpaces(await container.data.repos.spaces.listAll());
  });
  afterEach(async () => {
    cleanup();
    vi.unstubAllGlobals();
    useAppStore.setState({ spaces: [], day: null });
    useNavigationStore.setState(INITIAL_NAVIGATION);
    await db.close();
  });

  async function open(over: Partial<Parameters<ReturnType<typeof createTaskUseCases>['create']>[0]> = {}): Promise<Task> {
    const created = await createTaskUseCases(container).create({
      title: 'Envoyer la facture',
      spaceId: SPACE_PRO_ID,
      date: asLocalDate('2026-09-23'),
      time: asLocalTime('09:00'),
      note: 'Joindre le relevé',
      ...over,
    });
    if (!created.ok) throw new Error('création impossible');
    useNavigationStore.getState().openDetail({ type: 'task', id: created.value.id });
    render(
      <AppContainerProvider container={container}>
        <TaskDetail />
        <UndoToast />
      </AppContainerProvider>,
    );
    await screen.findByText('Joindre le relevé', { selector: 'textarea' });
    return created.value;
  }

  const stored = async (id: string): Promise<Task | null> => db.data.repos.tasks.getById(id as never);

  describe('PC : panneau et édition sur place', () => {
    beforeEach(() => mockViewport(1440));

    it('affiche titre, date, heure, répétition, rappels, espace, projet, objectif, note et horodatage (critère 5)', async () => {
      const task = await open();
      await db.data.repos.reminders.replaceForTarget({ type: 'task', id: task.id }, [
        { id: asEntityId<ReminderId>('50000000-0000-4000-8000-0000000000a1'), targetType: 'task', targetId: task.id, offsetMin: 0, fireAt: '2026-09-23T09:00' as never },
        { id: asEntityId<ReminderId>('50000000-0000-4000-8000-0000000000a2'), targetType: 'task', targetId: task.id, offsetMin: 30, fireAt: '2026-09-23T08:30' as never },
      ]);
      cleanup();
      useNavigationStore.getState().openDetail({ type: 'task', id: task.id });
      render(
        <AppContainerProvider container={container}>
          <TaskDetail />
        </AppContainerProvider>,
      );
      const panel = await screen.findByRole('complementary', { name: 'Détail de la tâche' });
      expect(within(panel).getByRole('heading', { name: 'Envoyer la facture' })).toBeInTheDocument();
      await waitFor(() => expect(within(panel).getByText('À l’heure')).toBeInTheDocument());
      expect(within(panel).getByText('30 min avant')).toBeInTheDocument();
      expect(within(panel).getByLabelText('Date de la tâche')).toHaveValue('Aujourd’hui 09:00');
      expect(within(panel).getByLabelText('Heure')).toHaveValue('09:00');
      expect(within(panel).getByTestId('recurrence-detail')).toHaveTextContent('Une fois');
      expect(within(panel).getByRole('button', { name: 'Pro' })).toHaveAttribute('aria-pressed', 'true');
      expect(within(panel).getByText('Projet')).toBeInTheDocument();
      expect(within(panel).getByText('Non rattachée')).toBeInTheDocument();
      expect(within(panel).getByLabelText('Note')).toHaveValue('Joindre le relevé');
      expect(panel).toHaveTextContent(/Créée le aujourd’hui à \d\d:\d\d · modifiée aujourd’hui à \d\d:\d\d/);
      // Boutons : Reporter, Un jour, Dupliquer, Supprimer ; pas de Focus tant que M10 n'existe pas.
      expect(within(panel).getByRole('button', { name: 'Reporter' })).toBeInTheDocument();
      expect(within(panel).getByRole('button', { name: 'Un jour' })).toBeInTheDocument();
      expect(within(panel).getByRole('button', { name: 'Dupliquer la tâche' })).toBeInTheDocument();
      expect(within(panel).getByRole('button', { name: 'Supprimer' })).toBeInTheDocument();
      expect(within(panel).queryByRole('button', { name: /Focus/ })).toBeNull();
    });

    it('sans heure : « Sans heure » (placeholder), et rappels « Aucun » (critère 5)', async () => {
      await open({ time: null as never });
      const panel = screen.getByRole('complementary', { name: 'Détail de la tâche' });
      expect(within(panel).getByLabelText('Heure')).toHaveValue('');
      expect(within(panel).getByLabelText('Heure')).toHaveAttribute('placeholder', 'Sans heure');
      expect(within(panel).getAllByText('Aucun')).toHaveLength(2); // rappels et projet
    });

    it('le titre se modifie sur place : Entrée valide et enregistre aussitôt (critère 8)', async () => {
      const task = await open();
      fireEvent.click(screen.getByRole('heading', { name: 'Envoyer la facture' }));
      const field = screen.getByLabelText('Titre de la tâche');
      fireEvent.change(field, { target: { value: '  Envoyer la facture client ' } });
      fireEvent.submit(field.closest('form') as HTMLFormElement);
      await waitFor(async () => expect((await stored(task.id))?.title).toBe('Envoyer la facture client'));
      expect(await screen.findByRole('heading', { name: 'Envoyer la facture client' })).toBeInTheDocument();
    });

    it('un titre vidé est refusé : la valeur précédente est rétablie avec un message (critère 10)', async () => {
      const task = await open();
      fireEvent.click(screen.getByRole('heading', { name: 'Envoyer la facture' }));
      const field = screen.getByLabelText('Titre de la tâche');
      fireEvent.change(field, { target: { value: '   ' } });
      fireEvent.submit(field.closest('form') as HTMLFormElement);
      expect(await screen.findByRole('alert')).toHaveTextContent('Le titre doit contenir entre 1 et 200 caractères.');
      expect((await stored(task.id))?.title).toBe('Envoyer la facture');
      expect(screen.getByRole('heading', { name: 'Envoyer la facture' })).toBeInTheDocument();
    });

    it('Échap annule la saisie du titre sans fermer la fiche, puis un second Échap la ferme (critère 8)', async () => {
      const task = await open();
      fireEvent.click(screen.getByRole('heading', { name: 'Envoyer la facture' }));
      fireEvent.change(screen.getByLabelText('Titre de la tâche'), { target: { value: 'Autre' } });
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByLabelText('Titre de la tâche')).toBeNull());
      expect(screen.getByRole('complementary', { name: 'Détail de la tâche' })).toBeInTheDocument();
      expect((await stored(task.id))?.title).toBe('Envoyer la facture');
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull());
    });

    it('l’heure se modifie sur place (« 10h30 »), se vide, et refuse une valeur invalide (critère 8)', async () => {
      const task = await open();
      const field = screen.getByLabelText('Heure');
      fireEvent.change(field, { target: { value: '10h30' } });
      fireEvent.submit(field.closest('form') as HTMLFormElement);
      await waitFor(async () => expect((await stored(task.id))?.time).toBe('10:30'));
      await waitFor(() => expect(screen.getByLabelText('Heure')).toHaveValue('10:30'));

      fireEvent.change(screen.getByLabelText('Heure'), { target: { value: '25h' } });
      fireEvent.submit(screen.getByLabelText('Heure').closest('form') as HTMLFormElement);
      expect(await screen.findByRole('alert')).toHaveTextContent('Heure non comprise');
      expect((await stored(task.id))?.time).toBe('10:30');

      fireEvent.change(screen.getByLabelText('Heure'), { target: { value: '' } });
      fireEvent.submit(screen.getByLabelText('Heure').closest('form') as HTMLFormElement);
      await waitFor(async () => expect((await stored(task.id))?.time).toBeNull());
    });

    it('Échap annule une heure en cours de saisie sans fermer la fiche', async () => {
      await open();
      fireEvent.change(screen.getByLabelText('Heure'), { target: { value: '11' } });
      fireEvent.keyDown(screen.getByLabelText('Heure'), { key: 'Escape' });
      expect(screen.getByLabelText('Heure')).toHaveValue('09:00');
      expect(screen.getByRole('complementary', { name: 'Détail de la tâche' })).toBeInTheDocument();
    });

    it('la date se modifie dans le champ « Date de la tâche » (saisie libre, Entrée) (critère 8)', async () => {
      const task = await open();
      const field = screen.getByLabelText('Date de la tâche');
      fireEvent.change(field, { target: { value: 'demain' } });
      fireEvent.keyDown(field, { key: 'Enter' });
      await waitFor(async () => expect((await stored(task.id))?.date).toBe('2026-09-24'));
      expect((await stored(task.id))?.time).toBeNull();
    });

    it('l’espace se change d’un clic (critère 8)', async () => {
      const task = await open();
      fireEvent.click(within(screen.getByRole('group', { name: 'Espace de la tâche' })).getByRole('button', { name: 'Perso' }));
      await waitFor(async () => expect((await stored(task.id))?.spaceId).toBe(SPACE_PERSO_ID));
      expect(screen.getByRole('button', { name: 'Perso' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('« Un jour » range la tâche, annulable ; absent pour une tâche terminée ou déjà rangée (critère 6)', async () => {
      const task = await open();
      fireEvent.click(screen.getByRole('button', { name: 'Un jour' }));
      await waitFor(async () => expect(await stored(task.id)).toMatchObject({ someday: true, date: null, time: null }));
      expect(await screen.findByRole('status')).toHaveTextContent('« Envoyer la facture » rangée dans « Un jour »');
      expect(screen.queryByRole('button', { name: 'Un jour' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
      await waitFor(async () => expect(await stored(task.id)).toMatchObject({ someday: false, date: '2026-09-23', time: '09:00' }));
    });

    it('terminée : « Reporter » et « Un jour » disparaissent, le bouton passe à l’état « terminée » (critère 7)', async () => {
      await open();
      fireEvent.click(screen.getByRole('button', { name: 'Marquer comme terminée' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Marquer comme terminée' })).toHaveAttribute('aria-pressed', 'true'));
      expect(screen.queryByRole('button', { name: 'Reporter' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Un jour' })).toBeNull();
    });

    it('rôle complementary « Détail de la tâche » ; Échap ferme (critères 3, 11)', async () => {
      await open();
      expect(screen.getByRole('complementary', { name: 'Détail de la tâche' })).toBeInTheDocument();
      act(() => {
        fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
      });
      await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull());
    });
  });

  describe('iPhone : feuille plein écran et « Modifier » (Q15)', () => {
    beforeEach(() => mockViewport(440));

    it('feuille modale avec lignes en lecture seule ; la note reste modifiable (critères 2, 9, 11)', async () => {
      await open();
      const sheet = screen.getByRole('dialog', { name: 'Détail de la tâche' });
      expect(sheet).toHaveAttribute('aria-modal', 'true');
      expect(within(sheet).getByText('Date · heure')).toBeInTheDocument();
      expect(within(sheet).getByText('Mer. 23 sept. 2026 · 09:00')).toBeInTheDocument();
      expect(within(sheet).queryByLabelText('Date de la tâche')).toBeNull();
      expect(within(sheet).getByText('Espace · projet')).toBeInTheDocument();
      expect(within(sheet).getByLabelText('Note')).toBeEnabled();
      expect(within(sheet).getByRole('button', { name: 'Modifier' })).toBeInTheDocument();
      expect(within(sheet).getByRole('button', { name: 'Marquer comme terminée' })).toBeInTheDocument();
    });

    it('« Modifier » ouvre la feuille « Modifier la tâche » pré-remplie ; Enregistrer applique, la fiche se rafraîchit', async () => {
      const task = await open();
      fireEvent.click(screen.getByRole('button', { name: 'Modifier' }));
      const edit = await screen.findByRole('dialog', { name: 'Modifier la tâche' });
      expect(within(edit).getByLabelText('Titre')).toHaveValue('Envoyer la facture');
      expect(within(edit).getByRole('button', { name: 'Pro' })).toHaveAttribute('aria-pressed', 'true');
      fireEvent.change(within(edit).getByLabelText('Titre'), { target: { value: 'Facture client' } });
      fireEvent.click(within(edit).getByRole('button', { name: 'Perso' }));
      fireEvent.click(within(edit).getByRole('button', { name: 'Enregistrer' }));
      await waitFor(async () => expect(await stored(task.id)).toMatchObject({ title: 'Facture client', spaceId: SPACE_PERSO_ID }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Modifier la tâche' })).toBeNull());
      expect(screen.getByRole('heading', { name: 'Facture client' })).toBeInTheDocument();
    });

    it('fermer la feuille sans enregistrer ne change rien ; un titre vide désactive Enregistrer', async () => {
      const task = await open();
      fireEvent.click(screen.getByRole('button', { name: 'Modifier' }));
      const edit = await screen.findByRole('dialog', { name: 'Modifier la tâche' });
      fireEvent.change(within(edit).getByLabelText('Titre'), { target: { value: 'Abandonné' } });
      fireEvent.change(within(edit).getByLabelText('Titre'), { target: { value: '  ' } });
      expect(within(edit).getByRole('button', { name: 'Enregistrer' })).toBeDisabled();
      fireEvent.change(within(edit).getByLabelText('Titre'), { target: { value: 'Abandonné' } });
      fireEvent.click(within(edit).getByRole('button', { name: 'Fermer' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Modifier la tâche' })).toBeNull());
      expect((await stored(task.id))?.title).toBe('Envoyer la facture');
    });

    it('« Modifier » une occurrence récurrente pose la question « cette occurrence / toutes les suivantes »', async () => {
      const task = await open({ recurrence: { freq: 'monthly', interval: 1, weekdays: [], monthDay: 23, nthWeekday: null, until: null, count: null } });
      fireEvent.click(screen.getByRole('button', { name: 'Modifier' }));
      const edit = await screen.findByRole('dialog', { name: 'Modifier la tâche' });
      fireEvent.change(within(edit).getByLabelText('Titre'), { target: { value: 'Loyer' } });
      fireEvent.click(within(edit).getByRole('button', { name: 'Enregistrer' }));
      const dialog = await screen.findByRole('alertdialog');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cette occurrence' }));
      await waitFor(async () => expect((await stored(task.id))?.title).toBe('Loyer'));
    });
  });
});
