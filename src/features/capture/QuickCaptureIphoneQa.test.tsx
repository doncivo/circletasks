import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPACE_PERSO_ID } from '../../db/seed/defaultSpaces';
import { TASK_TITLE_MAX_LENGTH } from '../../domain/taskRules';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { useNoticeStore } from '../app/notice';
import { renderEvents, setupEvents } from '../events/testKit';
import { CREATE_NOT_READY_MS, TaskCreateSheet } from '../tasks/TaskCreateSheet';
import { mockViewport, renderToday, setupToday, teardownToday, type TodayHarness } from '../today/testKit';

/** Q-05 QA : ouvertures répétées, fermeture en saisie, base occupée puis libérée, « Réessayer » en série, titre vide ou très long, points d'entrée. */
const field = (): HTMLElement => screen.getByLabelText('Titre');
const fab = (): Promise<HTMLElement> => screen.findByRole('button', { name: 'Ajouter' });

describe('Q-05 QA : ouverture et fermeture de la feuille', () => {
  let h: TodayHarness;
  beforeEach(async () => {
    mockViewport(440);
    h = await setupToday('c605');
  });
  afterEach(async () => {
    await teardownToday(h);
  });

  it('Q-05 critère 3 : ouvertures répétées (6 fois) : une seule feuille, champ vide et focalisé à chaque fois', async () => {
    renderToday(h.container);
    for (let i = 0; i < 6; i += 1) {
      fireEvent.click(await fab());
      expect(screen.getAllByLabelText('Titre')).toHaveLength(1);
      expect(field()).toHaveFocus();
      expect(field()).toHaveValue('');
      fireEvent.change(field(), { target: { value: `reste ${String(i)}` } });
      fireEvent.click(screen.getByRole('button', { name: 'Fermer' }));
      expect(screen.queryByLabelText('Titre')).toBeNull();
    }
  });

  it('Q-05 critère 3 : double toucher sur + : une seule feuille', async () => {
    renderToday(h.container);
    const button = await fab();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(screen.getAllByLabelText('Titre')).toHaveLength(1);
    expect(field()).toHaveFocus();
  });

  it('Q-05 critère 10 : fermeture (bouton, puis Échap) pendant la saisie : aucune tâche créée, texte oublié à la réouverture', async () => {
    renderToday(h.container);
    fireEvent.click(await fab());
    fireEvent.change(field(), { target: { value: 'Appeler le notaire demain 10h #pro' } });
    fireEvent.click(screen.getByRole('button', { name: 'Fermer' }));
    expect(screen.queryByLabelText('Titre')).toBeNull();
    fireEvent.click(await fab());
    expect(field()).toHaveValue('');
    fireEvent.change(field(), { target: { value: 'Brouillon' } });
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(screen.queryByLabelText('Titre')).toBeNull();
    expect(await h.container.data.repos.tasks.listForDay(h.today, 'all')).toHaveLength(0);
  });

  it('Q-05 critère 5 : titre fait d’espaces seulement : « Enregistrer » désactivé, Entrée fait trembler, rien n’est créé', async () => {
    renderToday(h.container);
    fireEvent.click(await fab());
    expect(screen.getByRole('button', { name: 'Enregistrer' })).toBeDisabled();
    fireEvent.change(field(), { target: { value: '     ' } });
    expect(screen.getByRole('button', { name: 'Enregistrer' })).toBeDisabled();
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(field().closest('.ct-task-sheet__titleRow')).toHaveAttribute('data-shake', 'true');
    fireEvent.submit(field().closest('form') as HTMLFormElement);
    await act(async () => {
      await Promise.resolve();
    });
    expect(field()).toBeInTheDocument();
    expect(await h.container.data.repos.tasks.listForDay(h.today, 'all')).toHaveLength(0);
  });

  it('Q-05 critère 5 : titre de 200 caractères accepté et créé ; le champ borne la saisie à 200', async () => {
    renderToday(h.container);
    fireEvent.click(await fab());
    expect(field()).toHaveAttribute('maxlength', String(TASK_TITLE_MAX_LENGTH));
    const title = 'é'.repeat(TASK_TITLE_MAX_LENGTH);
    fireEvent.change(field(), { target: { value: title } });
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(screen.queryByLabelText('Titre')).toBeNull());
    const tasks = await h.container.data.repos.tasks.listForDay(h.today, 'all');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe(title);
  });

  it('Q-05 critère 10 : titre de 201 caractères (collé hors borne) : « Enregistrer » désactivé, Entrée refuse, rien n’est créé', async () => {
    renderToday(h.container);
    fireEvent.click(await fab());
    fireEvent.change(field(), { target: { value: 'x'.repeat(TASK_TITLE_MAX_LENGTH + 1) } });
    expect(screen.getByRole('button', { name: 'Enregistrer' })).toBeDisabled();
    fireEvent.keyDown(field(), { key: 'Enter' });
    fireEvent.submit(field().closest('form') as HTMLFormElement);
    await act(async () => {
      await Promise.resolve();
    });
    expect(field()).toBeInTheDocument();
    expect(await h.container.data.repos.tasks.listForDay(h.today, 'all')).toHaveLength(0);
  });

  it('Q-05 critère 3 : point d’entrée Événements : le segment Tâche garde le titre saisi et focalise le champ dans le geste', async () => {
    const e = await setupEvents('d605');
    try {
      renderEvents(e.container);
      fireEvent.click(await screen.findByRole('button', { name: 'Ajouter un événement' }));
      fireEvent.change(field(), { target: { value: 'Appeler Paul' } });
      fireEvent.click(screen.getByRole('button', { name: 'Tâche' }));
      expect(field()).toHaveValue('Appeler Paul');
      expect(field()).toHaveFocus();
    } finally {
      cleanup();
      await e.db.close();
    }
  });
});

describe('Q-05 QA : base occupée puis libérée, « Réessayer » en série', () => {
  let h: TodayHarness;
  beforeEach(async () => {
    mockViewport(440);
    h = await setupToday('f605');
  });
  afterEach(async () => {
    vi.useRealTimers();
    await teardownToday(h);
  });

  function renderSheet(onCreate: (input: { title: string }) => Promise<boolean>, onClose: () => void) {
    return render(
      <AppContainerProvider container={h.container}>
        <TaskCreateSheet viewedDate={h.today} today={h.today} spaces={useAppStore.getState().spaces} initialSpaceId={SPACE_PERSO_ID} onClose={onClose} onCreate={onCreate} />
      </AppContainerProvider>,
    );
  }
  const type = (text: string): void => {
    fireEvent.change(field(), { target: { value: text } });
  };
  const click = async (name: string): Promise<void> => {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name }));
      await Promise.resolve();
    });
  };
  const notReady = async (): Promise<void> => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CREATE_NOT_READY_MS);
    });
  };

  it('Q-05 critère 2 (revue) : « Réessayer » cliqué 5 fois sur une écriture qui ne revient pas : chaque clic relance, le texte reste ; toutes portent le même identifiant (écriture idempotente), une seule fermeture', async () => {
    const finishers: ((ok: boolean) => void)[] = [];
    const onCreate = vi.fn(() => new Promise<boolean>((resolve) => finishers.push(resolve)));
    const onClose = vi.fn();
    renderSheet(onCreate, onClose);
    type('Acheter du pain');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await click('Enregistrer');
    await notReady();
    for (let i = 0; i < 5; i += 1) {
      await click('Réessayer');
      // Le bouton disparaît pendant la nouvelle écriture : pas de salve de clics sans attente.
      expect(screen.queryByRole('button', { name: 'Réessayer' })).toBeNull();
      await notReady();
      expect(screen.getByRole('alert')).toHaveTextContent('La base n’est pas prête');
      expect(field()).toHaveValue('Acheter du pain');
    }
    expect(onCreate).toHaveBeenCalledTimes(6);
    useNoticeStore.getState().clear();
    await act(async () => {
      finishers[5]?.(true);
      await Promise.resolve();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    // Une écriture abandonnée aboutit à son tour : jamais en silence.
    await act(async () => {
      finishers[0]?.(true);
      await Promise.resolve();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(new Set(onCreate.mock.calls.map(([input]) => (input as unknown as { taskId: string }).taskId)).size).toBe(1);
    expect(useNoticeStore.getState().notice).toBeNull();
  });

  it('Q-05 critère 10 : base libérée mais écriture refusée : message d’erreur, texte conservé, nouvel essai recrée une fois', async () => {
    const finishers: ((ok: boolean) => void)[] = [];
    const onCreate = vi.fn(() => new Promise<boolean>((resolve) => finishers.push(resolve)));
    const onClose = vi.fn();
    renderSheet(onCreate, onClose);
    type('Payer le loyer');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await click('Enregistrer');
    await notReady();
    await act(async () => {
      finishers[0]?.(false);
      await Promise.resolve();
    });
    expect(screen.getByRole('alert')).toHaveTextContent('La tâche n’a pas pu être enregistrée');
    expect(field()).toHaveValue('Payer le loyer');
    expect(onClose).not.toHaveBeenCalled();
    await click('Enregistrer');
    expect(onCreate).toHaveBeenCalledTimes(2);
    await act(async () => {
      finishers[1]?.(true);
      await Promise.resolve();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Q-05 critère 2 : écriture réussie avant 2 s : aucun message, fermeture', async () => {
    const onCreate = vi.fn(() => Promise.resolve(true));
    const onClose = vi.fn();
    renderSheet(onCreate, onClose);
    type('Rapide');
    await click('Enregistrer');
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Q-05 critère 2 : démontage pendant l’écriture en attente : pas de fermeture ni d’erreur à la fin', async () => {
    let finish: (ok: boolean) => void = () => undefined;
    const onCreate = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
    const onClose = vi.fn();
    const view = renderSheet(onCreate, onClose);
    type('Pendant la sauvegarde');
    await click('Enregistrer');
    view.unmount();
    await act(async () => {
      finish(true);
      await Promise.resolve();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(onCreate).toHaveBeenCalledTimes(1);
  });
});
