import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { addDays } from '../../domain/localDate';
import { AppContainerProvider } from '../app/AppContainerContext';
import { createAppContainer, type AppContainer } from '../app/container';
import { useAppStore } from '../app/appStore';
import { useQuickAddStore } from '../app/quickAdd';
import { renderSomeday } from '../someday/testKit';
import { CREATE_NOT_READY_MS, TaskCreateSheet } from '../tasks/TaskCreateSheet';
import { mockViewport, renderToday, setupToday, teardownToday, type TodayHarness } from '../today/testKit';
import { renderWeek } from '../week/testKit';

/**
 * Q-05 — Je capture vite depuis l'iPhone (critères 1 à 5, 7, 10 ; ADR 0013 §4). `fireEvent` s'exécute dans `act` : il vide les effets
 * mais PAS les minuteries, donc un focus posé dans un `setTimeout` (l'ancien code) échoue ici comme sur l'iPhone.
 */
const CTRL_N = { key: 'n', code: 'KeyN', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, editable: false } as const;

describe('Capture rapide iPhone (Q-05)', () => {
  let h: TodayHarness;
  beforeEach(async () => {
    mockViewport(440);
    h = await setupToday('a605');
  });
  afterEach(async () => {
    useQuickAddStore.setState({ pending: false });
    await teardownToday(h);
  });

  const field = (): HTMLElement => screen.getByLabelText('Titre');

  describe('focus du champ dans le traitement du geste (critère 3)', () => {
    it('Aujourd’hui : après le clic sur +, le champ « Titre » est focalisé dans le même passage', async () => {
      renderToday(h.container);
      fireEvent.click(await screen.findByRole('button', { name: 'Ajouter' }));
      expect(field()).toHaveFocus();
    });

    it('Aujourd’hui : raccourci app.newTask (Ctrl+N)', async () => {
      renderToday(h.container);
      await screen.findByRole('button', { name: 'Ajouter' });
      act(() => {
        h.container.shortcuts.handle(CTRL_N);
      });
      expect(field()).toHaveFocus();
    });

    it('Aujourd’hui : « Ajout rapide » de la zone de notification', async () => {
      renderToday(h.container);
      await screen.findByRole('button', { name: 'Ajouter' });
      act(() => useQuickAddStore.getState().request());
      await waitFor(() => expect(field()).toHaveFocus());
    });

    it('Semaine : bouton + puis Ctrl+N', async () => {
      renderWeek(h.container);
      fireEvent.click(await screen.findByRole('button', { name: 'Ajouter' }));
      expect(field()).toHaveFocus();
      fireEvent.click(screen.getByRole('button', { name: 'Fermer' }));
      expect(screen.queryByLabelText('Titre')).toBeNull();
      act(() => {
        h.container.shortcuts.handle(CTRL_N);
      });
      expect(field()).toHaveFocus();
    });

    it('« Un jour » : bouton + puis Ctrl+N', async () => {
      renderSomeday(h.container);
      fireEvent.click(await screen.findByRole('button', { name: 'Ajouter' }));
      expect(field()).toHaveFocus();
      fireEvent.click(screen.getByRole('button', { name: 'Fermer' }));
      act(() => {
        h.container.shortcuts.handle(CTRL_N);
      });
      expect(field()).toHaveFocus();
    });

    it('le champ annonce la touche « Ajouter » du clavier iOS (enterkeyhint="done")', async () => {
      renderToday(h.container);
      fireEvent.click(await screen.findByRole('button', { name: 'Ajouter' }));
      expect(field()).toHaveAttribute('enterkeyhint', 'done');
    });
  });

  describe('bouton + (critères 1 et 8)', () => {
    it('Aujourd’hui : bouton « Ajouter » de 64 px, actif', async () => {
      renderToday(h.container);
      const fab = await screen.findByRole('button', { name: 'Ajouter' });
      expect(fab).toBeEnabled();
      expect(fab.style.width).toBe('64px');
      expect(fab.style.height).toBe('64px');
    });

    it('« Un jour » et Semaine : bouton + présent, 64 px', async () => {
      renderSomeday(h.container);
      expect((await screen.findByRole('button', { name: 'Ajouter' })).style.width).toBe('64px');
      cleanup();
      renderWeek(h.container);
      expect((await screen.findByRole('button', { name: 'Ajouter' })).style.width).toBe('64px');
    });
  });

  describe('indépendance des tâches de fond (critère 7)', () => {
    it('la feuille s’ouvre alors que notifications, agendas et fichiers ne répondent jamais', async () => {
      // Chaque méthode de ces services rend une promesse jamais tenue : si l'ouverture de la feuille en dépendait, le champ ne serait jamais focalisé.
      const hang = new Proxy({}, { get: () => () => new Promise<never>(() => undefined) });
      const slow = createAppContainer({ clock: h.db.clock, hlc: h.container.hlc, data: h.db.data, notifications: hang as AppContainer['notifications'], calendars: hang as AppContainer['calendars'], files: hang as AppContainer['files'] });
      renderToday(slow);
      fireEvent.click(await screen.findByRole('button', { name: 'Ajouter' }));
      expect(field()).toHaveFocus();
    });
  });

  describe('Entrée et enregistrement (critères 4 et 5)', () => {
    const created = async () => [
      ...(await h.container.data.repos.tasks.listForDay(h.today, 'all')),
      ...(await h.container.data.repos.tasks.listForDay(addDays(h.today, 1), 'all')),
    ];

    it('« Acheter du pain #perso » : le formulaire envoyé par Entrée crée la tâche, ferme la feuille et annonce l’espace', async () => {
      // Filtre Pro actif : la création dans Perso est annoncée (ES-02).
      act(() => useAppStore.getState().setSpaceFilter(SPACE_PRO_ID));
      renderToday(h.container);
      fireEvent.click(await screen.findByRole('button', { name: 'Ajouter' }));
      fireEvent.change(field(), { target: { value: 'Acheter du pain #perso' } });
      fireEvent.submit(field().closest('form') as HTMLFormElement);
      await waitFor(() => expect(screen.queryByLabelText('Titre')).toBeNull());
      const tasks = await created();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ title: 'Acheter du pain', spaceId: SPACE_PERSO_ID });
      expect(await screen.findByText('Ajouté dans Perso')).toBeInTheDocument();
    });

    it('titre vide : Entrée fait trembler le champ, la feuille reste ouverte', async () => {
      renderToday(h.container);
      fireEvent.click(await screen.findByRole('button', { name: 'Ajouter' }));
      fireEvent.keyDown(field(), { key: 'Enter' });
      expect(field().closest('.ct-task-sheet__titleRow')).toHaveAttribute('data-shake', 'true');
      expect(field()).toBeInTheDocument();
      expect(await created()).toHaveLength(0);
    });
  });
});

describe('Feuille « Nouvelle tâche » : base occupée et échec (critères 2 et 10)', () => {
  let h: TodayHarness;
  beforeEach(async () => {
    mockViewport(440);
    h = await setupToday('b605');
  });
  afterEach(async () => {
    vi.useRealTimers();
    await teardownToday(h);
  });

  function renderSheet(onCreate: () => Promise<boolean>, onClose: () => void) {
    const spaces = useAppStore.getState().spaces;
    return render(
      <AppContainerProvider container={h.container}>
        <TaskCreateSheet viewedDate={h.today} today={h.today} spaces={spaces} initialSpaceId={SPACE_PERSO_ID} onClose={onClose} onCreate={onCreate} />
      </AppContainerProvider>,
    );
  }
  const type = (text: string): void => {
    fireEvent.change(screen.getByLabelText('Titre'), { target: { value: text } });
  };
  const submit = async (): Promise<void> => {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
      await Promise.resolve();
    });
  };

  it('écriture qui n’aboutit pas en 2 s : « La base n’est pas prête », texte conservé, « Réessayer » abandonne l’écriture en attente et en relance une, la fin de l’ancienne est dite', async () => {
    let finish: (ok: boolean) => void = () => undefined;
    const onCreate = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
    const onClose = vi.fn();
    renderSheet(onCreate, onClose);
    type('Acheter du pain');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await submit();
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CREATE_NOT_READY_MS);
    });
    expect(screen.getByRole('alert')).toHaveTextContent('La base n’est pas prête');
    expect(screen.getByLabelText('Titre')).toHaveValue('Acheter du pain');
    expect(onClose).not.toHaveBeenCalled();

    // « Réessayer » : la première écriture est abandonnée (jamais rattendue), une nouvelle est lancée avec le même texte.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
      await Promise.resolve();
    });
    expect(onCreate).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText('Titre')).toHaveValue('Acheter du pain');

    // La base devient prête : la nouvelle écriture aboutit, la feuille se ferme une fois.
    await act(async () => {
      finish(true);
      await Promise.resolve();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('écriture refusée après le message : « Réessayer » recrée, aucune perte', async () => {
    const results = [false, true];
    let call = 0;
    const onCreate = vi.fn(async () => results[call++] ?? false);
    const onClose = vi.fn();
    renderSheet(onCreate, onClose);
    type('Appeler le notaire');
    await submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('La tâche n’a pas pu être enregistrée');
    expect(screen.getByLabelText('Titre')).toHaveValue('Appeler le notaire');
    expect(onClose).not.toHaveBeenCalled();
    await submit();
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onCreate).toHaveBeenCalledTimes(2);
  });

  it('création qui lève une erreur : message d’erreur (role="alert"), feuille ouverte, texte conservé', async () => {
    const onClose = vi.fn();
    renderSheet(() => Promise.reject(new Error('base indisponible')), onClose);
    type('Payer le loyer');
    await submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('La tâche n’a pas pu être enregistrée');
    expect(screen.getByLabelText('Titre')).toHaveValue('Payer le loyer');
    expect(onClose).not.toHaveBeenCalled();
  });
});
