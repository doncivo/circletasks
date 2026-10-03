import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChecklistId } from '../../domain/types';
import type { KeyInput } from '../app/shortcuts';
import { mockViewport, renderChecklists, seedChecklist, setupChecklists, teardownChecklists, type ChecklistsHarness } from './testKit';

const alt = (key: 'ArrowUp' | 'ArrowDown'): KeyInput => ({ key, code: key, ctrlKey: false, altKey: true, shiftKey: false, metaKey: false, editable: false });

const VALISE = ['Adaptateur de prise', 'Crème solaire', 'Attestation d’assurance', ['Passeport', true], ['Chargeur', true], ['Billets d’avion', true]] as const;

const rowTexts = (): string[] => Array.from(document.querySelectorAll('.ct-checklist-item__text')).map((node) => node.textContent ?? '');
const stored = async (h: ChecklistsHarness, id: string) => (await h.container.data.repos.checklistItems.listForChecklist(id as ChecklistId)).map((item) => [item.text, item.checked, item.sortOrder]);
const clearButton = () => screen.getByRole('button', { name: 'Effacer les cochés' });
const uncheckButton = () => screen.getByRole('button', { name: 'Tout décocher' });

describe('Checklists : effacer les cochés et tout décocher (C-05), iPhone', () => {
  let h: ChecklistsHarness;

  beforeEach(async () => {
    h = await setupChecklists('351');
    mockViewport(440);
  });
  afterEach(() => teardownChecklists(h));

  it('confirmation « Effacer 3 éléments cochés ? » ; Annuler ne change rien (critère 1)', async () => {
    const { checklist } = await seedChecklist(h, { title: 'Valise voyage', items: VALISE });
    renderChecklists(h.container);
    await screen.findByText('3 / 6');
    fireEvent.click(clearButton());
    const dialog = await screen.findByRole('alertdialog', { name: 'Effacer 3 éléments cochés ?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Annuler' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByText('3 / 6')).toBeInTheDocument();
    expect(await stored(h, checklist.id)).toHaveLength(6);
    expect(h.container.undo.getSnapshot().size).toBe(0);
    // Le focus revient sur le bouton qui a ouvert la boîte (critère 9).
    expect(clearButton()).toHaveFocus();
  });

  it('confirmer efface les 3 items, « 0 / 3 », message « 3 éléments effacés » ; Annuler les restaure à leur place (critère 2)', async () => {
    const { checklist } = await seedChecklist(h, { title: 'Valise voyage', items: VALISE });
    renderChecklists(h.container);
    await screen.findByText('3 / 6');
    fireEvent.click(clearButton());
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Effacer' }));
    expect(await screen.findByText('3 éléments effacés')).toBeInTheDocument();
    await waitFor(() => expect(rowTexts()).toEqual(['Adaptateur de prise', 'Crème solaire', 'Attestation d’assurance']));
    expect(screen.getByText('0 / 3')).toBeInTheDocument();
    // Suppression logique : les lignes restent en base avec `deleted_at` (synchro).
    const removed = await h.container.data.repos.checklistItems.getByIds((await h.container.data.repos.checklistItems.listForChecklist(checklist.id as ChecklistId)).map((i) => i.id));
    expect(removed).toHaveLength(3);
    expect(clearButton()).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    await waitFor(() => expect(rowTexts()).toEqual(['Adaptateur de prise', 'Crème solaire', 'Attestation d’assurance', 'Passeport', 'Chargeur', 'Billets d’avion']));
    expect(screen.getByText('3 / 6')).toBeInTheDocument();
  });

  it('Ctrl+Z restaure aussi les items effacés (critère 2)', async () => {
    await seedChecklist(h, { title: 'Valise voyage', items: VALISE });
    renderChecklists(h.container);
    await screen.findByText('3 / 6');
    fireEvent.click(clearButton());
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Effacer' }));
    await waitFor(() => expect(rowTexts()).toHaveLength(3));
    await act(async () => {
      await h.container.undo.undoLast();
    });
    await waitFor(() => expect(rowTexts()).toHaveLength(6));
  });

  it('un seul item coché : « Effacer 1 élément coché ? » puis « 1 élément effacé »', async () => {
    await seedChecklist(h, { title: 'Courses', items: ['Lait', ['Pain', true]] });
    renderChecklists(h.container);
    await screen.findByText('1 / 2');
    fireEvent.click(clearButton());
    expect(await screen.findByRole('alertdialog', { name: 'Effacer 1 élément coché ?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Effacer' }));
    expect(await screen.findByText('1 élément effacé')).toBeInTheDocument();
  });

  it('aucun item coché : « Effacer les cochés » et « Tout décocher » sont inactifs (critères 3, 4)', async () => {
    await seedChecklist(h, { title: 'Courses', items: ['Lait', 'Pain'] });
    renderChecklists(h.container);
    await screen.findByText('0 / 2');
    expect(clearButton()).toHaveAttribute('aria-disabled', 'true');
    expect(uncheckButton()).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(clearButton());
    fireEvent.click(uncheckButton());
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(h.container.undo.getSnapshot().size).toBe(0);
  });

  it('« Tout décocher » décoche d’un coup sans confirmation, « 0 / 6 », message « Annuler » (critère 4)', async () => {
    const { checklist } = await seedChecklist(h, { title: 'Valise voyage', items: VALISE });
    renderChecklists(h.container);
    await screen.findByText('3 / 6');
    expect(uncheckButton()).not.toHaveAttribute('aria-disabled');
    fireEvent.click(uncheckButton());
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(await screen.findByText('0 / 6')).toBeInTheDocument();
    expect(screen.getByText('Éléments décochés')).toBeInTheDocument();
    await waitFor(async () => expect((await stored(h, checklist.id)).every(([, checked]) => checked === false)).toBe(true));
    expect(uncheckButton()).toHaveAttribute('aria-disabled', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(await screen.findByText('3 / 6')).toBeInTheDocument();
    expect((await stored(h, checklist.id)).filter(([, checked]) => checked).map(([text]) => text)).toEqual(['Passeport', 'Chargeur', 'Billets d’avion']);
  });

  it('l’annulation est « stale » si un item a changé depuis', async () => {
    await seedChecklist(h, { title: 'Valise voyage', items: VALISE });
    renderChecklists(h.container);
    await screen.findByText('3 / 6');
    fireEvent.click(uncheckButton());
    await screen.findByText('0 / 6');
    h.db.clock.advance(5);
    fireEvent.click(screen.getByRole('button', { name: 'Cocher : Chargeur' }));
    await screen.findByText('1 / 6');
    await waitFor(() => expect(h.container.undo.getSnapshot().size).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(await screen.findByText('Action impossible à annuler : la tâche a changé')).toBeInTheDocument();
    expect(screen.getByText('1 / 6')).toBeInTheDocument();
  });

  it('un cochage tout juste fait est pris en compte par « Effacer les cochés »', async () => {
    const { checklist } = await seedChecklist(h, { title: 'Courses', items: ['Lait', ['Pain', true]] });
    renderChecklists(h.container);
    await screen.findByText('1 / 2');
    fireEvent.click(screen.getByRole('button', { name: 'Cocher : Lait' }));
    fireEvent.click(clearButton());
    expect(await screen.findByRole('alertdialog', { name: 'Effacer 2 éléments cochés ?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Effacer' }));
    await waitFor(async () => expect(await stored(h, checklist.id)).toEqual([]));
  });
});

describe('Checklists : mode Réorganiser (C-05), iPhone', () => {
  let h: ChecklistsHarness;

  beforeEach(async () => {
    h = await setupChecklists('352');
    mockViewport(440);
  });
  afterEach(() => teardownChecklists(h));

  it('« Réorganiser » montre une poignée et un « − » par item ; le bouton devient « Terminer » (critère 5)', async () => {
    await seedChecklist(h, { title: 'Courses', items: ['Lait', 'Pain'] });
    renderChecklists(h.container);
    await screen.findByText('0 / 2');
    expect(screen.queryByRole('button', { name: /^Déplacer : / })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Supprimer : / })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Réorganiser' }));
    expect(screen.getByRole('button', { name: 'Terminer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Déplacer : Lait' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Déplacer : Pain' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Supprimer : Lait' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Terminer' }));
    expect(screen.queryByRole('button', { name: /^Déplacer : / })).toBeNull();
  });

  it('« − » supprime l’item avec un message « Annuler » qui le restaure à sa place (critère 7)', async () => {
    const { checklist } = await seedChecklist(h, { title: 'Courses', items: ['Lait', 'Pain', 'Œufs'] });
    renderChecklists(h.container);
    await screen.findByText('0 / 3');
    fireEvent.click(screen.getByRole('button', { name: 'Réorganiser' }));
    fireEvent.click(screen.getByRole('button', { name: 'Supprimer : Pain' }));
    expect(await screen.findByText('« Pain » supprimé')).toBeInTheDocument();
    await waitFor(() => expect(rowTexts()).toEqual(['Lait', 'Œufs']));
    expect(await stored(h, checklist.id)).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    await waitFor(() => expect(rowTexts()).toEqual(['Lait', 'Pain', 'Œufs']));
  });

  it('↓ sur la poignée descend l’item, l’ordre est écrit, annonce et « Annuler » (critère 6)', async () => {
    const { checklist } = await seedChecklist(h, { title: 'Courses', items: ['Lait', 'Pain', 'Œufs'] });
    renderChecklists(h.container);
    await screen.findByText('0 / 3');
    fireEvent.click(screen.getByRole('button', { name: 'Réorganiser' }));
    const handle = screen.getByRole('button', { name: 'Déplacer : Lait' });
    act(() => handle.focus());
    fireEvent.keyDown(handle, { key: 'ArrowDown' });
    await waitFor(() => expect(rowTexts()).toEqual(['Pain', 'Lait', 'Œufs']));
    expect((await stored(h, checklist.id)).map(([text]) => text)).toEqual(['Pain', 'Lait', 'Œufs']);
    expect(document.querySelector('[aria-live="polite"][aria-atomic="true"]')).toHaveTextContent('Déplacé en position 2 sur 3');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Déplacer : Lait' })).toHaveFocus());
    expect(await screen.findByText('Élément déplacé')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    await waitFor(() => expect(rowTexts()).toEqual(['Lait', 'Pain', 'Œufs']));
    expect((await stored(h, checklist.id)).map(([text]) => text)).toEqual(['Lait', 'Pain', 'Œufs']);
  });

  it('changer de checklist quitte le mode Réorganiser', async () => {
    await seedChecklist(h, { title: 'Courses', items: ['Lait'] });
    await seedChecklist(h, { title: 'Valise', items: ['Passeport'] });
    renderChecklists(h.container);
    await screen.findByText('0 / 1');
    fireEvent.click(screen.getByRole('button', { name: 'Réorganiser' }));
    const valise = (await h.container.data.repos.checklists.listSummaries('all')).find((s) => s.checklist.title === 'Valise');
    fireEvent.change(screen.getByRole('combobox', { name: 'Choisir une checklist' }), { target: { value: valise?.checklist.id } });
    await screen.findByRole('heading', { level: 1, name: 'Valise' });
    expect(screen.getByRole('button', { name: 'Réorganiser' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Déplacer : / })).toBeNull();
  });
});

describe('Checklists : réorganiser sur PC (C-05)', () => {
  let h: ChecklistsHarness;

  beforeEach(async () => {
    h = await setupChecklists('353');
    mockViewport(1440);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await teardownChecklists(h);
  });

  it('les poignées sont toujours visibles ; « Réorganiser » ajoute les « − » (critère 5)', async () => {
    await seedChecklist(h, { title: 'Courses', items: ['Lait', 'Pain'] });
    renderChecklists(h.container);
    await waitFor(() => expect(rowTexts().length).toBeGreaterThan(0));
    expect(screen.getByRole('button', { name: 'Déplacer : Lait' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Supprimer : Lait' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Réorganiser' }));
    expect(screen.getByRole('button', { name: 'Supprimer : Lait' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Terminer' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Déplacer : Lait' })).toBeInTheDocument();
  });

  it('Alt+↓ déplace la ligne sélectionnée et Alt+↑ la remonte (critère 6)', async () => {
    const { checklist } = await seedChecklist(h, { title: 'Courses', items: ['Lait', 'Pain', 'Œufs'] });
    renderChecklists(h.container);
    await waitFor(() => expect(rowTexts().length).toBeGreaterThan(0));
    act(() => screen.getByRole('button', { name: 'Cocher : Lait' }).focus());
    act(() => {
      h.container.shortcuts.handle(alt('ArrowDown'));
    });
    await waitFor(() => expect(rowTexts()).toEqual(['Pain', 'Lait', 'Œufs']));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Déplacer : Lait' })).toHaveFocus());
    act(() => {
      h.container.shortcuts.handle(alt('ArrowUp'));
    });
    await waitFor(() => expect(rowTexts()).toEqual(['Lait', 'Pain', 'Œufs']));
    expect((await stored(h, checklist.id)).map(([text, , order]) => [text, order])).toEqual([['Lait', 1], ['Pain', 2], ['Œufs', 3]]);
  });

  it('glisser une poignée change l’item de place et persiste (critère 6)', async () => {
    const { checklist } = await seedChecklist(h, { title: 'Courses', items: ['A', 'B', 'C'] });
    renderChecklists(h.container);
    await waitFor(() => expect(rowTexts().length).toBeGreaterThan(0));
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.ct-checklist-item'));
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const index = rows.indexOf(this);
      const top = index * 60;
      return { top, bottom: top + 60, left: 0, right: 100, width: 100, height: 60, x: 0, y: top, toJSON: () => ({}) };
    });
    const pointer = (target: EventTarget, type: string, clientY: number) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 10, clientY, button: 0 });
      Object.defineProperty(event, 'pointerType', { value: 'mouse' });
      Object.defineProperty(event, 'pointerId', { value: 1 });
      act(() => {
        target.dispatchEvent(event);
      });
    };
    pointer(screen.getByRole('button', { name: 'Déplacer : C' }), 'pointerdown', 150);
    pointer(window, 'pointermove', 20);
    expect(rows[0]).toHaveAttribute('data-drop', 'before');
    pointer(window, 'pointerup', 20);
    await waitFor(() => expect(rowTexts()).toEqual(['C', 'A', 'B']));
    expect((await stored(h, checklist.id)).map(([text]) => text)).toEqual(['C', 'A', 'B']);
  });

  it('l’ordre est conservé après redémarrage (nouveau rendu) (critère 6)', async () => {
    await seedChecklist(h, { title: 'Courses', items: ['Lait', 'Pain', 'Œufs'] });
    const first = renderChecklists(h.container);
    await waitFor(() => expect(rowTexts().length).toBeGreaterThan(0));
    const handle = screen.getByRole('button', { name: 'Déplacer : Œufs' });
    act(() => handle.focus());
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    await waitFor(() => expect(rowTexts()).toEqual(['Lait', 'Œufs', 'Pain']));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Déplacer : Œufs' }), { key: 'ArrowUp' });
    await waitFor(() => expect(rowTexts()).toEqual(['Œufs', 'Lait', 'Pain']));
    first.unmount();
    renderChecklists(h.container);
    await waitFor(() => expect(rowTexts().length).toBeGreaterThan(0));
    expect(rowTexts()).toEqual(['Œufs', 'Lait', 'Pain']);
  });

  it('PC : le pied du détail porte les trois boutons de la maquette (critère 9, clavier)', async () => {
    await seedChecklist(h, { title: 'Courses', items: [['Lait', true]] });
    renderChecklists(h.container);
    await waitFor(() => expect(rowTexts().length).toBeGreaterThan(0));
    const names = Array.from(document.querySelectorAll('.ct-checklist-detail__footer button')).map((button) => button.textContent);
    expect(names.slice(0, 3)).toEqual(['Effacer les cochés', 'Tout décocher', 'Planifier un jour']);
    for (const button of document.querySelectorAll('.ct-checklist-detail__footer button')) expect(button).not.toHaveAttribute('tabindex', '-1');
  });
});

describe('Cas d’usage des lots (C-05 critère 8)', () => {
  let h: ChecklistsHarness;

  beforeEach(async () => {
    h = await setupChecklists('354');
  });
  afterEach(() => teardownChecklists(h));

  it('les suppressions sont logiques : la ligne reste avec deleted_at et un nouveau hlc', async () => {
    const { checklist, items } = await seedChecklist(h, { title: 'Valise voyage', items: VALISE });
    const { createChecklistUseCases } = await import('./checklistUseCases');
    h.db.clock.advance(5);
    const cleared = await createChecklistUseCases(h.container).clearChecked(checklist.id as ChecklistId);
    expect(cleared.map((item) => item.text)).toEqual(['Passeport', 'Chargeur', 'Billets d’avion']);
    const rows = await h.db.driver.select<{ id: string; deleted_at: string | null; hlc: string }>('SELECT id, deleted_at, hlc FROM checklist_item ORDER BY sort_order');
    expect(rows).toHaveLength(6);
    expect(rows.filter((row) => row.deleted_at !== null)).toHaveLength(3);
    for (const row of rows.filter((candidate) => candidate.deleted_at !== null)) {
      expect(row.hlc > (items.find((item) => item.id === row.id)?.hlc ?? '')).toBe(true);
    }
  });

  it('rien à effacer ni à décocher : aucune écriture, aucune commande d’annulation', async () => {
    const { checklist } = await seedChecklist(h, { title: 'Courses', items: ['Lait'] });
    const { createChecklistUseCases } = await import('./checklistUseCases');
    const useCases = createChecklistUseCases(h.container);
    expect(await useCases.clearChecked(checklist.id as ChecklistId)).toEqual([]);
    expect(await useCases.uncheckAll(checklist.id as ChecklistId)).toEqual([]);
    expect(await useCases.moveItem(checklist.id as ChecklistId, 'inconnu' as never, 0)).toBeNull();
    expect(h.container.undo.getSnapshot().size).toBe(0);
  });
});
