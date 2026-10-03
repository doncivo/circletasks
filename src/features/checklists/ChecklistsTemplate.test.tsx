import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SPACE_PERSO_ID } from '../../db/seed/defaultSpaces';
import type { ChecklistId, ChecklistItemId, Id, LocalDate } from '../../domain/types';
import { useNavigationStore } from '../app/navigation';
import { createChecklistUseCases } from './checklistUseCases';
import { mockViewport, renderChecklists, seedChecklist, setupChecklists, teardownChecklists, typeItem, type ChecklistsHarness } from './testKit';

const VALISE = ['Adaptateur de prise', 'Crème solaire', 'Attestation d’assurance', ['Passeport', true], ['Chargeur', true], ['Billets d’avion', true]] as const;
const ICON = { kind: 'lucide', name: 'briefcase' } as const;

const summaries = async (h: ChecklistsHarness) => h.container.data.repos.checklists.listSummaries('all');
const rowTexts = (): string[] => Array.from(document.querySelectorAll('.ct-checklist-item__text')).map((node) => node.textContent ?? '');

describe('Checklists : dupliquer et réinitialiser (C-04), PC', () => {
  let h: ChecklistsHarness;

  beforeEach(async () => {
    h = await setupChecklists('341');
    mockViewport(1440);
  });
  afterEach(() => teardownChecklists(h));

  it('crée « Valise voyage (copie) » décochée, sans date, non modèle, ouverte ; l’original est inchangé (critères 1, 2)', async () => {
    const { checklist } = await seedChecklist(h, { title: 'Valise voyage', spaceId: SPACE_PERSO_ID, icon: ICON, date: '2026-10-09' as LocalDate, isTemplate: true, items: VALISE });
    renderChecklists(h.container);
    await screen.findByRole('heading', { level: 2, name: 'Valise voyage' });
    await waitFor(() => expect(rowTexts()).toHaveLength(6));
    fireEvent.click(screen.getByRole('button', { name: 'Dupliquer et réinitialiser' }));

    expect(await screen.findByRole('heading', { level: 2, name: 'Valise voyage (copie)' })).toBeInTheDocument();
    await waitFor(() => expect(rowTexts()).toEqual(['Adaptateur de prise', 'Crème solaire', 'Attestation d’assurance', 'Passeport', 'Chargeur', 'Billets d’avion']));
    expect(await screen.findAllByText('0 / 6')).not.toHaveLength(0);
    expect(screen.queryByText(/Prévue le/)).toBeNull();
    expect(screen.queryByText(/modèle réutilisable/)).toBeNull();

    const all = await summaries(h);
    const copy = all.find((s) => s.checklist.title === 'Valise voyage (copie)');
    expect(copy).toMatchObject({ checked: 0, total: 6, checklist: { spaceId: SPACE_PERSO_ID, icon: ICON, date: null, isTemplate: false } });
    const original = all.find((s) => s.checklist.id === checklist.id);
    expect(original).toMatchObject({ checked: 3, total: 6, checklist: { title: 'Valise voyage', date: '2026-10-09', isTemplate: true } });
    expect(useNavigationStore.getState().route).toEqual({ tab: 'checklists', checklistId: copy?.checklist.id });
  });

  it('un message « Checklist dupliquée » propose « Annuler », qui supprime la copie (critère 5)', async () => {
    const { checklist } = await seedChecklist(h, { title: 'Valise voyage', items: VALISE });
    renderChecklists(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Dupliquer et réinitialiser' }));
    expect(await screen.findByText('Checklist dupliquée')).toBeInTheDocument();
    await waitFor(async () => expect(await summaries(h)).toHaveLength(2));
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    await waitFor(async () => expect((await summaries(h)).map((s) => s.checklist.title)).toEqual(['Valise voyage']));
    expect(await screen.findByRole('heading', { level: 2, name: 'Valise voyage' })).toBeInTheDocument();
    expect(await h.container.data.repos.checklists.getById(checklist.id as ChecklistId)).not.toBeNull();
  });

  it('« Annuler » est « stale » si la copie a été modifiée depuis (critère 5)', async () => {
    await seedChecklist(h, { title: 'Valise voyage', items: ['Passeport', 'Chargeur'] });
    renderChecklists(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Dupliquer et réinitialiser' }));
    await screen.findByRole('heading', { level: 2, name: 'Valise voyage (copie)' });
    await waitFor(() => expect(rowTexts()).toEqual(['Passeport', 'Chargeur']));
    h.db.clock.advance(5);
    fireEvent.click(screen.getByRole('button', { name: 'Cocher : Passeport' }));
    await screen.findAllByText('1 / 2');
    await waitFor(async () => expect((await summaries(h)).find((s) => s.checklist.title === 'Valise voyage (copie)')?.checked).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(await screen.findByText('Action impossible à annuler : la tâche a changé')).toBeInTheDocument();
    expect(await summaries(h)).toHaveLength(2);
  });

  it('le bouton est mis en avant pour un modèle (primaire) et reste disponible pour toute checklist (critère 4)', async () => {
    await seedChecklist(h, { title: 'Modèle', isTemplate: true });
    await seedChecklist(h, { title: 'Ordinaire' });
    renderChecklists(h.container);
    const duplicate = await screen.findByRole('button', { name: 'Dupliquer et réinitialiser' });
    await screen.findByRole('heading', { level: 2, name: 'Modèle' });
    expect(duplicate).toHaveAttribute('data-variant', 'primary');
    fireEvent.click(within(screen.getByRole('list', { name: 'Mes checklists' })).getByRole('button', { name: /^Ordinaire/ }));
    await screen.findByRole('heading', { level: 2, name: 'Ordinaire' });
    expect(screen.getByRole('button', { name: 'Dupliquer et réinitialiser' })).not.toHaveAttribute('data-variant');
  });

  it('la sous-ligne affiche « Perso · modèle réutilisable » (critère 3)', async () => {
    await seedChecklist(h, { title: 'Valise voyage', spaceId: SPACE_PERSO_ID, isTemplate: true, items: VALISE });
    renderChecklists(h.container);
    expect(await screen.findByText('Perso · modèle réutilisable')).toBeInTheDocument();
  });

  it('les items ajoutés à la copie ne changent pas l’original', async () => {
    const { checklist } = await seedChecklist(h, { title: 'Valise voyage', items: ['Passeport'] });
    renderChecklists(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Dupliquer et réinitialiser' }));
    await screen.findByRole('heading', { level: 2, name: 'Valise voyage (copie)' });
    await waitFor(() => expect(rowTexts()).toEqual(['Passeport']));
    typeItem('Visa');
    await waitFor(() => expect(rowTexts()).toEqual(['Passeport', 'Visa']));
    expect(await h.container.data.repos.checklistItems.listForChecklist(checklist.id as ChecklistId)).toHaveLength(1);
  });
});

describe('Checklists : modèle réutilisable (C-04), iPhone', () => {
  let h: ChecklistsHarness;

  beforeEach(async () => {
    h = await setupChecklists('342');
    mockViewport(440);
  });
  afterEach(() => teardownChecklists(h));

  it('l’interrupteur marque le modèle ; la mention figure dans le détail (critère 3)', async () => {
    const { checklist } = await seedChecklist(h, { title: 'Valise voyage', spaceId: SPACE_PERSO_ID, items: ['Passeport'] });
    renderChecklists(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Modifier la checklist' }));
    const sheet = await screen.findByRole('dialog', { name: 'Modifier la checklist' });
    const toggle = within(sheet).getByRole('switch', { name: 'Modèle réutilisable' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(toggle);
    await waitFor(async () => expect((await h.container.data.repos.checklists.getById(checklist.id as ChecklistId))?.isTemplate).toBe(true));
    expect(within(sheet).getByRole('switch', { name: 'Modèle réutilisable' })).toHaveAttribute('aria-checked', 'true');
    expect(within(sheet).getByRole('button', { name: 'Dupliquer et réinitialiser' })).toHaveClass('ct-button--primary');
    expect(screen.getByText('Perso · modèle réutilisable')).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('switch', { name: 'Modèle réutilisable' }));
    await waitFor(async () => expect((await h.container.data.repos.checklists.getById(checklist.id as ChecklistId))?.isTemplate).toBe(false));
    expect(within(sheet).getByRole('button', { name: 'Dupliquer et réinitialiser' })).toHaveClass('ct-button--secondary');
  });

  it('« Dupliquer et réinitialiser » de la feuille crée la copie, la ferme et l’ouvre (critère 1)', async () => {
    await seedChecklist(h, { title: 'Valise voyage', items: VALISE });
    renderChecklists(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Modifier la checklist' }));
    const sheet = await screen.findByRole('dialog', { name: 'Modifier la checklist' });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Dupliquer et réinitialiser' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Valise voyage (copie)' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByText('0 / 6')).toBeInTheDocument();
    expect(screen.getByText('Checklist dupliquée')).toBeInTheDocument();
  });
});

describe('Cas d’usage duplicate (C-04 critères 6 et 7)', () => {
  let h: ChecklistsHarness;

  beforeEach(async () => {
    h = await setupChecklists('343');
  });
  afterEach(() => teardownChecklists(h));

  it('200 items : une seule transaction en moins de 300 ms (critère 6)', async () => {
    const { checklist } = await seedChecklist(h, { title: 'Grande liste', items: Array.from({ length: 200 }, (_, i) => `Élément ${String(i + 1)}`) });
    const useCases = createChecklistUseCases(h.container);
    const started = performance.now();
    const copy = await useCases.duplicate(checklist.id as ChecklistId);
    expect(performance.now() - started).toBeLessThan(300);
    expect(copy).not.toBeNull();
    const items = await h.container.data.repos.checklistItems.listForChecklist(copy?.id as ChecklistId);
    expect(items).toHaveLength(200);
    expect(items[199]?.text).toBe('Élément 200');
    expect(items.every((item) => !item.checked)).toBe(true);
  });

  it('un échec ne laisse aucune copie partielle (critère 6)', async () => {
    const { checklist } = await seedChecklist(h, { title: 'Valise voyage', items: ['a', 'b', 'c'] });
    // Identifiants d'items identiques : la 2e insertion viole la clé primaire, en pleine copie.
    let calls = 0;
    const failing = { next: (): Id => (calls++ < 1 ? h.container.ids.next() : ('d0000000-0000-4000-8000-000000000001' as Id)) };
    const useCases = createChecklistUseCases({ ...h.container, ids: failing });
    await expect(useCases.duplicate(checklist.id as ChecklistId)).rejects.toThrow();
    expect((await summaries(h)).map((s) => s.checklist.title)).toEqual(['Valise voyage']);
    expect(await h.container.data.repos.checklistItems.getByIds(['d0000000-0000-4000-8000-000000000001' as ChecklistItemId])).toEqual([]);
    expect(h.container.undo.getSnapshot().size).toBe(0);
  });

  it('les items supprimés ne sont pas copiés (critère 7)', async () => {
    const { checklist, items } = await seedChecklist(h, { title: 'Valise voyage', items: ['a', 'b', 'c'] });
    await h.container.data.repos.checklistItems.softDelete([items[1]?.id as ChecklistItemId]);
    const copy = await createChecklistUseCases(h.container).duplicate(checklist.id as ChecklistId);
    expect((await h.container.data.repos.checklistItems.listForChecklist(copy?.id as ChecklistId)).map((item) => item.text)).toEqual(['a', 'c']);
  });

  it('une checklist supprimée ne se duplique pas', async () => {
    const { checklist } = await seedChecklist(h, { title: 'Valise voyage' });
    const useCases = createChecklistUseCases(h.container);
    await useCases.remove(checklist.id as ChecklistId);
    expect(await useCases.duplicate(checklist.id as ChecklistId)).toBeNull();
  });
});
