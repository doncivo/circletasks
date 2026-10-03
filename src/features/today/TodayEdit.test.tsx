import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addDays } from '../../domain/localDate';
import type { Routine } from '../../domain/model';
import { asEntityId, asLocalTime, type RoutineId } from '../../domain/types';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import type { KeyInput } from '../app/shortcuts';
import { mockViewport, renderToday, seedTask, setupToday, teardownToday, type TodayHarness } from './testKit';
import { registerTodaySource } from './todaySources';
import { todayStore } from './todayStore';

const keyInput = (key: string, over: Partial<KeyInput> = {}): KeyInput => ({ key, code: key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, editable: false, ...over });
const titles = (): string[] => screen.getAllByRole('listitem').map((item) => item.querySelector('.ct-list-row__title')?.textContent ?? '');
const toggle = () => screen.getByRole('button', { name: 'Mode édition' });
const select = (title: string) => fireEvent.click(screen.getByRole('button', { name: `Sélectionner : ${title}` }));

describe('Aujourd’hui : mode édition (A-05)', () => {
  let h: TodayHarness;
  const off: (() => void)[] = [];

  beforeEach(async () => {
    h = await setupToday('105');
    mockViewport(440);
  });
  afterEach(async () => {
    for (const fn of off.splice(0)) fn();
    await teardownToday(h);
  });

  async function openEditMode(...names: string[]): Promise<void> {
    for (const title of names) await seedTask(h, { title, time: '09:00' });
    renderToday(h.container);
    await screen.findByRole('button', { name: names[0] as string });
    fireEvent.click(toggle());
  }

  it('l’interrupteur est annoncé, et le mode édition affiche rond, « − » et poignée à la place de la case (critères 1, 12)', async () => {
    await seedTask(h, { title: 'Envoyer la facture', time: '09:00' });
    renderToday(h.container);
    await screen.findByRole('button', { name: 'Envoyer la facture' });
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('checkbox', { name: 'Terminer : Envoyer la facture' })).toBeInTheDocument();

    fireEvent.click(toggle());
    expect(toggle()).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('checkbox', { name: 'Terminer : Envoyer la facture' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Sélectionner : Envoyer la facture' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Supprimer : Envoyer la facture' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Déplacer : Envoyer la facture' })).toBeInTheDocument();

    fireEvent.click(toggle());
    expect(screen.getByRole('checkbox', { name: 'Terminer : Envoyer la facture' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sélectionner/ })).toBeNull();
  });

  it('une tâche terminée affiche « Fait », reste sélectionnable et n’a pas de poignée', async () => {
    await seedTask(h, { title: 'Faire mon lit' });
    renderToday(h.container);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Terminer : Faire mon lit' }));
    await screen.findByRole('checkbox', { name: 'Rouvrir : Faire mon lit' });
    fireEvent.click(toggle());
    const row = screen.getByRole('button', { name: 'Faire mon lit' }).closest('.ct-list-row') as HTMLElement;
    expect(row).toHaveTextContent('Fait');
    expect(within(row).getByRole('button', { name: 'Sélectionner : Faire mon lit' })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /Déplacer/ })).toBeNull();
  });

  it('« − » demande confirmation, supprime vers la corbeille et propose d’annuler (critère 2)', async () => {
    await openEditMode('Courses', 'Autre');
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer : Courses' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveAccessibleName('Supprimer « Courses » ?');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Supprimer' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Courses' })).toBeNull());
    expect(await screen.findByRole('status')).toHaveTextContent('« Courses » supprimée');
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(await screen.findByRole('button', { name: 'Courses' })).toBeInTheDocument();
  });

  it('la barre « N sélectionnées » apparaît au-dessus du champ d’ajout, au singulier pour une, masquée sans sélection (critère 4)', async () => {
    await openEditMode('A', 'B', 'C');
    expect(screen.queryByRole('toolbar')).toBeNull();
    select('A');
    expect(screen.getByRole('toolbar', { name: 'Actions sur la sélection' })).toHaveTextContent('1 sélectionnée');
    expect(screen.getByRole('button', { name: 'Désélectionner : A' })).toHaveAttribute('aria-pressed', 'true');
    select('B');
    expect(screen.getByRole('toolbar')).toHaveTextContent('2 sélectionnées');
    const bar = screen.getByRole('toolbar');
    const field = screen.getByLabelText('Nouvelle tâche');
    expect(bar.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Désélectionner : A' }));
    fireEvent.click(screen.getByRole('button', { name: 'Désélectionner : B' }));
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('« Reporter » s’applique à toute la sélection, une seule annulation rétablit tout (critère 5)', async () => {
    await openEditMode('A', 'B', 'C');
    select('A');
    select('B');
    fireEvent.click(screen.getByRole('button', { name: 'Reporter' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Demain' }));
    await waitFor(() => expect(titles()).toEqual(['C']));
    expect(await screen.findByRole('status')).toHaveTextContent('2 tâches reportées');
    expect(screen.queryByRole('toolbar')).toBeNull();
    const tomorrow = await h.container.data.repos.tasks.listForDay(addDays(h.today, 1), 'all');
    expect(tomorrow.map((task) => task.title).sort()).toEqual(['A', 'B']);

    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    await waitFor(() => expect(titles().sort()).toEqual(['A', 'B', 'C']));
  });

  it('« Supprimer » : « Supprimer 2 tâches ? », corbeille, annulable en une fois (critère 6)', async () => {
    await openEditMode('A', 'B', 'C');
    select('A');
    select('C');
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveAccessibleName('Supprimer 2 tâches ?');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Supprimer' }));
    await waitFor(() => expect(titles()).toEqual(['B']));
    expect(await screen.findByRole('status')).toHaveTextContent('2 tâches supprimées');
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    await waitFor(() => expect(titles().sort()).toEqual(['A', 'B', 'C']));
  });

  it('« Supprimer » avec une seule tâche sélectionnée suit la confirmation de T-08', async () => {
    await openEditMode('A', 'B');
    select('A');
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer' }));
    expect(await screen.findByRole('alertdialog')).toHaveAccessibleName('Supprimer « A » ?');
  });

  it('« Déplacer » change l’espace de la sélection sans changer la date, annulable en une fois (Q12, critère 7)', async () => {
    await openEditMode('A', 'B');
    select('A');
    select('B');
    fireEvent.click(screen.getByRole('button', { name: 'Déplacer' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveAccessibleName('Déplacer vers un espace ou un projet');
    expect(within(dialog).getByText(/La date ne change pas/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Perso · aucun projet' }));
    await waitFor(async () => {
      const stored = await h.container.data.repos.tasks.listForDay(h.today, 'all');
      expect(stored.map((task) => task.spaceId)).toEqual([SPACE_PERSO_ID, SPACE_PERSO_ID]);
    });
    const stored = await h.container.data.repos.tasks.listForDay(h.today, 'all');
    expect(stored.every((task) => task.date === h.today && task.time === '09:00')).toBe(true);
    expect(await screen.findByRole('status')).toHaveTextContent('2 tâches déplacées dans Perso');
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    await waitFor(async () => {
      const back = await h.container.data.repos.tasks.listForDay(h.today, 'all');
      expect(back.map((task) => task.spaceId)).toEqual([SPACE_PRO_ID, SPACE_PRO_ID]);
    });
  });

  it('désactiver l’interrupteur vide la sélection ; le mode n’est pas mémorisé quand l’écran se ferme (critère 9)', async () => {
    await openEditMode('A', 'B');
    select('A');
    fireEvent.click(toggle());
    expect(screen.queryByRole('toolbar')).toBeNull();
    fireEvent.click(toggle());
    expect(screen.queryByRole('toolbar')).toBeNull();
    expect(screen.getByRole('button', { name: 'Sélectionner : A' })).toHaveAttribute('aria-pressed', 'false');

    select('A');
    cleanup();
    expect(todayStore.get(h.container).getState()).toMatchObject({ editMode: false });
    expect(todayStore.get(h.container).getState().selection.size).toBe(0);
    renderToday(h.container);
    await screen.findByRole('button', { name: 'A' });
    expect(toggle()).toHaveAttribute('aria-pressed', 'false');
  });

  it('Échap quitte le mode édition ; Ctrl+clic et Maj+clic étendent la sélection ; Suppr supprime la sélection (critère 10)', async () => {
    mockViewport(1440);
    await openEditMode('A', 'B', 'C', 'D');
    // Ctrl+clic sur le titre d'une ligne : bascule la sélection au lieu d'ouvrir la fiche.
    fireEvent.click(screen.getByRole('button', { name: 'B' }), { ctrlKey: true });
    expect(screen.getByRole('toolbar')).toHaveTextContent('1 sélectionnée');
    expect(screen.queryByRole('complementary', { name: 'Détail de la tâche' })).toBeNull();
    // Maj+clic : de B à D inclus.
    fireEvent.click(screen.getByRole('button', { name: 'D' }), { shiftKey: true });
    expect(screen.getByRole('toolbar')).toHaveTextContent('3 sélectionnées');
    expect(screen.getByRole('button', { name: 'Sélectionner : A' })).toBeInTheDocument();

    // Suppr : confirmation de la sélection.
    act(() => screen.getByRole('button', { name: 'B' }).focus());
    act(() => {
      h.container.shortcuts.handle(keyInput('Delete'));
    });
    expect(await screen.findByRole('alertdialog')).toHaveAccessibleName('Supprimer 3 tâches ?');
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());

    act(() => {
      h.container.shortcuts.handle(keyInput('Escape', { editable: true }));
    });
    await waitFor(() => expect(toggle()).toHaveAttribute('aria-pressed', 'false'));
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('Espace sur une ligne sélectionne en mode édition au lieu de terminer', async () => {
    mockViewport(1440);
    await openEditMode('A', 'B');
    act(() => screen.getByRole('button', { name: 'A' }).focus());
    act(() => {
      h.container.shortcuts.handle(keyInput('Space', { key: ' ' }));
    });
    expect(screen.getByRole('toolbar')).toHaveTextContent('1 sélectionnée');
    expect(screen.queryByRole('checkbox', { name: /Rouvrir/ })).toBeNull();
  });

  it('une routine n’a ni rond, ni « − », ni poignée en mode édition (Q13, critère 8) ; objectif et événement non plus', async () => {
    const routine = {
      id: asEntityId<RoutineId>('70000000-0000-4000-8000-0000000000a5'),
      spaceId: SPACE_PRO_ID,
      title: 'Boire de l’eau',
      icon: null,
      time: asLocalTime('08:30'),
      paused: false,
      archived: false,
      deletedAt: null,
    } as unknown as Routine;
    off.push(
      registerTodaySource({
        id: 'q13',
        load: () =>
          Promise.resolve({
            routines: [{ routine, done: false }],
            events: [{ id: 'e', title: 'Point client', allDay: false, startTime: asLocalTime('10:00'), spaceId: null, calendarName: 'Google Agenda', icon: null }],
          }),
      }),
    );
    await openEditMode('Tâche');
    await screen.findByText('Boire de l’eau');
    expect(screen.getByRole('button', { name: 'Sélectionner : Tâche' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sélectionner : Boire/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Supprimer : Boire/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Déplacer : Boire/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Sélectionner : Point client/ })).toBeNull();
  });

  it('le champ « Ajouter une tâche » reste utilisable en mode édition (critère 11)', async () => {
    await openEditMode('A');
    const field = screen.getByLabelText('Nouvelle tâche');
    fireEvent.change(field, { target: { value: 'Nouvelle' } });
    fireEvent.submit(field.closest('form') as HTMLFormElement);
    expect(await screen.findByRole('button', { name: 'Sélectionner : Nouvelle' })).toBeInTheDocument();
  });
});
