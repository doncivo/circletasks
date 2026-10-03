import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import type { ChecklistId } from '../../domain/types';
import { useAppStore } from '../app/appStore';
import { useNavigationStore } from '../app/navigation';
import { useNoticeStore } from '../app/notice';
import { seedProject } from '../spaces/testKit';
import { mockViewport, renderChecklists, seedChecklist, setupChecklists, teardownChecklists, typeItem, type ChecklistsHarness } from './testKit';

const itemTexts = (): string[] => screen.queryAllByRole('listitem').map((node) => node.textContent ?? '');

describe('Checklists : création et items à la chaîne (C-01), iPhone', () => {
  let h: ChecklistsHarness;

  beforeEach(async () => {
    h = await setupChecklists('301');
    mockViewport(440);
  });
  afterEach(() => teardownChecklists(h));

  it('zéro checklist : état vide et bouton de création (critère 7)', async () => {
    renderChecklists(h.container);
    expect(await screen.findByText('Aucune checklist pour l’instant')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Nouvelle checklist' })).toBeInTheDocument();
  });

  it('sous un filtre d’espace, l’état vide nomme l’espace (critère 7)', async () => {
    useAppStore.getState().setSpaceFilter(SPACE_PERSO_ID);
    renderChecklists(h.container);
    expect(await screen.findByText('Aucune checklist Perso.')).toBeInTheDocument();
  });

  it('« + » ouvre la feuille ; « Créer » est inactif tant que le titre est vide (critère 1)', async () => {
    renderChecklists(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Nouvelle checklist' }));
    const sheet = await screen.findByRole('dialog', { name: 'Nouvelle checklist' });
    const create = within(sheet).getByRole('button', { name: 'Créer' });
    expect(create).toBeDisabled();
    fireEvent.change(within(sheet).getByLabelText('Titre de la checklist'), { target: { value: '   ' } });
    expect(create).toBeDisabled();
    fireEvent.change(within(sheet).getByLabelText('Titre de la checklist'), { target: { value: 'Valise voyage' } });
    expect(create).toBeEnabled();
    expect(within(sheet).getByRole('radiogroup', { name: 'Icône' })).toBeInTheDocument();
    expect(within(sheet).getByRole('group', { name: 'Espace de la checklist' })).toBeInTheDocument();
  });

  it('créer ouvre la checklist vide avec le focus dans « Nouvel élément » (critère 2)', async () => {
    renderChecklists(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Nouvelle checklist' }));
    const sheet = await screen.findByRole('dialog', { name: 'Nouvelle checklist' });
    fireEvent.change(within(sheet).getByLabelText('Titre de la checklist'), { target: { value: '  Valise voyage ' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Créer' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Valise voyage' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(screen.getByLabelText('Nouvel élément')).toHaveFocus());
    expect(itemTexts()).toEqual([]);
    const stored = await h.container.data.repos.checklists.listSummaries('all');
    expect(stored.map((s) => [s.checklist.title, s.checklist.spaceId, s.total])).toEqual([['Valise voyage', SPACE_PRO_ID, 0]]);
  });

  it('« Ajouté dans Perso » apparaît quand l’espace choisi diffère du filtre (critère 2, ES-02)', async () => {
    useAppStore.getState().setSpaceFilter(SPACE_PRO_ID);
    renderChecklists(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Nouvelle checklist' }));
    const sheet = await screen.findByRole('dialog', { name: 'Nouvelle checklist' });
    fireEvent.change(within(sheet).getByLabelText('Titre de la checklist'), { target: { value: 'Courses' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Perso' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Créer' }));
    await waitFor(() => expect(useNoticeStore.getState().notice?.text).toBe('Ajouté dans Perso'));
    expect(useAppStore.getState().spaceFilter).toBe(SPACE_PRO_ID);
  });

  it('l’espace proposé suit le filtre actif (critère 1, ES-02)', async () => {
    useAppStore.getState().setSpaceFilter(SPACE_PERSO_ID);
    renderChecklists(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Nouvelle checklist' }));
    const sheet = await screen.findByRole('dialog', { name: 'Nouvelle checklist' });
    expect(within(sheet).getByRole('button', { name: 'Perso' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(sheet).getByRole('button', { name: 'Pro' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('Entrée ajoute l’item en fin de liste, vide le champ et lui garde le focus (critère 3)', async () => {
    await seedChecklist(h, { title: 'Valise voyage', items: ['Chargeur'] });
    renderChecklists(h.container);
    await screen.findByText('Chargeur');
    const input = screen.getByLabelText('Nouvel élément');
    input.focus();
    typeItem('Passeport');
    await waitFor(() => expect(itemTexts()).toEqual(['Chargeur', 'Passeport']));
    expect(input).toHaveValue('');
    expect(input).toHaveFocus();
    typeItem('Billets');
    typeItem('Crème solaire');
    await waitFor(() => expect(itemTexts()).toEqual(['Chargeur', 'Passeport', 'Billets', 'Crème solaire']));
  });

  it('Entrée sur un champ vide ou blanc n’ajoute rien (critère 3)', async () => {
    await seedChecklist(h, { title: 'Valise voyage' });
    renderChecklists(h.container);
    await screen.findByRole('heading', { level: 1, name: 'Valise voyage' });
    typeItem('');
    typeItem('    ');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(itemTexts()).toEqual([]);
    expect(await h.container.data.repos.checklists.listSummaries('all')).toMatchObject([{ total: 0 }]);
  });

  it('un item fait 1 à 200 caractères, espaces de bord retirés (critère 3)', async () => {
    await seedChecklist(h, { title: 'Valise voyage' });
    renderChecklists(h.container);
    await screen.findByRole('heading', { level: 1, name: 'Valise voyage' });
    expect(screen.getByLabelText('Nouvel élément')).toHaveAttribute('maxlength', '200');
    typeItem('  Passeport  ');
    await waitFor(() => expect(itemTexts()).toEqual(['Passeport']));
  });

  it('la pastille de titre ouvre la liste de choix, triée par titre sans tenir compte des accents (critère 4)', async () => {
    await seedChecklist(h, { title: 'Zèbre' });
    await seedChecklist(h, { title: 'abeille' });
    await seedChecklist(h, { title: 'Éclair' });
    renderChecklists(h.container);
    const chooser = await screen.findByRole('combobox', { name: 'Choisir une checklist' });
    expect(within(chooser).getAllByRole('option').map((option) => option.getAttribute('value') && option.textContent?.split(' · ')[0])).toEqual(['abeille', 'Éclair', 'Zèbre']);
    expect(screen.getByRole('heading', { level: 1, name: 'abeille' })).toBeInTheDocument();
    fireEvent.change(chooser, { target: { value: (await h.container.data.repos.checklists.listSummaries('all')).find((s) => s.checklist.title === 'Zèbre')?.checklist.id } });
    expect(await screen.findByRole('heading', { level: 1, name: 'Zèbre' })).toBeInTheDocument();
    expect(useNavigationStore.getState().lastRoutes.checklists.checklistId).not.toBeNull();
  });

  it('la sélection est conservée entre deux onglets (critère 4)', async () => {
    await seedChecklist(h, { title: 'Courses' });
    const second = await seedChecklist(h, { title: 'Valise' });
    useNavigationStore.getState().navigate({ tab: 'checklists', checklistId: second.checklist.id as ChecklistId });
    const first = renderChecklists(h.container);
    expect(await screen.findByRole('heading', { level: 1, name: 'Valise' })).toBeInTheDocument();
    first.unmount();
    useNavigationStore.getState().goToTab('tasks');
    useNavigationStore.getState().goToTab('checklists');
    renderChecklists(h.container);
    expect(await screen.findByRole('heading', { level: 1, name: 'Valise' })).toBeInTheDocument();
  });

  it('le filtre d’espace n’affiche que les checklists de l’espace ; « Tout » indique l’espace (critère 5)', async () => {
    await seedChecklist(h, { title: 'Dossier', spaceId: SPACE_PRO_ID });
    await seedChecklist(h, { title: 'Courses', spaceId: SPACE_PERSO_ID });
    useAppStore.getState().setSpaceFilter(SPACE_PERSO_ID);
    renderChecklists(h.container);
    const chooser = await screen.findByRole('combobox', { name: 'Choisir une checklist' });
    expect(within(chooser).getAllByRole('option').map((option) => option.textContent)).toEqual(['Courses']);
    fireEvent.click(screen.getByRole('button', { name: 'Tout' }));
    await waitFor(() => expect(within(screen.getByRole('combobox', { name: 'Choisir une checklist' })).getAllByRole('option').map((option) => option.textContent)).toEqual(['Courses · Perso', 'Dossier · Pro']));
  });

  it('sous un filtre projet, aucune checklist (critère 5, ES-04)', async () => {
    await seedChecklist(h, { title: 'Dossier', spaceId: SPACE_PRO_ID });
    const project = await seedProject(h, SPACE_PRO_ID, 'Chantier');
    useAppStore.getState().setSpaceFilter(SPACE_PRO_ID);
    useAppStore.getState().setProjectFilter(project.id);
    renderChecklists(h.container);
    expect(await screen.findByText(/Les checklists n’ont pas de projet/)).toBeInTheDocument();
    expect(screen.queryByText('Dossier')).toBeNull();
  });

  it('supprimer : feuille Modifier, corbeille, confirmation, puis « Annuler » restaure (critère 6)', async () => {
    await seedChecklist(h, { title: 'Valise voyage', items: ['Passeport', 'Chargeur'] });
    renderChecklists(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Modifier la checklist' }));
    const sheet = await screen.findByRole('dialog', { name: 'Modifier la checklist' });
    expect(within(sheet).getByLabelText('Titre de la checklist')).toHaveValue('Valise voyage');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Supprimer la checklist' }));
    const confirm = await screen.findByRole('alertdialog', { name: 'Supprimer « Valise voyage » ?' });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Annuler' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(await h.container.data.repos.checklists.listSummaries('all')).toHaveLength(1);

    fireEvent.click(within(sheet).getByRole('button', { name: 'Supprimer la checklist' }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Supprimer' }));
    expect(await screen.findByText('« Valise voyage » supprimée')).toBeInTheDocument();
    expect(await screen.findByText('Aucune checklist pour l’instant')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await h.container.data.repos.checklists.listSummaries('all')).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Valise voyage' })).toBeInTheDocument();
    await waitFor(() => expect(itemTexts()).toEqual(['Passeport', 'Chargeur']));
  });

  it('modifier le titre, l’icône et l’espace depuis la feuille Modifier (critère 6)', async () => {
    await seedChecklist(h, { title: 'Valise' });
    renderChecklists(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Modifier la checklist' }));
    const sheet = await screen.findByRole('dialog', { name: 'Modifier la checklist' });
    fireEvent.change(within(sheet).getByLabelText('Titre de la checklist'), { target: { value: 'Valise été' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Perso' }));
    fireEvent.click(within(sheet).getByRole('button', { name: 'Enregistrer' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Valise été' })).toBeInTheDocument();
    const [stored] = await h.container.data.repos.checklists.listSummaries('all');
    expect(stored?.checklist).toMatchObject({ title: 'Valise été', spaceId: SPACE_PERSO_ID });
  });
});

describe('Checklists : volet gauche (C-01), PC', () => {
  let h: ChecklistsHarness;

  beforeEach(async () => {
    h = await setupChecklists('302');
    mockViewport(1440);
  });
  afterEach(() => teardownChecklists(h));

  it('liste les checklists par titre avec « cochés / total » et affiche la première (critère 4)', async () => {
    await seedChecklist(h, { title: 'Valise voyage', items: [['Passeport', true], 'Chargeur'] });
    await seedChecklist(h, { title: 'Courses' });
    renderChecklists(h.container);
    const list = await screen.findByRole('list', { name: 'Mes checklists' });
    await waitFor(() => expect(within(list).getAllByRole('button').map((button) => button.textContent)).toEqual(['CoursesPro0 / 0', 'Valise voyagePro1 / 2']));
    expect(screen.getByRole('heading', { level: 1, name: 'Checklists' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Courses' })).toBeInTheDocument();
  });

  it('cliquer une checklist l’affiche et mémorise la sélection (critère 4)', async () => {
    await seedChecklist(h, { title: 'Courses' });
    await seedChecklist(h, { title: 'Valise voyage', items: ['Passeport'] });
    renderChecklists(h.container);
    fireEvent.click(await screen.findByRole('button', { name: /^Valise voyage/ }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Valise voyage' })).toBeInTheDocument();
    await screen.findByText('Passeport');
    expect(screen.getByRole('button', { name: /^Valise voyage/ })).toHaveAttribute('aria-current', 'true');
    const route = useNavigationStore.getState().lastRoutes.checklists;
    expect(route.checklistId).not.toBeNull();
  });

  it('« + Nouvelle checklist » ouvre la feuille ; le filtre Perso ne garde que ses checklists (critères 1, 5)', async () => {
    await seedChecklist(h, { title: 'Dossier', spaceId: SPACE_PRO_ID });
    await seedChecklist(h, { title: 'Courses', spaceId: SPACE_PERSO_ID });
    renderChecklists(h.container);
    const list = await screen.findByRole('list', { name: 'Mes checklists' });
    await waitFor(() => expect(within(list).getAllByRole('button')).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Perso' }));
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Mes checklists' })).getAllByRole('button')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: '+ Nouvelle checklist' }));
    expect(await screen.findByRole('complementary', { name: 'Nouvelle checklist' })).toBeInTheDocument();
  });
});
