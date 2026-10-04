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
import { setFormatPrefs } from '../../i18n/formatPrefs';
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
  const panel = (): HTMLElement => screen.getByRole('complementary', { name: 'Détail de la tâche' });
  const titleButton = (name: string): HTMLElement => within(within(panel()).getByRole('heading', { name })).getByRole('button', { name });

  describe('PC : panneau et édition sur place', () => {
    beforeEach(() => mockViewport(1440));

    it('affiche titre, date, heure, répétition, rappels, espace, projet, objectif, note et horodatage en texte (critère 5)', async () => {
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
      const fiche = await screen.findByRole('complementary', { name: 'Détail de la tâche' });
      expect(within(fiche).getByRole('heading', { name: 'Envoyer la facture' })).toBeInTheDocument();
      await waitFor(() => expect(within(fiche).getByText('À l’heure')).toBeInTheDocument());
      expect(within(fiche).getByText('30 min avant')).toBeInTheDocument();
      expect(within(fiche).getByText('Mer. 23 sept. 2026')).toBeInTheDocument();
      expect(within(fiche).getByText('09:00')).toBeInTheDocument();
      expect(within(fiche).getByTestId('recurrence-detail')).toHaveTextContent('Une fois');
      expect(within(fiche).getByText('Pro')).toBeInTheDocument();
      expect(within(fiche).getByText('Projet')).toBeInTheDocument();
      expect(within(fiche).getByText('Non rattachée')).toBeInTheDocument();
      expect(within(fiche).getByLabelText('Note')).toHaveValue('Joindre le relevé');
      expect(fiche).toHaveTextContent(/Créée le aujourd’hui à \d\d:\d\d · modifiée aujourd’hui à \d\d:\d\d/);
      // Aucun champ de saisie tant qu'on n'a pas cliqué une valeur (PC-Aujourdhui.html : lignes en texte).
      expect(within(fiche).queryByLabelText('Heure')).toBeNull();
      expect(within(fiche).queryByRole('combobox')).toBeNull();
      // Boutons : Reporter, Un jour, Dupliquer, Supprimer ; ni Focus (M10), ni « Marquer comme terminée » (la case de la ligne).
      expect(within(fiche).getByRole('button', { name: 'Reporter' })).toBeInTheDocument();
      expect(within(fiche).getByRole('button', { name: 'Un jour' })).toBeInTheDocument();
      expect(within(fiche).getByRole('button', { name: 'Dupliquer la tâche' })).toBeInTheDocument();
      expect(within(fiche).getByRole('button', { name: 'Supprimer' })).toBeInTheDocument();
      expect(within(fiche).queryByRole('button', { name: /Focus/ })).toBeNull();
      expect(within(fiche).queryByRole('button', { name: 'Marquer comme terminée' })).toBeNull();
    });

    it('sans heure : « Sans heure », et rappels « Aucun » (critère 5)', async () => {
      await open({ time: null as never });
      expect(within(panel()).getByText('Sans heure')).toBeInTheDocument();
      expect(within(panel()).getAllByText('Aucun')).toHaveLength(2); // rappels et projet
    });

    it('le titre est un bouton sous le titre de niveau 2, décrit par une aide, qui s’édite sur place : Entrée valide et enregistre (critère 8)', async () => {
      const task = await open();
      const button = titleButton('Envoyer la facture');
      expect(button).toHaveAccessibleDescription('Cliquer ou appuyer sur Entrée pour modifier le titre');
      fireEvent.click(button);
      const field = screen.getByLabelText('Titre de la tâche');
      fireEvent.change(field, { target: { value: '  Envoyer la facture client ' } });
      fireEvent.submit(field.closest('form') as HTMLFormElement);
      await waitFor(async () => expect((await stored(task.id))?.title).toBe('Envoyer la facture client'));
      expect(await screen.findByRole('heading', { name: 'Envoyer la facture client' })).toBeInTheDocument();
    });

    it('un titre vidé est refusé : la valeur précédente est rétablie avec un message (critère 10)', async () => {
      const task = await open();
      fireEvent.click(titleButton('Envoyer la facture'));
      const field = screen.getByLabelText('Titre de la tâche');
      fireEvent.change(field, { target: { value: '   ' } });
      fireEvent.submit(field.closest('form') as HTMLFormElement);
      expect(await screen.findByRole('alert')).toHaveTextContent('Le titre doit contenir entre 1 et 200 caractères.');
      expect((await stored(task.id))?.title).toBe('Envoyer la facture');
      expect(screen.getByRole('heading', { name: 'Envoyer la facture' })).toBeInTheDocument();
    });

    it('Échap annule la saisie du titre sans fermer la fiche, puis un second Échap la ferme (critère 8)', async () => {
      const task = await open();
      fireEvent.click(titleButton('Envoyer la facture'));
      fireEvent.change(screen.getByLabelText('Titre de la tâche'), { target: { value: 'Autre' } });
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByLabelText('Titre de la tâche')).toBeNull());
      expect(screen.getByRole('complementary', { name: 'Détail de la tâche' })).toBeInTheDocument();
      expect((await stored(task.id))?.title).toBe('Envoyer la facture');
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull());
    });

    it('P-03 : en 12 h la fiche affiche « 9:00 AM », accepte « 15h30 » et « 12:00 am », et stocke toujours en 24 h (critères 6 et 8)', async () => {
      setFormatPrefs({ timeFormat: '12h' });
      try {
        const task = await open();
        fireEvent.click(within(panel()).getByRole('button', { name: 'Heure : 9:00 AM' }));
        const field = screen.getByLabelText('Heure');
        expect(field).toHaveValue('9:00 AM');
        fireEvent.change(field, { target: { value: '15h30' } });
        fireEvent.submit(field.closest('form') as HTMLFormElement);
        await waitFor(async () => expect((await stored(task.id))?.time).toBe('15:30'));
        fireEvent.click(await within(panel()).findByRole('button', { name: 'Heure : 3:30 PM' }));
        fireEvent.change(screen.getByLabelText('Heure'), { target: { value: '12:00 am' } });
        fireEvent.submit(screen.getByLabelText('Heure').closest('form') as HTMLFormElement);
        await waitFor(async () => expect((await stored(task.id))?.time).toBe('00:00'));
        expect(await within(panel()).findByRole('button', { name: 'Heure : 12:00 AM' })).toBeInTheDocument();
      } finally {
        setFormatPrefs({ timeFormat: '24h' });
      }
    });

    it('F2 sur le bouton du titre ouvre la saisie', async () => {
      await open();
      fireEvent.keyDown(titleButton('Envoyer la facture'), { key: 'F2' });
      expect(screen.getByLabelText('Titre de la tâche')).toBeInTheDocument();
    });

    it('l’heure se modifie au clic sur sa valeur (« 10h30 »), se vide, et refuse une valeur invalide (critère 8)', async () => {
      const task = await open();
      fireEvent.click(within(panel()).getByRole('button', { name: 'Heure : 09:00' }));
      const field = screen.getByLabelText('Heure');
      fireEvent.change(field, { target: { value: '10h30' } });
      fireEvent.submit(field.closest('form') as HTMLFormElement);
      await waitFor(async () => expect((await stored(task.id))?.time).toBe('10:30'));
      await waitFor(() => expect(within(panel()).getByRole('button', { name: 'Heure : 10:30' })).toBeInTheDocument());

      fireEvent.click(within(panel()).getByRole('button', { name: 'Heure : 10:30' }));
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
      fireEvent.click(within(panel()).getByRole('button', { name: 'Heure : 09:00' }));
      fireEvent.change(screen.getByLabelText('Heure'), { target: { value: '11' } });
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
      await waitFor(() => expect(screen.queryByLabelText('Heure')).toBeNull());
      expect(within(panel()).getByText('09:00')).toBeInTheDocument();
      expect(screen.getByRole('complementary', { name: 'Détail de la tâche' })).toBeInTheDocument();
    });

    it('la date se modifie au clic sur sa valeur : champ « Date de la tâche » à saisie libre, Entrée valide (critère 8)', async () => {
      const task = await open();
      fireEvent.click(within(panel()).getByRole('button', { name: /^Date de la tâche/ }));
      const field = await screen.findByLabelText('Date de la tâche');
      fireEvent.change(field, { target: { value: 'demain' } });
      fireEvent.keyDown(field, { key: 'Enter' });
      await waitFor(async () => expect((await stored(task.id))?.date).toBe('2026-09-24'));
      expect((await stored(task.id))?.time).toBeNull();
    });

    it('l’espace se change au clic sur son nom, puis sur une pastille (critère 8)', async () => {
      const task = await open();
      fireEvent.click(within(panel()).getByRole('button', { name: 'Espace de la tâche : Pro' }));
      fireEvent.click(within(screen.getByRole('group', { name: 'Espace de la tâche' })).getByRole('button', { name: 'Perso' }));
      await waitFor(async () => expect((await stored(task.id))?.spaceId).toBe(SPACE_PERSO_ID));
      expect(await within(panel()).findByRole('button', { name: 'Espace de la tâche : Perso' })).toBeInTheDocument();
    });

    it('« Un jour » range la tâche, annulable ; absent pour une tâche déjà rangée (critère 6)', async () => {
      const task = await open();
      fireEvent.click(screen.getByRole('button', { name: 'Un jour' }));
      await waitFor(async () => expect(await stored(task.id)).toMatchObject({ someday: true, date: null, time: null }));
      expect(await screen.findByRole('status')).toHaveTextContent('« Envoyer la facture » mise dans « Un jour »');
      expect(screen.queryByRole('button', { name: 'Un jour' })).toBeNull();
      expect(within(panel()).getByText('Un jour', { selector: '.ct-task-detail__rowValue button' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
      await waitFor(async () => expect(await stored(task.id)).toMatchObject({ someday: false, date: '2026-09-23', time: '09:00' }));
    });

    it('terminée : « Reporter » et « Un jour » sont absents du panneau (critère 7)', async () => {
      const task = await open();
      await container.data.repos.tasks.complete(task.id, '2026-09-23T18:00:00.000Z' as never);
      cleanup();
      useNavigationStore.getState().openDetail({ type: 'task', id: task.id });
      render(
        <AppContainerProvider container={container}>
          <TaskDetail />
        </AppContainerProvider>,
      );
      await screen.findByRole('complementary', { name: 'Détail de la tâche' });
      expect(screen.queryByRole('button', { name: 'Reporter' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Un jour' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Dupliquer la tâche' })).toBeInTheDocument();
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

    it('en-tête ✕ / DÉTAIL / crayon, lignes en lecture seule (date sans l’année courante), note modifiable (critères 2, 5, 9, 11)', async () => {
      await open();
      const sheet = screen.getByRole('dialog', { name: 'Détail de la tâche' });
      expect(sheet).toHaveAttribute('aria-modal', 'true');
      expect(within(sheet).getByRole('button', { name: 'Fermer' })).toBeInTheDocument();
      expect(within(sheet).getByText('DÉTAIL')).toBeInTheDocument();
      expect(within(sheet).getByRole('button', { name: 'Modifier' })).toBeInTheDocument();
      expect(within(sheet).getByText('Date')).toBeInTheDocument();
      expect(within(sheet).getByText('Mer. 23 sept. · 09:00')).toBeInTheDocument();
      expect(within(sheet).queryByLabelText('Date de la tâche')).toBeNull();
      expect(within(sheet).getByText('Espace · projet')).toBeInTheDocument();
      expect(within(sheet).getByLabelText('Note')).toBeEnabled();
      // Q15 : la répétition est en lecture seule sur iPhone (modification par « Modifier »).
      expect(within(sheet).queryByRole('button', { name: 'Répéter…' })).toBeNull();
      expect(within(sheet).queryByRole('button', { name: 'Rendre la tâche récurrente' })).toBeNull();
      expect(within(sheet).getByTestId('recurrence-detail')).toHaveTextContent('Une fois');
      expect(within(sheet).getByRole('button', { name: 'Marquer comme terminée' })).toHaveAttribute('aria-pressed', 'false');
      expect(within(sheet).getByRole('button', { name: 'Supprimer la tâche' })).toBeInTheDocument();
    });

    it('« Marquer comme terminée » (case encadrée) termine la tâche ; « Reporter » et « Un jour » disparaissent (critère 7)', async () => {
      const task = await open();
      fireEvent.click(screen.getByRole('button', { name: 'Marquer comme terminée' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Marquer comme terminée' })).toHaveAttribute('aria-pressed', 'true'));
      expect((await stored(task.id))?.status).toBe('done');
      expect(screen.queryByRole('button', { name: 'Reporter' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Un jour' })).toBeNull();
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

    it('« Modifier » : changer la répétition d’une série pose la question « Toutes les suivantes » puis l’applique (T-10, Q15)', async () => {
      const task = await open({ recurrence: { freq: 'monthly', interval: 1, weekdays: [], monthDay: 23, nthWeekday: null, until: null, count: null } });
      fireEvent.click(screen.getByRole('button', { name: 'Modifier' }));
      const edit = await screen.findByRole('dialog', { name: 'Modifier la tâche' });
      fireEvent.click(within(edit).getByRole('radio', { name: 'Hebdo' }));
      fireEvent.click(within(edit).getByRole('button', { name: 'Enregistrer' }));
      const dialog = await screen.findByRole('alertdialog', { name: 'Modifier la répétition ?' });
      expect(within(dialog).queryByRole('button', { name: 'Cette occurrence' })).toBeNull();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Toutes les suivantes' }));
      await waitFor(() => expect(screen.getByTestId('recurrence-detail')).toHaveTextContent(/Hebdomadaire|Chaque|semaine/i));
      expect((await stored(task.id))?.recurrenceId).not.toBeNull();
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
