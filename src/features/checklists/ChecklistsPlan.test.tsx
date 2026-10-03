import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChecklistId, LocalDate } from '../../domain/types';
import { createChecklistUseCases } from './checklistUseCases';
import { mockViewport, renderChecklists, seedChecklist, setupChecklists, teardownChecklists, type ChecklistsHarness } from './testKit';

// Aujourd'hui dans les tests : ven. 2 oct. 2026.
const dateOf = async (h: ChecklistsHarness, id: string) => (await h.container.data.repos.checklists.getById(id as ChecklistId))?.date;

describe('Checklists : associer à un jour (C-03), PC', () => {
  let h: ChecklistsHarness;

  beforeEach(async () => {
    h = await setupChecklists('331');
    mockViewport(1440);
  });
  afterEach(() => teardownChecklists(h));

  it('« Planifier un jour » ouvre le sélecteur de date sans « Un jour » ni heure ; la date est enregistrée et affichée (critères 1, 9)', async () => {
    const { checklist } = await seedChecklist(h, { title: 'Valise voyage', items: ['Passeport'] });
    renderChecklists(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Planifier un jour' }));
    const dialog = await screen.findByRole('dialog', { name: 'Planifier un jour' });
    expect(within(dialog).queryByRole('button', { name: /Un jour/ })).toBeNull();
    expect(within(dialog).queryByText(/Heure/)).toBeNull();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Date' }), { target: { value: '9/10' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Planifier' }));
    await waitFor(async () => expect(await dateOf(h, checklist.id)).toBe('2026-10-09'));
    expect(await screen.findByText('Prévue le ven. 9 oct.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('« Retirer la date » l’enlève et propose « Annuler » 5 s, qui la rétablit (critère 6)', async () => {
    const { checklist } = await seedChecklist(h, { title: 'Valise voyage', date: '2026-10-09' as LocalDate });
    renderChecklists(h.container);
    expect(await screen.findByText('Prévue le ven. 9 oct.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retirer la date' }));
    expect(await screen.findByText('Date retirée de « Valise voyage »')).toBeInTheDocument();
    await waitFor(async () => expect(await dateOf(h, checklist.id)).toBeNull());
    expect(screen.queryByText(/Prévue le/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retirer la date' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    await waitFor(async () => expect(await dateOf(h, checklist.id)).toBe('2026-10-09'));
    expect(await screen.findByText('Prévue le ven. 9 oct.')).toBeInTheDocument();
  });

  it('une date passée reste affichée dans l’onglet (critère 5)', async () => {
    await seedChecklist(h, { title: 'Hier', date: '2026-10-01' as LocalDate });
    renderChecklists(h.container);
    expect(await screen.findByText('Prévue le jeu. 1 oct.')).toBeInTheDocument();
  });
});

describe('Checklists : feuille « Modifier la checklist » (C-03 critère 1), iPhone', () => {
  let h: ChecklistsHarness;

  beforeEach(async () => {
    h = await setupChecklists('332');
    mockViewport(440);
  });
  afterEach(() => teardownChecklists(h));

  it('la ligne Date ouvre le sélecteur ; choisir « Demain » enregistre le jour (critère 1)', async () => {
    const { checklist } = await seedChecklist(h, { title: 'Valise voyage' });
    renderChecklists(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Modifier la checklist' }));
    const sheet = await screen.findByRole('dialog', { name: 'Modifier la checklist' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Date : Aucune date' }));
    const dialog = await screen.findByRole('dialog', { name: 'Planifier un jour' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Demain' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Planifier' }));
    await waitFor(async () => expect(await dateOf(h, checklist.id)).toBe('2026-10-03'));
    expect(await within(sheet).findByRole('button', { name: 'Date : sam. 3 oct.' })).toBeInTheDocument();
    // La date est aussi rappelée dans le détail (critère 9).
    expect(screen.getByText('Prévue le sam. 3 oct.')).toBeInTheDocument();
  });

  it('« Retirer la date » de la feuille est annulable (critère 6)', async () => {
    const { checklist } = await seedChecklist(h, { title: 'Valise voyage', date: '2026-10-03' as LocalDate });
    renderChecklists(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Modifier la checklist' }));
    const sheet = await screen.findByRole('dialog', { name: 'Modifier la checklist' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Retirer la date' }));
    await waitFor(async () => expect(await dateOf(h, checklist.id)).toBeNull());
    expect(await screen.findByText('Date retirée de « Valise voyage »')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    await waitFor(async () => expect(await dateOf(h, checklist.id)).toBe('2026-10-03'));
  });
});

describe('Cas d’usage setDate (C-03)', () => {
  let h: ChecklistsHarness;

  beforeEach(async () => {
    h = await setupChecklists('333');
  });
  afterEach(() => teardownChecklists(h));

  it('poser un jour n’est pas annulable ; retirer le jour l’est ; l’annulation devient « stale » si la checklist a changé', async () => {
    const { checklist } = await seedChecklist(h, { title: 'Valise voyage' });
    const useCases = createChecklistUseCases(h.container);
    const id = checklist.id as ChecklistId;
    await useCases.setDate(id, '2026-10-05' as LocalDate);
    expect(h.container.undo.getSnapshot().size).toBe(0);

    await useCases.setDate(id, null);
    expect(h.container.undo.getSnapshot().size).toBe(1);
    // Un nouveau jour posé entre-temps : l'ancien retrait ne s'annule plus.
    h.db.clock.advance(5);
    await useCases.setDate(id, '2026-10-07' as LocalDate);
    expect(await h.container.undo.undoLast()).toMatchObject({ status: 'stale' });
    expect(await dateOf(h, id)).toBe('2026-10-07');
  });

  it('retirer une date absente ou poser la même ne fait rien ; une checklist supprimée renvoie null', async () => {
    const { checklist } = await seedChecklist(h, { title: 'Valise voyage', date: '2026-10-05' as LocalDate });
    const useCases = createChecklistUseCases(h.container);
    const id = checklist.id as ChecklistId;
    const before = await h.container.data.repos.checklists.getById(id);
    expect((await useCases.setDate(id, '2026-10-05' as LocalDate))?.hlc).toBe(before?.hlc);
    await useCases.setDate(id, null);
    h.container.undo.clear();
    await useCases.setDate(id, null);
    expect(h.container.undo.getSnapshot().size).toBe(0);
    await useCases.remove(id);
    expect(await useCases.setDate(id, '2026-10-06' as LocalDate)).toBeNull();
  });
});
