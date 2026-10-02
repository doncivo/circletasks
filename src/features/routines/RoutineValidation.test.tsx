import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LocalDate, RoutineId } from '../../domain/types';
import { renderWeek } from '../week/testKit';
import { renderToday } from '../today/testKit';
import { registerRoutinesSource, unregisterRoutinesSource } from './routinesSource';
import { mockViewport, renderRoutines, seedLog, seedRoutine, setupRoutines, teardownRoutines, type RoutinesHarness } from './testKit';

// Aujourd'hui : ven. 2 oct. 2026 ; semaine du lun. 28 sept. au dim. 4 oct.
const WEEK = { from: '2026-09-28' as LocalDate, to: '2026-10-04' as LocalDate };
const card = (title: string): HTMLElement => screen.getByRole('heading', { name: title }).closest('article') as HTMLElement;
const logDates = async (h: RoutinesHarness, id: RoutineId) => (await h.container.data.repos.routineLogs.listForRoutine(id, WEEK)).map((log) => log.date);
const space = { key: ' ', code: 'Space', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, editable: false } as const;

describe('Routines : ronds de la carte cliquables (R-03 critère 10, QB-03)', () => {
  let h: RoutinesHarness;

  beforeEach(async () => {
    h = await setupRoutines('231');
    mockViewport(440);
  });
  afterEach(() => teardownRoutines(h));

  it('valide un jour passé prévu, met à jour le rond et le compteur, puis le rouvre', async () => {
    const lit = await seedRoutine(h, { title: 'Faire mon lit' });
    await seedLog(h, lit, '2026-09-28');
    renderRoutines(h.container);
    await screen.findByRole('heading', { name: 'Faire mon lit' });
    const lit0 = card('Faire mon lit');
    expect(within(lit0).getByLabelText('1 sur 7 cette semaine')).toHaveTextContent('1/7');

    fireEvent.click(within(lit0).getByRole('checkbox', { name: 'Mercredi' }));
    await waitFor(() => expect(within(card('Faire mon lit')).getByRole('checkbox', { name: 'Mercredi, fait' })).toBeChecked());
    expect(within(card('Faire mon lit')).getByLabelText('2 sur 7 cette semaine')).toHaveTextContent('2/7');
    expect(await logDates(h, lit.id as RoutineId)).toEqual(['2026-09-28', '2026-09-30']);

    // Message « Annuler » (T-13).
    expect(screen.getByRole('status')).toHaveTextContent('« Faire mon lit » validée');

    fireEvent.click(within(card('Faire mon lit')).getByRole('checkbox', { name: 'Mercredi, fait' }));
    await waitFor(() => expect(within(card('Faire mon lit')).getByRole('checkbox', { name: 'Mercredi' })).not.toBeChecked());
    expect(within(card('Faire mon lit')).getByLabelText('1 sur 7 cette semaine')).toHaveTextContent('1/7');
    expect(await logDates(h, lit.id as RoutineId)).toEqual(['2026-09-28']);
  });

  it('les jours futurs sont inactifs : aucun effet (critère 10)', async () => {
    const lit = await seedRoutine(h, { title: 'Faire mon lit' });
    renderRoutines(h.container);
    await screen.findByRole('heading', { name: 'Faire mon lit' });
    const saturday = within(card('Faire mon lit')).getByRole('checkbox', { name: 'Samedi' });
    expect(saturday).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(saturday);
    // Aujourd'hui (vendredi) est actif.
    expect(within(card('Faire mon lit')).getByRole('checkbox', { name: 'Vendredi' })).toHaveAttribute('aria-disabled', 'false');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await logDates(h, lit.id as RoutineId)).toEqual([]);
  });

  it('un jour non prévu reste inactif (Sport un mardi)', async () => {
    const sport = await seedRoutine(h, { title: 'Sport', scheduleType: 'weekdays', weekdays: [1, 3, 5] });
    renderRoutines(h.container);
    await screen.findByRole('heading', { name: 'Sport' });
    const tuesday = within(card('Sport')).getByRole('checkbox', { name: 'Mardi, non prévu' });
    expect(tuesday).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(tuesday);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await logDates(h, sport.id as RoutineId)).toEqual([]);
  });

  it('« 3 fois par semaine » : le 4e rond est inactif une fois le quota atteint, mais on peut rouvrir un jour validé', async () => {
    const run = await seedRoutine(h, { title: 'Courir', scheduleType: 'x_per_week', timesPerWeek: 3 });
    for (const day of ['2026-09-28', '2026-09-29', '2026-09-30']) await seedLog(h, run, day);
    renderRoutines(h.container);
    await screen.findByRole('heading', { name: 'Courir' });
    const jeudi = within(card('Courir')).getByRole('checkbox', { name: 'Jeudi' });
    expect(jeudi).toHaveAttribute('aria-disabled', 'true');
    expect(within(card('Courir')).getByLabelText('3 sur 3 cette semaine')).toHaveTextContent('3/3');
    fireEvent.click(within(card('Courir')).getByRole('checkbox', { name: 'Mardi, fait' }));
    await waitFor(() => expect(within(card('Courir')).getByLabelText('2 sur 3 cette semaine')).toBeInTheDocument());
    expect(within(card('Courir')).getByRole('checkbox', { name: 'Jeudi' })).toHaveAttribute('aria-disabled', 'false');
  });

  it('« Annuler » du message annule la validation', async () => {
    const lit = await seedRoutine(h, { title: 'Faire mon lit' });
    renderRoutines(h.container);
    await screen.findByRole('heading', { name: 'Faire mon lit' });
    fireEvent.click(within(card('Faire mon lit')).getByRole('checkbox', { name: 'Vendredi' }));
    await waitFor(() => expect(within(card('Faire mon lit')).getByRole('checkbox', { name: 'Vendredi, fait' })).toBeChecked());
    fireEvent.click(within(screen.getByRole('status')).getByRole('button', { name: 'Annuler' }));
    await waitFor(async () => expect(await logDates(h, lit.id as RoutineId)).toEqual([]));
  });
});

describe('Aujourd’hui et Semaine : valider une routine (R-03)', () => {
  let h: RoutinesHarness;

  beforeEach(async () => {
    h = await setupRoutines('232');
    registerRoutinesSource();
  });
  afterEach(async () => {
    unregisterRoutinesSource();
    await teardownRoutines(h);
  });

  it('cocher la case valide aujourd’hui, le titre est barré et descend ; « Rouvrir » le retire (critères 1, 2)', async () => {
    mockViewport(440);
    const lit = await seedRoutine(h, { title: 'Faire mon lit', time: '07:30' as never });
    await seedRoutine(h, { title: 'Boire de l’eau', time: '08:30' as never });
    renderToday(h.container);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Terminer : Faire mon lit' }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Rouvrir : Faire mon lit' })).toBeChecked());
    const titles = Array.from(document.querySelectorAll('.ct-today__list .ct-list-row__title')).map((node) => node.textContent);
    expect(titles).toEqual(['Boire de l’eau', 'Faire mon lit']); // terminée : en bas
    expect(await logDates(h, lit.id as RoutineId)).toEqual(['2026-10-02']);
    expect(screen.getByRole('status')).toHaveTextContent('« Faire mon lit » validée');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Rouvrir : Faire mon lit' }));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Terminer : Faire mon lit' })).not.toBeChecked());
    expect(await logDates(h, lit.id as RoutineId)).toEqual([]);
  });

  it('un double clic valide une seule fois (critère 3)', async () => {
    mockViewport(440);
    const lit = await seedRoutine(h, { title: 'Faire mon lit' });
    renderToday(h.container);
    const box = await screen.findByRole('checkbox', { name: 'Terminer : Faire mon lit' });
    fireEvent.click(box);
    fireEvent.click(box);
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Rouvrir : Faire mon lit' })).toBeChecked());
    expect(await logDates(h, lit.id as RoutineId)).toEqual(['2026-10-02']);
  });

  it('PC : Espace sur la routine sélectionnée la valide puis la rouvre (critère 8)', async () => {
    mockViewport(1440);
    const lit = await seedRoutine(h, { title: 'Faire mon lit' });
    renderToday(h.container);
    const box = await screen.findByRole('checkbox', { name: 'Terminer : Faire mon lit' });
    fireEvent.focus(box);
    expect(h.container.shortcuts.handle(space)).toBe('list.complete');
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Rouvrir : Faire mon lit' })).toBeChecked());
    expect(await logDates(h, lit.id as RoutineId)).toEqual(['2026-10-02']);
    fireEvent.focus(screen.getByRole('checkbox', { name: 'Rouvrir : Faire mon lit' }));
    expect(h.container.shortcuts.handle(space)).toBe('list.complete');
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Terminer : Faire mon lit' })).not.toBeChecked());
    expect(await logDates(h, lit.id as RoutineId)).toEqual([]);
  });

  it('PC : sur un jour futur (flèche « Jour suivant ») la case de la routine est inactive (critère 11)', async () => {
    mockViewport(1440);
    const lit = await seedRoutine(h, { title: 'Faire mon lit' });
    renderToday(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Jour suivant' }));
    const box = await screen.findByRole('checkbox', { name: 'Terminer : Faire mon lit' });
    expect(box).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(box);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await logDates(h, lit.id as RoutineId)).toEqual([]);
  });

  it('l’état coché est conservé après redémarrage (critère 9)', async () => {
    mockViewport(440);
    const lit = await seedRoutine(h, { title: 'Faire mon lit' });
    await seedLog(h, lit, '2026-10-02');
    renderToday(h.container);
    expect(await screen.findByRole('checkbox', { name: 'Rouvrir : Faire mon lit' })).toBeChecked();
  });

  it('Semaine : une routine d’un jour passé se coche pour ce jour-là, un jour futur est inactif (critères 6, 11)', async () => {
    mockViewport(1440);
    const lit = await seedRoutine(h, { title: 'Faire mon lit', time: '07:30' as never });
    renderWeek(h.container);
    const monday = await waitFor(() => {
      const day = document.querySelector('.ct-week-day[data-date="2026-09-28"]') as HTMLElement | null;
      if (!day) throw new Error('lundi absent');
      return day;
    });
    fireEvent.click(await within(monday).findByRole('checkbox', { name: 'Terminer : Faire mon lit' }));
    await waitFor(() => expect(within(monday).getByRole('checkbox', { name: 'Rouvrir : Faire mon lit' })).toBeChecked());
    expect(await logDates(h, lit.id as RoutineId)).toEqual(['2026-09-28']);

    const sunday = document.querySelector('.ct-week-day[data-date="2026-10-04"]') as HTMLElement;
    const futureBox = within(sunday).getByRole('checkbox', { name: 'Terminer : Faire mon lit' });
    expect(futureBox).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(futureBox);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await logDates(h, lit.id as RoutineId)).toEqual(['2026-09-28']);
  });

  it('Semaine : « 3 fois par semaine » disparaît des jours restants dès le 3e jour validé (QB-01, critère 12)', async () => {
    mockViewport(1440);
    const run = await seedRoutine(h, { title: 'Courir', scheduleType: 'x_per_week', timesPerWeek: 3 });
    await seedLog(h, run, '2026-09-28');
    await seedLog(h, run, '2026-09-29');
    renderWeek(h.container);
    const wednesday = await waitFor(() => {
      const day = document.querySelector('.ct-week-day[data-date="2026-09-30"]') as HTMLElement | null;
      if (!day) throw new Error('mercredi absent');
      return day;
    });
    fireEvent.click(await within(wednesday).findByRole('checkbox', { name: 'Terminer : Courir' }));
    await waitFor(() => expect(within(wednesday).getByRole('checkbox', { name: 'Rouvrir : Courir' })).toBeChecked());
    for (const date of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']) {
      const day = document.querySelector(`.ct-week-day[data-date="${date}"]`) as HTMLElement;
      await waitFor(() => expect(within(day).queryByText('Courir')).toBeNull());
    }
  });
});
