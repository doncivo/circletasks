import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addDays } from '../../domain/localDate';
import type { Task } from '../../domain/model';
import type { ProjectId } from '../../domain/types';
import { newEntityId } from '../../domain/id';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { useAppStore } from '../app/appStore';
import { mockViewport, renderToday, setupToday, teardownToday, type TodayHarness } from '../today/testKit';

/** Saisie rapide dans le champ d'ajout d'Aujourd'hui (PC) : Q-06 (espace et projet) et Q-02 (date et heure). */
describe('Capture rapide : champ d’ajout d’Aujourd’hui (Q-06, Q-02)', () => {
  let h: TodayHarness;
  let missionId: ProjectId;
  let maisonId: ProjectId;

  beforeEach(async () => {
    mockViewport(1440);
    h = await setupToday('a606');
    const repos = h.container.data.repos;
    const mission = await repos.projects.create({ id: newEntityId<ProjectId>(h.container.ids), spaceId: SPACE_PRO_ID, name: 'Mission', color: '#2F6B7A' as never, archived: false, sortOrder: 1 });
    const maison = await repos.projects.create({ id: newEntityId<ProjectId>(h.container.ids), spaceId: SPACE_PERSO_ID, name: 'Maison', color: '#B5651D' as never, archived: false, sortOrder: 2 });
    const ancien = await repos.projects.create({ id: newEntityId<ProjectId>(h.container.ids), spaceId: SPACE_PRO_ID, name: 'Ancien', color: '#2F6B7A' as never, archived: true, sortOrder: 3 });
    missionId = mission.id;
    maisonId = maison.id;
    useAppStore.getState().setProjects([mission, maison, ancien]);
    renderToday(h.container);
  });

  afterEach(async () => {
    await teardownToday(h);
  });

  const field = (): HTMLInputElement => screen.getByLabelText('Nouvelle tâche');
  const type = (value: string): void => {
    fireEvent.change(field(), { target: { value } });
  };
  const submit = (): void => {
    fireEvent.submit(field().closest('form') as HTMLFormElement);
  };
  const created = async (): Promise<Task[]> => [
    ...(await h.container.data.repos.tasks.listForDay(h.today, 'all')),
    ...(await h.container.data.repos.tasks.listForDay(addDays(h.today, 1), 'all')),
  ];

  it('« Relancer client demain 9h30 #perso @maison » : aperçu, puis tâche rangée, datée et titrée (Q-06 critère 1, Q-02 critère 1)', async () => {
    await screen.findByRole('heading', { level: 1 });
    type('Relancer client demain 9h30 #perso @maison');
    const group = await screen.findByRole('group', { name: 'Ce qui sera appliqué' });
    expect(within(group).getByText('Perso · Maison')).toBeInTheDocument();
    expect(within(group).getByText('demain · 09:30')).toBeInTheDocument();
    // Le texte tapé reste intact jusqu'à l'envoi (D4).
    expect(field()).toHaveValue('Relancer client demain 9h30 #perso @maison');
    submit();
    await waitFor(async () => expect((await created()).length).toBe(1));
    const [task] = await created();
    expect(task).toMatchObject({ title: 'Relancer client', spaceId: SPACE_PERSO_ID, projectId: maisonId, date: addDays(h.today, 1), time: '09:30' });
    await waitFor(() => expect(field()).toHaveValue(''));
    expect(screen.queryByRole('group', { name: 'Ce qui sera appliqué' })).toBeNull();
  });

  it('« @mission » sans « # » : l’espace est celui du projet (critère 4)', async () => {
    await screen.findByRole('heading', { level: 1 });
    type('Écrire le devis @mission');
    submit();
    await waitFor(async () => expect((await created()).length).toBe(1));
    expect((await created())[0]).toMatchObject({ title: 'Écrire le devis', spaceId: SPACE_PRO_ID, projectId: missionId });
  });

  it('projet d’un autre espace : le mot reste dans le titre et « Projet inconnu dans Perso » s’affiche (critère 5)', async () => {
    await screen.findByRole('heading', { level: 1 });
    type('Écrire #perso @mission');
    expect(await screen.findByText('Projet inconnu dans Perso')).toBeInTheDocument();
    submit();
    await waitFor(async () => expect((await created()).length).toBe(1));
    expect((await created())[0]).toMatchObject({ title: 'Écrire @mission', spaceId: SPACE_PERSO_ID, projectId: null });
  });

  it('« #pro » seul ne crée rien (critère 7)', async () => {
    await screen.findByRole('heading', { level: 1 });
    type('#pro');
    submit();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await created()).toHaveLength(0);
    expect(field()).toHaveValue('#pro');
  });

  it('retirer la pastille de date rend le texte au titre et ne pose rien (Q-02 critère 9)', async () => {
    await screen.findByRole('heading', { level: 1 });
    type('Appeler le notaire demain 10h');
    const group = await screen.findByRole('group', { name: 'Ce qui sera appliqué' });
    fireEvent.click(within(group).getByRole('button', { name: 'Retirer demain · 10:00' }));
    expect(screen.queryByRole('group', { name: 'Ce qui sera appliqué' })).toBeNull();
    submit();
    await waitFor(async () => expect((await created()).length).toBe(1));
    expect((await created())[0]).toMatchObject({ title: 'Appeler le notaire demain 10h', date: h.today, time: null });
  });

  it('Échap sur la pastille la retire aussi', async () => {
    await screen.findByRole('heading', { level: 1 });
    type('Relancer #perso');
    const group = await screen.findByRole('group', { name: 'Ce qui sera appliqué' });
    fireEvent.keyDown(within(group).getByRole('button', { name: 'Retirer Perso' }), { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Ce qui sera appliqué' })).toBeNull();
    expect(field()).toHaveValue('Relancer #perso');
  });

  it('la pastille est annoncée : « Espace Perso, projet Maison » (critère 11)', async () => {
    await screen.findByRole('heading', { level: 1 });
    type('Relancer #perso @maison');
    await waitFor(() => expect(screen.getByText('Espace Perso, projet Maison', { exact: false })).toBeInTheDocument());
  });

  describe('suggestions (combobox ARIA)', () => {
    it('« # » liste les espaces, « #pe » filtre, Entrée complète le mot (critère 2)', async () => {
      await screen.findByRole('heading', { level: 1 });
      expect(field()).not.toHaveAttribute('aria-expanded');
      type('Appeler #');
      const list = await screen.findByRole('listbox', { name: 'Suggestions' });
      expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(['#Pro', '#Perso']);
      expect(field()).toHaveAttribute('role', 'combobox');
      expect(field()).toHaveAttribute('aria-expanded', 'true');
      expect(field()).toHaveAttribute('aria-controls', list.id);
      type('Appeler #pe');
      expect(within(await screen.findByRole('listbox')).getAllByRole('option')).toHaveLength(1);
      const option = screen.getByRole('option');
      expect(field()).toHaveAttribute('aria-activedescendant', option.id);
      fireEvent.keyDown(field(), { key: 'Enter' });
      expect(field()).toHaveValue('Appeler #Perso ');
      expect(screen.queryByRole('listbox')).toBeNull();
      // Entrée n'a pas créé la tâche : elle a seulement complété le mot.
      expect(await created()).toHaveLength(0);
    });

    it('flèches et Entrée choisissent une autre ligne ; toucher complète aussi', async () => {
      await screen.findByRole('heading', { level: 1 });
      type('#');
      await screen.findByRole('listbox');
      fireEvent.keyDown(field(), { key: 'ArrowDown' });
      expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
      fireEvent.keyDown(field(), { key: 'Enter' });
      expect(field()).toHaveValue('#Perso ');
      type('Lire @');
      fireEvent.click(await screen.findByRole('option', { name: /Maison/ }));
      expect(field()).toHaveValue('Lire @Maison ');
    });

    it('« @ » propose les projets actifs avec leur espace, jamais un projet archivé (critère 3)', async () => {
      await screen.findByRole('heading', { level: 1 });
      type('Lire @');
      const options = await screen.findAllByRole('option');
      expect(options.map((o) => o.textContent)).toEqual(['@MissionPro', '@MaisonPerso']);
      type('Lire #perso @');
      expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['@Maison']);
    });

    it('Échap ferme la liste sans effacer la saisie', async () => {
      await screen.findByRole('heading', { level: 1 });
      type('Appeler #p');
      await screen.findByRole('listbox');
      fireEvent.keyDown(field(), { key: 'Escape' });
      expect(screen.queryByRole('listbox')).toBeNull();
      expect(field()).toHaveValue('Appeler #p');
    });
  });
});
