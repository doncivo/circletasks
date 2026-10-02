import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addDays } from '../../domain/localDate';
import type { LocalDate } from '../../domain/types';
import { formatStreak } from '../../i18n/formatRoutine';
import { mockViewport, renderRoutines, seedLog, seedRoutine, setupRoutines, teardownRoutines, type RoutinesHarness } from './testKit';

// Aujourd'hui : ven. 2 oct. 2026.
const card = (title: string): HTMLElement => screen.getByRole('heading', { name: title }).closest('article') as HTMLElement;

async function seedDays(h: RoutinesHarness, routine: Parameters<typeof seedLog>[1], from: string, to: string): Promise<void> {
  for (let date = from as LocalDate; date <= (to as LocalDate); date = addDays(date, 1)) await seedLog(h, routine, date);
}

describe('Routines : séries (R-04)', () => {
  let h: RoutinesHarness;

  beforeEach(async () => {
    h = await setupRoutines('241');
    mockViewport(440);
  });
  afterEach(() => teardownRoutines(h));

  it('accords singulier / pluriel : 1 jour, 12 jours, 1 séance, 4 séances, 1 semaine, 5 semaines (critère 6)', () => {
    expect(formatStreak(0, 'days')).toBe('0 jour');
    expect(formatStreak(1, 'days')).toBe('1 jour');
    expect(formatStreak(12, 'days')).toBe('12 jours');
    expect(formatStreak(1, 'sessions')).toBe('1 séance');
    expect(formatStreak(4, 'sessions')).toBe('4 séances');
    expect(formatStreak(1, 'weeks')).toBe('1 semaine');
    expect(formatStreak(5, 'weeks')).toBe('5 semaines');
  });

  it('carte quotidienne : 10 jours validés, aujourd’hui non fait = série 10 ; après validation d’aujourd’hui 11 (critère 1)', async () => {
    const lit = await seedRoutine(h, { title: 'Faire mon lit', time: '07:30' as never });
    await seedDays(h, lit, '2026-09-22', '2026-10-01');
    renderRoutines(h.container);
    await screen.findByRole('heading', { name: 'Faire mon lit' });
    expect(card('Faire mon lit')).toHaveTextContent('07:30 · Pro · série 10 jours');
    fireEvent.click(within(card('Faire mon lit')).getByRole('checkbox', { name: 'Vendredi' }));
    await waitFor(() => expect(card('Faire mon lit')).toHaveTextContent('série 11 jours'));
  });

  it('série d’un jour au singulier ; aucune mention quand la série est à 0 (critère 7)', async () => {
    const un = await seedRoutine(h, { title: 'Un jour' });
    await seedLog(h, un, '2026-10-01');
    await seedRoutine(h, { title: 'Jamais faite' });
    const rompue = await seedRoutine(h, { title: 'Rompue' });
    await seedLog(h, rompue, '2026-09-29'); // 30 sept. et 1er oct. manqués
    renderRoutines(h.container);
    await screen.findByRole('heading', { name: 'Un jour' });
    expect(card('Un jour')).toHaveTextContent('série 1 jour');
    expect(card('Jamais faite')).not.toHaveTextContent('série');
    expect(card('Rompue')).not.toHaveTextContent('série');
  });

  it('Sport lun., mer., ven. : validé lun., mer., ven., lun. = 4 séances, mar. et jeu. ne cassent pas (critère 2)', async () => {
    const sport = await seedRoutine(h, { title: 'Sport', scheduleType: 'weekdays', weekdays: [1, 3, 5] });
    for (const day of ['2026-09-21', '2026-09-23', '2026-09-25', '2026-09-28', '2026-09-30']) await seedLog(h, sport, day);
    renderRoutines(h.container);
    await screen.findByRole('heading', { name: 'Sport' });
    // Aujourd'hui, ven. 2 oct., prévu et non validé : ne casse pas la série.
    expect(card('Sport')).toHaveTextContent('lun., mer., ven. · série 5 séances');
  });

  it('une occurrence prévue hier non validée remet la série à 0 (critère 3)', async () => {
    const sport = await seedRoutine(h, { title: 'Sport', scheduleType: 'weekdays', weekdays: [1, 3, 5] });
    await seedLog(h, sport, '2026-09-28');
    renderRoutines(h.container);
    await screen.findByRole('heading', { name: 'Sport' });
    // Mer. 30 sept. prévue et non validée.
    expect(card('Sport')).not.toHaveTextContent('série');
  });

  it('« 3 fois par semaine » : 4 semaines de quota atteint = « série 4 semaines », la semaine en cours incomplète ne la casse pas (critère 9, QB-02)', async () => {
    const run = await seedRoutine(h, { title: 'Courir', scheduleType: 'x_per_week', timesPerWeek: 3, startDate: '2026-08-01' as LocalDate });
    for (const monday of ['2026-09-07', '2026-09-14', '2026-09-21']) {
      await seedDays(h, run, monday, addDays(monday as LocalDate, 2));
    }
    await seedLog(h, run, '2026-08-31');
    await seedLog(h, run, '2026-09-01');
    await seedLog(h, run, '2026-09-02');
    await seedLog(h, run, '2026-09-28'); // semaine en cours : 1/3
    renderRoutines(h.container);
    await screen.findByRole('heading', { name: 'Courir' });
    expect(card('Courir')).toHaveTextContent('3 fois par semaine · série 4 semaines');
  });

  it('formulaire de modification : « Série en cours 4 séances · Meilleure 11 » (critère 7)', async () => {
    const sport = await seedRoutine(h, { title: 'Sport', scheduleType: 'weekdays', weekdays: [1, 3, 5], startDate: '2026-06-01' as LocalDate });
    // Meilleure série : 11 séances en juillet (lun., mer., ven.), puis 4 en septembre (rompue entre-temps).
    for (const day of ['2026-07-06', '2026-07-08', '2026-07-10', '2026-07-13', '2026-07-15', '2026-07-17', '2026-07-20', '2026-07-22', '2026-07-24', '2026-07-27', '2026-07-29']) {
      await seedLog(h, sport, day);
    }
    for (const day of ['2026-09-21', '2026-09-23', '2026-09-25', '2026-09-28']) await seedLog(h, sport, day);
    await seedLog(h, sport, '2026-09-30');
    await seedLog(h, sport, '2026-10-02');
    renderRoutines(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Éditer la routine Sport' }));
    const form = await screen.findByRole('form', { name: 'Modifier la routine' });
    expect(form).toHaveTextContent('Série en cours 6 séances');
    expect(within(form).getByLabelText('Meilleure série 11 séances')).toHaveTextContent('Meilleure 11');
  });

  it('un nouveau formulaire n’a pas d’encart de série', async () => {
    renderRoutines(h.container);
    fireEvent.click(await screen.findByRole('button', { name: 'Ajouter une routine' }));
    const form = await screen.findByRole('form', { name: 'Nouvelle routine' });
    expect(form).not.toHaveTextContent('Série en cours');
  });
});
