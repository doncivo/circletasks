import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID } from '../../db/seed/defaultSpaces';
import { addDays } from '../../domain/localDate';
import type { Task } from '../../domain/model';
import { mockViewport, renderToday, setupToday, teardownToday, type TodayHarness } from '../today/testKit';

/** Feuille « Nouvelle tâche » (iPhone) : mêmes marques et mêmes dates que le champ PC (Q-06, Q-02 critère 12). */
describe('Capture rapide : feuille d’ajout iPhone (Q-06, Q-02)', () => {
  let h: TodayHarness;

  beforeEach(async () => {
    mockViewport(440);
    h = await setupToday('a602');
    renderToday(h.container);
  });
  afterEach(async () => {
    await teardownToday(h);
  });

  const created = async (): Promise<Task[]> => [
    ...(await h.container.data.repos.tasks.listForDay(h.today, 'all')),
    ...(await h.container.data.repos.tasks.listForDay(addDays(h.today, 1), 'all')),
  ];
  const openSheet = async (): Promise<HTMLElement> => {
    fireEvent.click(await screen.findByRole('button', { name: 'Ajouter' }));
    return screen.getByLabelText('Titre');
  };

  it('le titre « Appeler le notaire demain 10h #perso » donne date, heure et espace', async () => {
    const title = await openSheet();
    fireEvent.change(title, { target: { value: 'Appeler le notaire demain 10h #perso' } });
    expect(await screen.findByText('demain · 10:00')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await waitFor(async () => expect((await created()).length).toBe(1));
    expect((await created())[0]).toMatchObject({ title: 'Appeler le notaire', spaceId: SPACE_PERSO_ID, date: addDays(h.today, 1), time: '10:00' });
    // Heure donnée : « À l'heure » est cochée d'office (QB-08).
    const reminders = await h.container.data.repos.reminders.listForTarget({ type: 'task', id: (await created())[0]?.id as never });
    expect(reminders.map((r) => r.offsetMin)).toEqual([0]);
  });

  it('la date choisie à la main dans la feuille l’emporte : le texte reste le titre (critère 12)', async () => {
    const title = await openSheet();
    // Puce « Demain » du sélecteur de date.
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Demain' }));
    fireEvent.change(title, { target: { value: 'Appeler après-demain' } });
    expect(screen.queryByRole('group', { name: 'Ce qui sera appliqué' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await waitFor(async () => expect((await created()).length).toBe(1));
    expect((await created())[0]).toMatchObject({ title: 'Appeler après-demain', date: addDays(h.today, 1) });
  });

  it('« #pro » seul : Enregistrer est inactif (titre vide, critère 7)', async () => {
    const title = await openSheet();
    fireEvent.change(title, { target: { value: '#pro' } });
    expect(screen.getByRole('button', { name: 'Enregistrer' })).toBeDisabled();
  });
});
