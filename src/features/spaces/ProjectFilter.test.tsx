import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { createTaskUseCases } from '../tasks/createTaskUseCases';
import { TaskDetail } from '../tasks/TaskDetail';
import { mockViewport, renderToday, seedTask, setupToday, teardownToday, type TodayHarness } from '../today/testKit';
import { WeekScreen } from '../week/WeekScreen';
import { seedProject } from './testKit';

const pill = (name: string) => within(screen.getByRole('group', { name: 'Filtre d’espace' })).getByRole('button', { name });
const projectMenu = () => screen.queryByRole('combobox', { name: 'Filtre de projet' });

describe('Filtre par projet : menu « Projet : tous » (QB-15, ES-04 critère 6)', () => {
  let h: TodayHarness;
  beforeEach(async () => {
    mockViewport(440);
    h = await setupToday('e5007');
  });
  afterEach(() => teardownToday(h));

  async function seedWork() {
    const mission = await seedProject(h, SPACE_PRO_ID, 'Mission client');
    const site = await seedProject(h, SPACE_PRO_ID, 'Refonte site');
    const inMission = await seedTask(h, { title: 'Envoyer la facture', spaceId: SPACE_PRO_ID });
    await h.container.data.repos.tasks.update(inMission.id, { projectId: mission.id });
    const inSite = await seedTask(h, { title: 'Maquette accueil', spaceId: SPACE_PRO_ID });
    await h.container.data.repos.tasks.update(inSite.id, { projectId: site.id });
    await seedTask(h, { title: 'Sans projet', spaceId: SPACE_PRO_ID });
    await seedTask(h, { title: 'Appeler maman', spaceId: SPACE_PERSO_ID });
    return { mission, site };
  }

  it('masqué en « Tout » ; visible sous Pro (projets actifs) ; masqué sous Perso (aucun projet)', async () => {
    await seedWork();
    renderToday(h.container);
    await screen.findByText('Sans projet');
    expect(projectMenu()).toBeNull();
    fireEvent.click(pill('Pro'));
    expect(await screen.findByRole('combobox', { name: 'Filtre de projet' })).toBeInTheDocument();
    expect(screen.getByText('Projet : tous')).toBeInTheDocument();
    const options = within(screen.getByRole('combobox', { name: 'Filtre de projet' })).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['Tous les projets', 'Mission client', 'Refonte site']);
    fireEvent.click(pill('Perso'));
    expect(projectMenu()).toBeNull();
    fireEvent.click(pill('Tout'));
    expect(projectMenu()).toBeNull();
  });

  it('choisir « Mission client » ne garde que ses tâches ; « Tous les projets » retire le filtre', async () => {
    const { mission } = await seedWork();
    renderToday(h.container);
    await screen.findByText('Sans projet');
    fireEvent.click(pill('Pro'));
    const menu = await screen.findByRole('combobox', { name: 'Filtre de projet' });
    fireEvent.change(menu, { target: { value: mission.id } });
    await waitFor(() => expect(screen.queryByText('Sans projet')).toBeNull());
    expect(screen.getByText('Envoyer la facture')).toBeInTheDocument();
    expect(screen.queryByText('Maquette accueil')).toBeNull();
    expect(screen.getByText('Projet : Mission client')).toBeInTheDocument();
    fireEvent.change(menu, { target: { value: '' } });
    await screen.findByText('Sans projet');
    expect(screen.getByText('Maquette accueil')).toBeInTheDocument();
    expect(screen.getByText('Projet : tous')).toBeInTheDocument();
  });

  it('changer d’espace remet « Projet : tous » ; revenir sous Pro ne rétablit pas le projet', async () => {
    const { mission } = await seedWork();
    renderToday(h.container);
    await screen.findByText('Sans projet');
    fireEvent.click(pill('Pro'));
    fireEvent.change(await screen.findByRole('combobox', { name: 'Filtre de projet' }), { target: { value: mission.id } });
    await waitFor(() => expect(screen.queryByText('Sans projet')).toBeNull());
    fireEvent.click(pill('Perso'));
    expect(await screen.findByText('Appeler maman')).toBeInTheDocument();
    expect(useAppStore.getState().projectFilter).toBeNull();
    fireEvent.click(pill('Pro'));
    expect(await screen.findByText('Sans projet')).toBeInTheDocument();
    expect(screen.getByText('Projet : tous')).toBeInTheDocument();
  });

  it('archiver le projet filtré retire le filtre', async () => {
    const { mission } = await seedWork();
    renderToday(h.container);
    await screen.findByText('Sans projet');
    fireEvent.click(pill('Pro'));
    fireEvent.change(await screen.findByRole('combobox', { name: 'Filtre de projet' }), { target: { value: mission.id } });
    await waitFor(() => expect(screen.queryByText('Sans projet')).toBeNull());
    const { spacesStore } = await import('./spacesStore');
    await act(async () => void (await spacesStore.get(h.container).getState().setProjectArchived(mission.id, true)));
    expect(await screen.findByText('Sans projet')).toBeInTheDocument();
    expect(useAppStore.getState().projectFilter).toBeNull();
  });

  it('la Semaine applique le même filtre projet', async () => {
    const { mission } = await seedWork();
    act(() => useAppStore.getState().setSpaceFilter(SPACE_PRO_ID));
    act(() => useAppStore.getState().setProjectFilter(mission.id));
    render(
      <AppContainerProvider container={h.container}>
        <WeekScreen />
      </AppContainerProvider>,
    );
    expect(await screen.findByText('Envoyer la facture')).toBeInTheDocument();
    expect(screen.queryByText('Sans projet')).toBeNull();
    expect(screen.getByText('Projet : Mission client')).toBeInTheDocument();
  });

  it('état vide sous un filtre projet : « Aucune tâche Pro aujourd’hui »', async () => {
    const { mission } = await seedWork();
    act(() => useAppStore.getState().setSpaceFilter(SPACE_PRO_ID));
    act(() => useAppStore.getState().setProjectFilter(mission.id));
    await h.container.data.repos.tasks.update((await h.container.data.repos.tasks.listForDay(h.today, SPACE_PRO_ID)).find((t) => t.title === 'Envoyer la facture')?.id as never, { date: null, someday: true });
    renderToday(h.container);
    expect(await screen.findByText('Aucune tâche Pro aujourd’hui')).toBeInTheDocument();
  });
});

describe('Projet à la création et dans la fiche (ES-04 critères 4, 5, 7)', () => {
  let h: TodayHarness;
  beforeEach(async () => {
    h = await setupToday('e5008');
  });
  afterEach(() => teardownToday(h));

  const sheetProject = (dialog: HTMLElement) => within(dialog).getByRole('combobox', { name: 'Projet' });
  const optionTexts = (select: HTMLElement) => within(select).getAllByRole('option').map((o) => o.textContent);

  it('feuille d’ajout : « Aucun » puis les projets actifs de l’espace choisi ; changer d’espace remet « Projet : aucun »', async () => {
    mockViewport(440);
    const mission = await seedProject(h, SPACE_PRO_ID, 'Mission client');
    await seedProject(h, SPACE_PRO_ID, 'Ancien', { archived: true });
    await seedProject(h, SPACE_PERSO_ID, 'Maison');
    renderToday(h.container);
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nouvelle tâche' });
    expect(within(dialog).getByText('Projet : aucun')).toBeInTheDocument();
    expect(optionTexts(sheetProject(dialog))).toEqual(['Aucun', 'Mission client']);
    fireEvent.change(sheetProject(dialog), { target: { value: mission.id } });
    expect(within(dialog).getByText('Projet : Mission client')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Perso' }));
    expect(within(dialog).getByText('Projet : aucun')).toBeInTheDocument();
    expect(optionTexts(sheetProject(dialog))).toEqual(['Aucun', 'Maison']);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Pro' }));
    fireEvent.change(sheetProject(dialog), { target: { value: mission.id } });
    fireEvent.change(within(dialog).getByLabelText('Titre'), { target: { value: 'Préparer la réunion' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const [task] = await h.container.data.repos.tasks.listForDay(h.today, 'all');
    expect(task).toMatchObject({ title: 'Préparer la réunion', spaceId: SPACE_PRO_ID, projectId: mission.id });
  });

  it('un projet n’est jamais obligatoire : la tâche se crée sans projet (critère 7)', async () => {
    mockViewport(440);
    await seedProject(h, SPACE_PRO_ID, 'Mission client');
    renderToday(h.container);
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nouvelle tâche' });
    fireEvent.change(within(dialog).getByLabelText('Titre'), { target: { value: 'Sans projet' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect((await h.container.data.repos.tasks.listForDay(h.today, 'all'))[0]?.projectId).toBeNull();
  });

  it('saisie en ligne sous un filtre projet : la tâche est créée dans ce projet', async () => {
    mockViewport(1440);
    const mission = await seedProject(h, SPACE_PRO_ID, 'Mission client');
    act(() => useAppStore.getState().setSpaceFilter(SPACE_PRO_ID));
    act(() => useAppStore.getState().setProjectFilter(mission.id));
    renderToday(h.container);
    const field = screen.getByLabelText('Nouvelle tâche');
    fireEvent.change(field, { target: { value: 'Relancer le client' } });
    fireEvent.submit(field.closest('form') as HTMLFormElement);
    expect(await screen.findByText('Relancer le client')).toBeInTheDocument();
    expect((await h.container.data.repos.tasks.listForDay(h.today, 'all'))[0]?.projectId).toBe(mission.id);
  });

  it('le cas d’usage ignore un projet d’un autre espace (règle « projet de l’espace de l’élément »)', async () => {
    const maison = await seedProject(h, SPACE_PERSO_ID, 'Maison');
    const result = await createTaskUseCases(h.container).create({ title: 'Peindre', spaceId: SPACE_PRO_ID, projectId: maison.id, date: h.today });
    expect(result.ok && result.value.projectId).toBeNull();
    const ok = await createTaskUseCases(h.container).create({ title: 'Peindre le salon', spaceId: SPACE_PERSO_ID, projectId: maison.id, date: h.today });
    expect(ok.ok && ok.value.projectId).toBe(maison.id);
  });

  describe('fiche détail PC', () => {
    afterEach(() => useNavigationStore.setState(INITIAL_NAVIGATION));

    async function openDetail(projectId: string | null, spaceId = SPACE_PRO_ID) {
      mockViewport(1440);
      const created = await createTaskUseCases(h.container).create({ title: 'Envoyer la facture', spaceId, date: h.today, ...(projectId ? { projectId: projectId as never } : {}) });
      if (!created.ok) throw new Error('création impossible');
      useNavigationStore.getState().openDetail({ type: 'task', id: created.value.id });
      render(
        <AppContainerProvider container={h.container}>
          <TaskDetail />
        </AppContainerProvider>,
      );
      await screen.findByRole('complementary');
      return created.value;
    }

    it('« Projet » liste les projets actifs de l’espace ; un choix ne change que le projet (ES-05 critère 2)', async () => {
      const mission = await seedProject(h, SPACE_PRO_ID, 'Mission client');
      const site = await seedProject(h, SPACE_PRO_ID, 'Refonte site');
      const task = await openDetail(mission.id);
      const select = screen.getByRole('combobox', { name: 'Projet' });
      expect(optionTexts(select)).toEqual(['Aucun', 'Mission client', 'Refonte site']);
      expect(screen.getByText('Projet : Mission client')).toBeInTheDocument();
      fireEvent.change(select, { target: { value: site.id } });
      await waitFor(async () => expect((await h.container.data.repos.tasks.getById(task.id))?.projectId).toBe(site.id));
      expect((await h.container.data.repos.tasks.getById(task.id))?.spaceId).toBe(SPACE_PRO_ID);
      fireEvent.change(select, { target: { value: '' } });
      await waitFor(async () => expect((await h.container.data.repos.tasks.getById(task.id))?.projectId).toBeNull());
    });

    it('un projet archivé reste affiché sur sa tâche sans être proposé (critère 5)', async () => {
      const vieux = await seedProject(h, SPACE_PRO_ID, 'Vieux projet', { archived: true });
      await seedProject(h, SPACE_PRO_ID, 'Actif');
      await openDetail(vieux.id);
      expect(screen.getByText('Projet : Vieux projet (archivé)')).toBeInTheDocument();
      expect(optionTexts(screen.getByRole('combobox', { name: 'Projet' }))).toEqual(['Aucun', 'Actif', 'Vieux projet (archivé)']);
    });

    it('sans projet dans l’espace : « Aucun » en texte, aucune liste', async () => {
      await openDetail(null);
      expect(screen.queryByRole('combobox', { name: 'Projet' })).toBeNull();
    });
  });
});
