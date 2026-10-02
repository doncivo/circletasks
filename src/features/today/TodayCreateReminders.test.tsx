import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { TaskId } from '../../domain/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mockViewport, renderToday, setupToday, teardownToday, type TodayHarness } from './testKit';

/** N-02 : bloc « Rappel » de la feuille « Nouvelle tâche » (iPhone, Ajout.html). */
describe('Rappels de la feuille Nouvelle tâche (N-02)', () => {
  let h: TodayHarness;
  beforeEach(async () => {
    h = await setupToday('b02');
    mockViewport(440);
  });
  afterEach(() => teardownToday(h));

  async function openSheet(): Promise<HTMLElement> {
    renderToday(h.container);
    fireEvent.click(screen.getByRole('button', { name: 'Ajouter' }));
    const dialog = await screen.findByRole('dialog', { name: 'Nouvelle tâche' });
    fireEvent.change(within(dialog).getByLabelText('Titre'), { target: { value: 'Appeler le notaire' } });
    return dialog;
  }

  const giveHour = (dialog: HTMLElement): void => {
    const hourWheel = within(dialog).getByRole('spinbutton', { name: 'Heures' });
    for (let i = 0; i < 10; i += 1) fireEvent.keyDown(hourWheel, { key: 'ArrowUp' }); // 09:00
  };

  it('sans heure : bloc grisé, aucune case cochée ni cochable, aucun rappel créé (QB-07, critères 7, 11)', async () => {
    const dialog = await openSheet();
    const atTime = within(dialog).getByRole('checkbox', { name: 'À l’heure' });
    expect(atTime).toHaveAttribute('aria-disabled', 'true');
    expect(atTime).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(atTime);
    expect(atTime).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const [task] = await h.container.data.repos.tasks.listForDay(h.today, 'all');
    expect(task).toBeDefined();
    expect(await h.container.data.repos.reminders.listForTarget({ type: 'task', id: (task?.id as TaskId) })).toEqual([]);
  });

  it('une heure donnée active le bloc et coche « À l’heure » d’office (QB-08, critère 11) ; « 30 min » en plus : deux lignes (critère 1)', async () => {
    const dialog = await openSheet();
    giveHour(dialog);
    const atTime = within(dialog).getByRole('checkbox', { name: 'À l’heure' });
    expect(atTime).toHaveAttribute('aria-disabled', 'false');
    expect(atTime).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '30 min' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const [task] = await h.container.data.repos.tasks.listForDay(h.today, 'all');
    const rows = await h.container.data.repos.reminders.listForTarget({ type: 'task', id: (task?.id as TaskId) });
    expect(rows.map((r) => [r.offsetMin, r.fireAt])).toEqual([
      [30, `${h.today}T08:30`],
      [0, `${h.today}T09:00`],
    ]);
  });

  it('décocher « À l’heure » est respecté ; « Plus… » montre les six avances (critères 2, 11)', async () => {
    const dialog = await openSheet();
    giveHour(dialog);
    expect(within(dialog).getAllByRole('checkbox')).toHaveLength(3); // À l'heure, 30 min, 1 heure
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'À l’heure' }));
    expect(within(dialog).getByRole('checkbox', { name: 'À l’heure' })).toHaveAttribute('aria-checked', 'false');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Plus…' }));
    expect(within(dialog).getAllByRole('checkbox').map((box) => box.textContent)).toEqual(['À l’heure', '5 min', '15 min', '30 min', '1 heure', '1 jour']);
    fireEvent.click(within(dialog).getByRole('checkbox', { name: '1 jour' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const [task] = await h.container.data.repos.tasks.listForDay(h.today, 'all');
    const rows = await h.container.data.repos.reminders.listForTarget({ type: 'task', id: (task?.id as TaskId) });
    expect(rows.map((r) => r.offsetMin)).toEqual([1440]);
  });
});
