import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addDays } from '../../domain/localDate';
import type { Task } from '../../domain/model';
import { setSpeechRecognizer } from '../../platform/speech';
import { createFakeSpeech, type FakeSpeech } from '../../platform/speech/testing';
import { mockViewport, renderToday, setupToday, teardownToday, type TodayHarness } from '../today/testKit';

/** Dictée d'une tâche (Q-03) : PC = dictée Windows (Win + H) dans le champ ; iPhone = clavier iOS, bouton de l'app seulement avec le plugin Speech. */
describe('dictée (Q-03)', () => {
  let h: TodayHarness;

  beforeEach(async () => {
    h = await setupToday('b103');
  });
  afterEach(async () => {
    setSpeechRecognizer(null);
    await teardownToday(h);
  });

  const field = (): HTMLInputElement => screen.getByLabelText('Nouvelle tâche');
  const tasks = async (): Promise<Task[]> => [
    ...(await h.container.data.repos.tasks.listForDay(h.today, 'all')),
    ...(await h.container.data.repos.tasks.listForDay(addDays(h.today, 1), 'all')),
  ];

  describe('PC (dictée Windows)', () => {
    beforeEach(async () => {
      mockViewport(1440);
      renderToday(h.container);
      await screen.findByRole('heading', { level: 1 });
    });

    it('un bouton micro « Dicter » est à droite du champ, atteignable au clavier (critères 1 et 8)', () => {
      const mic = screen.getByRole('button', { name: 'Dicter' });
      expect(mic).toBeEnabled();
      expect(mic).toHaveAttribute('type', 'button');
      expect(mic.tabIndex).toBe(0);
      expect(mic.querySelector('svg')).not.toBeNull();
      // Dans la rangée du champ, après lui.
      const row = field().closest('form') as HTMLElement;
      expect(row.contains(mic)).toBe(true);
      expect(field().compareDocumentPosition(mic) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('le micro focalise le champ et affiche l’aide « Win + H », lue par le champ (critères 2 et 8)', async () => {
      expect(screen.queryByText(/Win \+ H/)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Dicter' }));
      expect(field()).toHaveFocus();
      const help = await screen.findByText('Appuyez sur Win + H pour dicter, parlez, puis relisez avant d’ajouter');
      expect(field()).toHaveAccessibleDescription('Appuyez sur Win + H pour dicter, parlez, puis relisez avant d’ajouter');
      expect(help).toHaveAttribute('role', 'status');
    });

    it('le texte dicté arrive dans le champ comme une saisie : relu par l’aperçu, jamais envoyé seul (critères 3 et 4)', async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Dicter' }));
      // Windows saisit le texte dans le champ comme une frappe.
      fireEvent.change(field(), { target: { value: 'appeler le notaire demain dix heures' } });
      const group = await screen.findByRole('group', { name: 'Ce qui sera appliqué' });
      expect(within(group).getByText('demain · 10:00')).toBeInTheDocument();
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(await tasks()).toEqual([]);
      expect(field()).toHaveValue('appeler le notaire demain dix heures');
      // Relecture faite : Entrée crée la tâche.
      fireEvent.submit(field().closest('form') as HTMLFormElement);
      await waitFor(async () => expect(await tasks()).toHaveLength(1));
      expect((await tasks())[0]).toMatchObject({ title: 'appeler le notaire', date: addDays(h.today, 1), time: '10:00' });
    });

    it('« neuf heures trente », « midi » : heures courantes converties, le reste du titre inchangé', async () => {
      fireEvent.change(field(), { target: { value: 'Déjeuner avec Paul demain midi' } });
      expect(await screen.findByText('demain · 12:00')).toBeInTheDocument();
      fireEvent.change(field(), { target: { value: 'Réunion équipe jeudi neuf heures trente' } });
      expect(await screen.findByText('jeu. 8 oct. · 09:30')).toBeInTheDocument();
    });

    it('aucun moteur de reconnaissance : le contrat « indisponible » n’est jamais appelé sur PC', async () => {
      const speech = createFakeSpeech();
      setSpeechRecognizer(speech);
      fireEvent.click(screen.getByRole('button', { name: 'Dicter' }));
      expect(speech.listens).toBe(0);
    });
  });

  describe('iPhone (clavier iOS, plugin Speech en option)', () => {
    beforeEach(() => {
      mockViewport(440);
    });

    it('à l’ordre 3 aucun bouton micro : le micro du clavier iOS suffit (critère 5)', async () => {
      renderToday(h.container);
      await screen.findByRole('heading', { level: 1 });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(screen.queryByRole('button', { name: 'Dicter' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Ajouter' }));
      await screen.findByRole('dialog', { name: 'Nouvelle tâche' });
      expect(screen.queryByRole('button', { name: 'Dicter' })).toBeNull();
    });

    it('avec le faux SpeechRecognizer : feuille « Je vous écoute », « Terminer », texte relu dans le champ sans création (critère 6)', async () => {
      const speech: FakeSpeech = createFakeSpeech({ transcript: 'Appeler le plombier demain 9 h', waitForStop: true });
      setSpeechRecognizer(speech);
      renderToday(h.container);
      const mic = await screen.findByRole('button', { name: 'Dicter' });
      fireEvent.click(mic);
      const sheet = await screen.findByRole('dialog', { name: 'Je vous écoute' });
      expect(speech.listens).toBe(1);
      fireEvent.click(within(sheet).getByRole('button', { name: 'Terminer' }));
      await waitFor(() => expect(field()).toHaveValue('Appeler le plombier demain 9 h'));
      expect(screen.queryByRole('dialog', { name: 'Je vous écoute' })).toBeNull();
      expect(await screen.findByText('demain · 09:00')).toBeInTheDocument();
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(await tasks()).toEqual([]);
    });

    it('le texte reconnu s’ajoute au texte déjà saisi', async () => {
      setSpeechRecognizer(createFakeSpeech({ transcript: 'demain 9 h' }));
      renderToday(h.container);
      fireEvent.change(await screen.findByLabelText('Nouvelle tâche'), { target: { value: 'Appeler le plombier' } });
      fireEvent.click(await screen.findByRole('button', { name: 'Dicter' }));
      await waitFor(() => expect(field()).toHaveValue('Appeler le plombier demain 9 h'));
    });

    it('permission refusée : message sans planter (critère 6)', async () => {
      setSpeechRecognizer(createFakeSpeech({ failure: 'permission-denied' }));
      renderToday(h.container);
      fireEvent.click(await screen.findByRole('button', { name: 'Dicter' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Autorisez le micro dans les Réglages de l’iPhone');
      expect(screen.queryByRole('dialog', { name: 'Je vous écoute' })).toBeNull();
      expect(field()).toHaveValue('');
    });

    it('autre échec : message général', async () => {
      setSpeechRecognizer(createFakeSpeech({ failure: 'failed' }));
      renderToday(h.container);
      fireEvent.click(await screen.findByRole('button', { name: 'Dicter' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('La dictée n’a pas abouti');
    });

    it('feuille « Nouvelle tâche » : micro disponible seulement avec le plugin, texte relu avant l’enregistrement', async () => {
      setSpeechRecognizer(createFakeSpeech({ transcript: 'Payer la cantine' }));
      renderToday(h.container);
      await screen.findByRole('heading', { level: 1 });
      fireEvent.click(screen.getByRole('button', { name: 'Ajouter' }));
      const sheet = await screen.findByRole('dialog', { name: 'Nouvelle tâche' });
      fireEvent.click(await within(sheet).findByRole('button', { name: 'Dicter' }));
      await waitFor(() => expect(within(sheet).getByLabelText('Titre')).toHaveValue('Payer la cantine'));
      expect(await tasks()).toEqual([]);
    });
  });
});
