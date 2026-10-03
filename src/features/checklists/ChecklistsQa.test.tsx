import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChecklistId } from '../../domain/types';
import { mockViewport, renderChecklists, seedChecklist, setupChecklists, teardownChecklists, typeItem, type ChecklistsHarness } from './testKit';

const rowTexts = (): string[] => Array.from(document.querySelectorAll('.ct-checklist-item__text')).map((node) => node.textContent ?? '');
const VALISE = ['Adaptateur', 'Crème solaire', 'Assurance', ['Passeport', true], ['Chargeur', true], ['Billets', true]] as const;

describe('Checklists : cas limites QA (C-01 à C-05)', () => {
  let h: ChecklistsHarness;

  beforeEach(async () => {
    h = await setupChecklists('390');
    mockViewport(440);
  });
  afterEach(() => teardownChecklists(h));

  it('C-01 Entrée enchaîne trois ajouts puis Échap : les items restent, le champ est vide et sans erreur', async () => {
    const { checklist } = await seedChecklist(h, { title: 'Valise voyage' });
    renderChecklists(h.container);
    await screen.findByRole('heading', { level: 1, name: 'Valise voyage' });
    const input = screen.getByLabelText('Nouvel élément');
    input.focus();
    typeItem('Passeport');
    typeItem('Billets');
    typeItem('Chargeur');
    await waitFor(() => expect(rowTexts()).toEqual(['Passeport', 'Billets', 'Chargeur']));
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input).toHaveValue('');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(rowTexts()).toEqual(['Passeport', 'Billets', 'Chargeur']);
    const stored = await h.container.data.repos.checklistItems.listForChecklist(checklist.id as ChecklistId);
    expect(stored.map((item) => [item.text, item.sortOrder])).toEqual([['Passeport', 1], ['Billets', 2], ['Chargeur', 3]]);
  });

  it('C-01 un item de 201 caractères est refusé et n’est pas écrit', async () => {
    const { checklist } = await seedChecklist(h, { title: 'Valise voyage' });
    renderChecklists(h.container);
    await screen.findByRole('heading', { level: 1, name: 'Valise voyage' });
    typeItem('x'.repeat(201));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await h.container.data.repos.checklistItems.listForChecklist(checklist.id as ChecklistId)).toEqual([]);
    typeItem('x'.repeat(200));
    await waitFor(() => expect(rowTexts()).toEqual(['x'.repeat(200)]));
  });

  it('C-02 progression 3 / 5 après suppression d’un item non coché, 2 / 5 après celle d’un coché', async () => {
    await seedChecklist(h, { title: 'Valise voyage', items: VALISE });
    renderChecklists(h.container);
    await screen.findByText('3 / 6');
    fireEvent.click(screen.getByRole('button', { name: 'Réorganiser' }));
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer : Assurance' }));
    expect(await screen.findByText('3 / 5')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Progression : 3 sur 5' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer : Chargeur' }));
    expect(await screen.findByText('2 / 4')).toBeInTheDocument();
  });

  it('C-02 le nom de la case passe de « Cocher : » à « Décocher : » (critère 7)', async () => {
    await seedChecklist(h, { title: 'Courses', items: ['Lait'] });
    renderChecklists(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Cocher : Lait' }));
    expect(await screen.findByRole('button', { name: 'Décocher : Lait' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('C-05 « Effacer les cochés » confirmé : seuls les 3 non cochés restent (le délai de 5 s relève de UndoToast, T-04)', async () => {
    const { checklist } = await seedChecklist(h, { title: 'Valise voyage', items: VALISE });
    renderChecklists(h.container);
    await screen.findByText('3 / 6');
    fireEvent.click(screen.getByRole('button', { name: 'Effacer les cochés' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Effacer' }));
    expect(await screen.findByText('3 éléments effacés')).toBeInTheDocument();
    const left = await h.container.data.repos.checklistItems.listForChecklist(checklist.id as ChecklistId);
    expect(left.map((item) => item.text)).toEqual(['Adaptateur', 'Crème solaire', 'Assurance']);
  });

  it('C-05 « Tout décocher » puis Annuler rétablit les trois cochés sans toucher l’ordre', async () => {
    await seedChecklist(h, { title: 'Valise voyage', items: VALISE });
    renderChecklists(h.container);
    await screen.findByText('3 / 6');
    fireEvent.click(screen.getByRole('button', { name: 'Tout décocher' }));
    await screen.findByText('0 / 6');
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    await screen.findByText('3 / 6');
    expect(rowTexts()).toEqual(['Adaptateur', 'Crème solaire', 'Assurance', 'Passeport', 'Chargeur', 'Billets']);
  });
});
