import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { createTaskUseCases } from '../tasks/createTaskUseCases';
import { renderWeek } from '../week/testKit';
import { mockViewport, renderToday, seedTask, setupToday, teardownToday, type TodayHarness } from './testKit';

/** P-06 : critères 1, 3, 4, 6, 8 sur Aujourd'hui et Semaine (PC et iPhone). */
const emptyOf = (screenId: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-empty-screen="${screenId}"]`);

describe('P-06 : états vides, Aujourd’hui et Semaine', () => {
  let h: TodayHarness;
  beforeEach(async () => {
    h = await setupToday('606');
  });
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await teardownToday(h);
  });

  async function addSomeday(spaceId: typeof SPACE_PRO_ID): Promise<void> {
    const r = await createTaskUseCases(h.container).create({ title: 'Passeport', spaceId, someday: true });
    if (!r.ok) throw new Error(r.error);
  }

  async function findEmpty(id: string): Promise<HTMLElement> {
    return waitFor(() => {
      const el = emptyOf(id);
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
  }

  it('P-06 critère 1 : « Un jour » non vide, l’action est « Ouvrir « Un jour » · 2 tâches » et navigue', async () => {
    await addSomeday(SPACE_PRO_ID);
    await addSomeday(SPACE_PRO_ID);
    mockViewport(1440);
    renderToday(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Ouvrir « Un jour » · 2 tâches' }));
    expect(useNavigationStore.getState().route).toMatchObject({ tab: 'tasks', screen: 'someday' });
  });

  it('P-06 critère 1 : une seule tâche « Un jour » : singulier', async () => {
    await addSomeday(SPACE_PRO_ID);
    mockViewport(1440);
    renderToday(h.container);
    expect(await screen.findByRole('button', { name: 'Ouvrir « Un jour » · 1 tâche' })).toBeInTheDocument();
  });

  it('P-06 critère 3 : filtre Pro, message nommé et « Ajouter une tâche » si « Un jour » ne contient que du Perso (rien de masqué proposé)', async () => {
    await addSomeday(SPACE_PERSO_ID);
    act(() => useAppStore.getState().setSpaceFilter(SPACE_PRO_ID));
    mockViewport(1440);
    renderToday(h.container);
    const empty = await findEmpty('today');
    expect(within(empty).getByRole('heading', { level: 2 })).toHaveTextContent('Aucune tâche Pro aujourd’hui');
    expect(within(empty).queryByRole('button', { name: /Un jour/ })).toBeNull();
    fireEvent.click(within(empty).getByRole('button', { name: 'Ajouter une tâche' }));
    expect(screen.getByLabelText('Nouvelle tâche')).toHaveFocus();
  });

  it('P-06 critère 3 : filtre Perso, tâche Pro seulement, le message nomme Perso', async () => {
    await seedTask(h, { title: 'Facture', spaceId: SPACE_PRO_ID });
    act(() => useAppStore.getState().setSpaceFilter(SPACE_PERSO_ID));
    mockViewport(1440);
    renderToday(h.container);
    expect(await screen.findByRole('heading', { level: 2, name: 'Aucune tâche Perso aujourd’hui' })).toBeInTheDocument();
    expect(screen.queryByText('Facture')).toBeNull();
  });

  it('P-06 critère 6 : disparaît à l’ajout, réapparaît à la suppression de la dernière tâche, disparaît à l’annulation, sans rechargement', async () => {
    mockViewport(1440);
    renderToday(h.container);
    await findEmpty('today');
    const task = await seedTask(h, { title: 'Appeler Paul' });
    await screen.findByRole('button', { name: 'Appeler Paul' });
    expect(emptyOf('today')).toBeNull();
    await act(async () => {
      await createTaskUseCases(h.container).remove([task.id]);
    });
    await findEmpty('today');
    await act(async () => {
      await h.container.undo.undoLast();
    });
    await screen.findByRole('button', { name: 'Appeler Paul' });
    expect(emptyOf('today')).toBeNull();
  });

  it('P-06 critère 8 : un seul titre h2, une seule région d’annonce polie, annonce unique, icônes décoratives', async () => {
    mockViewport(1440);
    renderToday(h.container);
    const empty = await findEmpty('today');
    expect(empty.querySelectorAll('h2')).toHaveLength(1);
    const live = empty.querySelectorAll('[aria-live="polite"]');
    expect(live).toHaveLength(1);
    await waitFor(() => expect(live[0]).toHaveTextContent('Écran vide : Rien de prévu aujourd’hui.'));
    expect(empty.querySelector('.ct-empty__icons')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('P-06 critère 4 : l’action est un vrai bouton focalisable au clavier', async () => {
    mockViewport(1440);
    renderToday(h.container);
    const button = await screen.findByRole('button', { name: 'Ajouter une tâche' });
    expect(button.tagName).toBe('BUTTON');
    expect(button).not.toHaveAttribute('tabindex', '-1');
    button.focus();
    expect(button).toHaveFocus();
  });

  it('P-06 critère 4 : iPhone, « Ajouter une tâche » ouvre la feuille Nouvelle tâche', async () => {
    mockViewport(440);
    renderToday(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Ajouter une tâche' }));
    expect(await screen.findByRole('dialog', { name: 'Nouvelle tâche' })).toBeInTheDocument();
  });

  for (const [name, width] of [['PC', 1440], ['iPhone', 440]] as const) {
    it(`P-06 critères 1 et 3 (${name}) : Semaine vide, action, filtre Pro nommé, disparaît à l’ajout`, async () => {
      mockViewport(width);
      renderWeek(h.container);
      expect(await screen.findByRole('heading', { level: 2, name: 'Rien de prévu cette semaine.' })).toBeInTheDocument();
      expect(within(emptyOf('week') as HTMLElement).getByRole('button', { name: 'Ajouter une tâche' })).toBeInTheDocument();
      act(() => useAppStore.getState().setSpaceFilter(SPACE_PRO_ID));
      expect(await screen.findByRole('heading', { level: 2, name: 'Aucune tâche Pro cette semaine.' })).toBeInTheDocument();
      await seedTask(h, { title: 'Réunion', spaceId: SPACE_PRO_ID });
      await waitFor(() => expect(emptyOf('week')).toBeNull());
    });
  }

  it('P-06 critère 3 : Semaine sous filtre Perso avec une tâche Pro seulement : état vide Perso', async () => {
    await seedTask(h, { title: 'Réunion', spaceId: SPACE_PRO_ID });
    act(() => useAppStore.getState().setSpaceFilter(SPACE_PERSO_ID));
    mockViewport(1440);
    renderWeek(h.container);
    expect(await screen.findByRole('heading', { level: 2, name: 'Aucune tâche Perso cette semaine.' })).toBeInTheDocument();
  });
});
