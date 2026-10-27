import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { MonthReport } from '../../domain/monthReport';
import type { ProjectId, RoutineId } from '../../domain/types';
import { MonthTiles } from './MonthTiles';
import { reportTextsOf } from './reportTexts';

const base: MonthReport = {
  month: { year: 2026, month: 10 }, filter: { space: 'all', project: null },
  tasks: { done: 1, total: 1, percent: 100 }, routines: { planned: 0, done: 0, percent: null },
  focus: { seconds: 0, sessions: 0 }, goals: null, weeks: [], heatmap: null, routineRates: [], isEmpty: false,
};
afterEach(cleanup);
describe('UI-FIX-03 — absence de données explicite', () => {
  it('dit sans tiret les routines et objectifs absents, à l’écran et dans l’export', () => {
    render(<MonthTiles report={base} />);
    expect(screen.getByText('Aucune routine ce mois-ci')).toBeVisible();
    expect(screen.getByText('Aucun objectif')).toBeVisible();
    const texts = reportTextsOf(base, { currentYear: 2026, filterLabel: 'Tout', today: '2026-10-27' });
    expect(texts.tiles[1]?.value).toBe('Aucune routine ce mois-ci');
    expect(texts.tiles[3]?.value).toBe('Aucun objectif');
  });
  it('ne présente pas les données exclues par le projet comme inexistantes', () => {
    const report: MonthReport = { ...base, filter: { space: 'all', project: 'p' as ProjectId }, routines: null };
    render(<MonthTiles report={report} />);
    expect(screen.getAllByText('Non compté pour un projet')).toHaveLength(2);
    expect(screen.queryByText('Aucune routine ce mois-ci')).not.toBeInTheDocument();
    expect(screen.queryByText('Aucun objectif')).not.toBeInTheDocument();
  });
  it('distingue une routine présente sans occurrence comptable', () => {
    render(<MonthTiles report={{ ...base, routineRates: [{ id: 'r' as RoutineId, title: 'Routine future', percent: null }] }} />);
    expect(screen.getByText('Aucune occurrence prévue ce mois-ci')).toBeVisible();
    expect(screen.queryByText('Aucune routine ce mois-ci')).not.toBeInTheDocument();
  });
  it('conserve zéro pour un vrai taux nul et un objectif non atteint', () => {
    render(<MonthTiles report={{ ...base, routines: { planned: 2, done: 0, percent: 0 }, goals: { total: 1, achieved: 0 } }} />);
    expect(screen.getByRole('group', { name: 'Routines : 0 %' })).toHaveTextContent('0 %');
    expect(screen.getByRole('group', { name: 'Objectifs : 0 atteints sur 1' })).toHaveTextContent('0 / 1 atteints');
  });
  it('nomme le ratio hebdomadaire sans anglicisme', () => {
    const texts = reportTextsOf(base, { currentYear: 2026, filterLabel: 'Tout', today: '2026-10-27' });
    expect(texts.chartTitle).toBe('TAUX D’ACHÈVEMENT PAR SEMAINE');
  });
});
