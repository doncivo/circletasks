import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { ALL_ITEMS } from '../../domain/itemFilter';
import { buildMonthReport, type MonthReport } from '../../domain/monthReport';
import type { LocalDate, RoutineId } from '../../domain/types';
import type { DateInterval } from '../../domain/routineSchedule';
import { CompletionSection, chartBarsOf } from './CompletionSection';

const d = (value: string) => value as LocalDate;

// Septembre 2026 consulté le 23 : S36 71 %, S37 84 %, S38 sans tâche, S39 (courante) 62 %.
function report(counts: readonly { weekStart: string; done: number; total: number }[], today = '2026-09-23'): MonthReport {
  return buildMonthReport({
    month: { year: 2026, month: 9 },
    today: d(today),
    filter: ALL_ITEMS,
    firstWeekday: 'monday',
    weekCounts: counts.map((count) => ({ ...count, weekStart: d(count.weekStart) })),
    routines: { routines: [], doneByRoutine: new Map<RoutineId, ReadonlySet<LocalDate>>(), pausesOf: new Map<RoutineId, readonly DateInterval[]>() },
    focus: { seconds: 0, sessions: 0 },
    goals: { achieved: 0, total: 0 },
  });
}

const COUNTS = [
  { weekStart: '2026-08-31', done: 5, total: 7 },
  { weekStart: '2026-09-07', done: 21, total: 25 },
  { weekStart: '2026-09-21', done: 8, total: 13 },
];

describe('Graphique de complétion (H-02)', () => {
  // Recharts est chargé à la demande (import dynamique) : on le charge une fois avant les tests pour ne pas dépendre du délai de transformation.
  beforeAll(async () => {
    await import('./CompletionChart');
  }, 60_000);

  it('critère 1 : quatre barres S36 à S39 dont la semaine courante est repérée', () => {
    const bars = chartBarsOf(report(COUNTS));
    expect(bars.map((bar) => bar.label)).toEqual(['S36', 'S37', 'S38', 'S39']);
    expect(bars.map((bar) => bar.current)).toEqual([false, false, false, true]);
  });

  it('critère 2 : étiquettes de pourcentage, « — » pour une semaine sans tâche', () => {
    const bars = chartBarsOf(report(COUNTS));
    expect(bars.map((bar) => bar.valueLabel)).toEqual(['71 %', '84 %', '—', '62 %']);
  });

  it('critère 5 : bulle « S37 · 7 – 13 sept. · 21 sur 25 »', () => {
    const bars = chartBarsOf(report(COUNTS));
    expect(bars[1]?.bubble).toBe('S37 · 7 sept. – 13 sept. · 21 sur 25');
    expect(bars[0]?.bubble).toBe('S36 · 31 août – 6 sept. · 5 sur 7');
    expect(bars[2]?.bubble).toBe('S38 · 14 sept. – 20 sept. · aucune tâche');
  });

  it('critère 3 : « Mois : 79 % » à droite du titre, somme des barres égale au total du mois (34 sur 45 = 76 %)', async () => {
    render(<CompletionSection report={report(COUNTS)} />);
    expect(screen.getByRole('heading', { level: 2, name: 'TAUX DE COMPLÉTION PAR SEMAINE' })).toBeInTheDocument();
    expect(screen.getByTestId('month-rate')).toHaveTextContent('Mois : 76 %');
    expect(await screen.findAllByRole('img', { name: /^S3\d/ })).toHaveLength(4);
  });

  it('critère 3 : « Mois : — » sans tâche', () => {
    render(<CompletionSection report={report([])} />);
    expect(screen.getByTestId('month-rate')).toHaveTextContent('Mois : —');
  });

  it('critère 4 : un mois passé de cinq semaines montre cinq barres', () => {
    expect(chartBarsOf(report([], '2026-10-04')).map((bar) => bar.label)).toEqual(['S36', 'S37', 'S38', 'S39', 'S40']);
  });

  it('critère 8 : tableau équivalent lisible par lecteur d’écran', () => {
    render(<CompletionSection report={report(COUNTS)} />);
    const table = screen.getByRole('table', { name: 'Taux de complétion par semaine, en tableau' });
    expect(table).toHaveClass('ct-visually-hidden');
    const rows = within(table).getAllByRole('row').map((row) => row.textContent);
    expect(rows).toEqual(['Semaine 36 : 71 %, 5 tâches sur 7', 'Semaine 37 : 84 %, 21 tâches sur 25', 'Semaine 38 : aucune tâche', 'Semaine 39 : 62 %, 8 tâches sur 13']);
  });

  it('critères 2, 5 et 8 : les barres sont focalisables ; la semaine courante est marquée ; focus ou survol ouvre la bulle', async () => {
    render(<CompletionSection report={report(COUNTS)} />);
    const bars = await screen.findAllByRole('img', { name: /^S3\d/ });
    expect(bars[3]).toHaveAttribute('data-current', 'true');
    expect(bars[2]).toHaveAttribute('data-empty', 'true');
    for (const bar of bars) expect(bar).toHaveAttribute('tabindex', '0');
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.focus(bars[1] as Element);
    expect(screen.getByRole('tooltip')).toHaveTextContent('S37 · 7 sept. – 13 sept. · 21 sur 25');
    fireEvent.blur(bars[1] as Element);
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.pointerEnter(bars[0] as Element, { pointerType: 'mouse' });
    expect(screen.getByRole('tooltip')).toHaveTextContent('S36 · 31 août – 6 sept. · 5 sur 7');
  });
});
