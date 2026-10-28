import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { mockViewport, renderChecklists, seedChecklist, setupChecklists, teardownChecklists, typeItem, type ChecklistsHarness } from './testKit';

/**
 * UI-REFONTE-06 — Checklists sur iPhone (docs/maquettes-refonte/Checklists-v2.html) : le sélecteur est le titre (une seule occurrence du
 * nom), « + » et crayon à droite du titre, plus d'en-tête de détail ni de « Vue compacte », progression « 2 sur 3 » avec « Réorganiser »,
 * un seul moyen d'ajouter (le champ), libellés du bas qui portent le compte. PC inchangé.
 */

const topRow = (): HTMLElement => document.querySelector('.ct-checklists__topRow') as HTMLElement;
const batch = (): HTMLElement => document.querySelector('.ct-checklist-detail__batch') as HTMLElement;

describe('UI-REFONTE-06 — Checklists iPhone', () => {
  let h: ChecklistsHarness;
  afterEach(() => teardownChecklists(h));

  async function start(suffix: string, width = 440): Promise<void> {
    h = await setupChecklists(suffix);
    mockViewport(width);
  }

  const seedCourses = () => seedChecklist(h, { title: 'Course maison', items: [['Carotte', true], ['Mangue', true], 'Banane'] });

  it('le sélecteur est le titre : un seul « Course maison », h1 avec le chevron, « + » et crayon à droite ; plus d’en-tête de détail ni de « Vue compacte » (critères 1 et 2)', async () => {
    await start('361');
    await seedCourses();
    const { checklist: valise } = await seedChecklist(h, { title: 'Valise' });
    renderChecklists(h.container);
    await screen.findByRole('heading', { level: 1, name: 'Course maison' });
    expect(screen.getAllByRole('heading', { name: 'Course maison' })).toHaveLength(1);
    expect(document.querySelectorAll('h1, h2')).toHaveLength(1);
    const chooser = screen.getByRole('combobox', { name: 'Choisir une checklist' });
    expect(chooser.closest('.ct-checklists__topRow')).toBe(topRow());
    expect(within(topRow()).getByRole('button', { name: 'Nouvelle checklist' })).toBeInTheDocument();
    expect(within(topRow()).getByRole('button', { name: 'Modifier la checklist' })).toBeInTheDocument();
    expect(document.querySelector('.ct-checklist-detail__head')).toBeNull();
    expect(document.querySelector('.ct-checklist-detail__rule')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Vue compacte' })).toBeNull();
    expect(document.querySelector('.ct-fab')).toBeNull();
    // Changer de checklist par le sélecteur : le titre suit.
    fireEvent.change(chooser, { target: { value: valise.id } });
    expect(await screen.findByRole('heading', { level: 1, name: 'Valise' })).toBeInTheDocument();
  });

  it('progression : barre, « 2 sur 3 » annoncé, « Réorganiser » dans la rangée de progression (critère 2)', async () => {
    await start('362');
    await seedCourses();
    renderChecklists(h.container);
    await screen.findByRole('heading', { level: 1, name: 'Course maison' });
    const progress = document.querySelector('.ct-checklist-progress') as HTMLElement;
    expect(within(progress).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2');
    expect(within(progress).getByRole('status')).toHaveTextContent('2 sur 3');
    expect(within(progress).getByRole('status')).toHaveAccessibleName('Progression : 2 sur 3');
    expect(screen.queryByText('2 / 3')).toBeNull();
    const reorder = within(progress).getByRole('button', { name: 'Réorganiser' });
    fireEvent.click(reorder);
    expect(within(progress).getByRole('button', { name: 'Terminer' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByRole('button', { name: /^Déplacer : / })).toHaveLength(3);
  });

  it('bas de l’écran : « Supprimer les 2 éléments cochés » en rouge, « Tout décocher » ; à zéro, libellés inactifs sans compte (critère 5)', async () => {
    await start('363');
    await seedCourses();
    renderChecklists(h.container);
    await screen.findByRole('heading', { level: 1, name: 'Course maison' });
    const clear = within(batch()).getByRole('button', { name: 'Supprimer les 2 éléments cochés' });
    expect(clear).toHaveAttribute('data-variant', 'danger');
    expect(clear).not.toHaveAttribute('aria-disabled');
    expect(screen.queryByRole('button', { name: 'Effacer les cochés' })).toBeNull();
    fireEvent.click(within(batch()).getByRole('button', { name: 'Tout décocher' }));
    // Le bandeau « Annuler » est aussi un `role="status"` : on lit celui de la progression.
    await waitFor(() => expect(within(document.querySelector('.ct-checklist-progress') as HTMLElement).getByRole('status')).toHaveTextContent('0 sur 3'));
    expect(within(batch()).getByRole('button', { name: 'Supprimer les éléments cochés' })).toHaveAttribute('aria-disabled', 'true');
    expect(within(batch()).getByRole('button', { name: 'Tout décocher' })).toHaveAttribute('aria-disabled', 'true');
    // Un seul coché : singulier.
    fireEvent.click(screen.getByRole('button', { name: 'Cocher : Banane' }));
    await waitFor(() => expect(within(batch()).getByRole('button', { name: 'Supprimer l’élément coché' })).toBeInTheDocument());
  });

  it('« Supprimer les 2 éléments cochés » ouvre la confirmation existante puis efface (critère 5, C-05)', async () => {
    await start('364');
    await seedCourses();
    renderChecklists(h.container);
    await screen.findByRole('heading', { level: 1, name: 'Course maison' });
    fireEvent.click(within(batch()).getByRole('button', { name: 'Supprimer les 2 éléments cochés' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Effacer 2 éléments cochés ?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Effacer' }));
    await waitFor(() => expect(within(document.querySelector('.ct-checklist-progress') as HTMLElement).getByRole('status')).toHaveTextContent('0 sur 1'));
    expect(screen.queryByText('Carotte')).toBeNull();
  });

  it('ajout : le champ « Nouvel élément » est le seul moyen d’ajouter ; Entrée enchaîne et la progression suit (critère 4)', async () => {
    await start('365');
    await seedCourses();
    renderChecklists(h.container);
    await screen.findByRole('heading', { level: 1, name: 'Course maison' });
    expect(screen.getByLabelText('Nouvel élément')).toHaveAttribute('placeholder', 'Ajouter un élément');
    typeItem('Pomme');
    await screen.findByText('Pomme');
    await waitFor(() => expect(within(document.querySelector('.ct-checklist-progress') as HTMLElement).getByRole('status')).toHaveTextContent('2 sur 4'));
    expect(screen.getByLabelText('Nouvel élément')).toHaveValue('');
    expect(document.querySelectorAll('.ct-checklist-add')).toHaveLength(1);
  });

  it('sans checklist : titre « Checklists », bouton « Nouvelle checklist » et état vide (critère 1)', async () => {
    await start('366');
    renderChecklists(h.container);
    expect(await screen.findByText(/Aucune checklist/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Checklists' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Choisir une checklist' })).toBeNull();
    expect(within(topRow()).getByRole('button', { name: 'Nouvelle checklist' })).toBeInTheDocument();
    expect(document.querySelector('.ct-fab')).toBeNull();
  });

  it('PC : volet et détail inchangés, « Vue compacte », « 2 / 3 », « Effacer les cochés » (critère 8)', async () => {
    await start('367', 1440);
    await seedCourses();
    renderChecklists(h.container);
    await screen.findByRole('heading', { level: 2, name: 'Course maison' });
    expect(document.querySelector('.ct-checklist-detail__head')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Vue compacte' })).toBeInTheDocument();
    expect(screen.getAllByText('2 / 3').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Effacer les cochés' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ Nouvelle checklist' })).toBeInTheDocument();
  });
});
