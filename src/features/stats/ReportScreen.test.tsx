import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { newEntityId } from '../../domain/id';
import type { GoalId, LocalDate, SpaceId } from '../../domain/types';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { DEFAULT_ROUTES, useNavigationStore } from '../app/navigation';
import { seedLog, seedRoutine } from '../routines/testKit';
import { mockViewport, setupToday, teardownToday, type TodayHarness } from '../today/testKit';
import { ReportScreen, type ReportScreenProps } from './ReportScreen';

// Aujourd'hui : mer. 23 sept. 2026 (le rapport s'ouvre sur septembre, comme Rapport.html).
const NOW = '2026-09-23T10:00:00.000Z';
let counter = 0;

async function task(h: TodayHarness, date: string, done: boolean, space: SpaceId = SPACE_PRO_ID, project: string | null = null): Promise<void> {
  counter += 1;
  await h.db.driver.execute(
    `INSERT INTO task (id, space_id, project_id, title, date, status, done_at, sort_order, created_at, updated_at, device_id, hlc)
     VALUES (?, ?, ?, 'T', ?, ?, ?, 1, 'z', 'z', 'd', 'h')`,
    [`70000000-0000-4000-8000-${String(counter).padStart(12, '0')}`, space, project, date, done ? 'done' : 'todo', done ? `${date}T08:00:00.000Z` : null],
  );
}

function renderReport(h: TodayHarness, props: ReportScreenProps = {}) {
  return render(
    <AppContainerProvider container={h.container}>
      <ReportScreen {...props} />
    </AppContainerProvider>,
  );
}

const tile = (name: RegExp | string) => screen.findByRole('group', { name });

describe('Rapport du mois (H-01)', () => {
  beforeAll(async () => {
    await import('./CompletionChart');
  }, 60_000);

  let h: TodayHarness;

  beforeEach(async () => {
    counter = 0;
    mockViewport(440);
    h = await setupToday(`7${String(Math.floor(Math.random() * 9000) + 1000)}`, NOW);
  });
  afterEach(async () => {
    await teardownToday(h);
    cleanup();
  });

  async function seedSeptember(): Promise<void> {
    // 61 tâches datées de septembre jusqu'au 23, dont 48 terminées (critère 3), plus une tâche future et une « Un jour » qui ne comptent pas.
    for (let i = 0; i < 61; i += 1) await task(h, `2026-09-${String((i % 23) + 1).padStart(2, '0')}`, i < 48);
    await task(h, '2026-09-28', false);
    await h.db.driver.execute("UPDATE task SET someday = 1 WHERE id = ?", [`70000000-0000-4000-8000-${String(1).padStart(12, '0')}`]);
  }

  it('critères 2 et 12 : en-tête « Rapport du mois » et mois, annonce du changement de mois', async () => {
    await seedSeptember();
    renderReport(h);
    expect(await screen.findByRole('heading', { level: 1, name: 'septembre' })).toBeInTheDocument();
    expect(screen.getByText('Rapport du mois')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Rapport de septembre');
  });

  it('critère 3 : 61 tâches datées de septembre dont 48 terminées affichent « 48 / 61 » (hors Un jour et dates futures)', async () => {
    await seedSeptember();
    // La tâche « Un jour » est l'une des 48 terminées : 47 / 60.
    renderReport(h);
    const group = await tile('Tâches faites : 47 sur 60');
    expect(group).toHaveTextContent('TÂCHES FAITES');
    expect(group).toHaveTextContent('47 / 60');
  });

  it('critères 4 à 6 : routines, Focus et objectifs, « — » quand il n’y a rien', async () => {
    await task(h, '2026-09-02', true);
    renderReport(h);
    expect(await tile('Routines : aucune occurrence prévue')).toHaveTextContent('—');
    expect(screen.getByRole('group', { name: 'Focus : 0 min' })).toHaveTextContent('0 min');
    expect(screen.getByRole('group', { name: 'Objectifs : aucun objectif' })).toHaveTextContent('—');
  });

  it('critère 4 : le taux des routines compte les occurrences prévues validées, jours futurs exclus', async () => {
    await task(h, '2026-09-02', true);
    const lit = await seedRoutine(h, { title: 'Faire mon lit', startDate: '2026-09-21' as LocalDate });
    // 21, 22 prévus et passés ; 23 (aujourd'hui) n'entre que s'il est validé : 21 validé, 22 manqué = 50 %.
    await seedLog(h, lit, '2026-09-21');
    renderReport(h);
    expect(await tile('Routines : 50 %')).toHaveTextContent('50 %');
  });

  it('critère 5 : le temps de concentration du mois', async () => {
    await task(h, '2026-09-02', true);
    await h.db.driver.execute(
      "INSERT INTO focus_session (id, task_id, space_id, planned_min, started_at, ended_at, paused_sec, created_at, updated_at, device_id, hlc) VALUES ('40000000-0000-4000-8000-000000000001', NULL, ?, 25, '2026-09-10T08:00:00.000Z', '2026-09-10T09:25:00.000Z', 0, 'z', 'z', 'd', 'h')",
      [SPACE_PRO_ID],
    );
    renderReport(h);
    expect(await tile('Focus : 1 h 25')).toHaveTextContent('1 h 25');
  });

  it('critère 6 : « 2 / 3 atteints » pour les objectifs dont la semaine commence dans le mois', async () => {
    await task(h, '2026-09-02', true);
    const goals = h.container.data.repos.goals;
    for (const [week, status] of [['2026-09-07', 'achieved'], ['2026-09-14', 'achieved'], ['2026-09-21', 'open']] as const) {
      h.db.clock.advance(1);
      const goal = await goals.create({ id: newEntityId<GoalId>(h.container.ids), spaceId: SPACE_PRO_ID, weekStart: week as LocalDate, title: 'Objectif', icon: null, pinned: false, status: 'open', carriedFromId: null });
      if (status === 'achieved') await goals.setStatus(goal.id, 'achieved');
    }
    renderReport(h);
    const group = await tile('Objectifs : 2 atteints sur 3');
    expect(group).toHaveTextContent('2 / 3 atteints');
  });

  it('critère 7 : le filtre d’espace recalcule les tuiles ; sous un filtre de projet, routines et objectifs passent à « — »', async () => {
    await task(h, '2026-09-02', true, SPACE_PRO_ID);
    await task(h, '2026-09-03', false, SPACE_PRO_ID);
    await task(h, '2026-09-04', true, SPACE_PERSO_ID);
    renderReport(h);
    await tile('Tâches faites : 2 sur 3');
    fireEvent.click(screen.getByRole('button', { name: 'Pro' }));
    await tile('Tâches faites : 1 sur 2');
    fireEvent.click(screen.getByRole('button', { name: 'Perso' }));
    await tile('Tâches faites : 1 sur 1');
    fireEvent.click(screen.getByRole('button', { name: 'Tout' }));
    await tile('Tâches faites : 2 sur 3');
  });

  it('critère 2 : pas au-delà du mois courant, pas avant la plus ancienne donnée ; « Août » puis retour', async () => {
    await task(h, '2026-08-15', true);
    await task(h, '2026-09-02', true);
    renderReport(h);
    await screen.findByRole('heading', { level: 1, name: 'septembre' });
    const next = screen.getByRole('button', { name: 'Mois suivant' });
    const previous = screen.getByRole('button', { name: 'Mois précédent' });
    expect(next).toBeDisabled();
    await waitFor(() => expect(previous).toBeEnabled());
    fireEvent.click(previous);
    expect(await screen.findByRole('heading', { level: 1, name: 'août' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Rapport de août');
    expect(screen.getByRole('button', { name: 'Mois précédent' })).toBeDisabled();
    expect(next).toBeEnabled();
    await tile('Tâches faites : 1 sur 1');
    fireEvent.click(next);
    expect(await screen.findByRole('heading', { level: 1, name: 'septembre' })).toBeInTheDocument();
  });

  it('critère 2 : une autre année affiche l’année (« août 2025 »)', async () => {
    await task(h, '2025-08-15', true);
    await task(h, '2026-09-02', true);
    renderReport(h);
    await screen.findByRole('heading', { level: 1, name: 'septembre' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Mois précédent' })).toBeEnabled());
    for (let i = 0; i < 13; i += 1) fireEvent.click(screen.getByRole('button', { name: 'Mois précédent' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'août 2025' })).toBeInTheDocument();
  });

  it('critère 9 : un mois sans donnée affiche l’écran vide et le bouton « Aller à Aujourd’hui »', async () => {
    renderReport(h);
    expect(await screen.findByText('Rien à compter en septembre.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Aller à Aujourd’hui' }));
    expect(useNavigationStore.getState().route).toEqual(DEFAULT_ROUTES.tasks);
  });

  it('critère 8 : tuiles, CONCENTRATION, routines puis lien « Tâches terminées » dans cet ordre', async () => {
    await task(h, '2026-09-02', true);
    const lit = await seedRoutine(h, { title: 'Faire mon lit', startDate: '2026-09-01' as LocalDate });
    await seedLog(h, lit, '2026-09-02');
    renderReport(h);
    await tile(/^Tâches faites/);
    const concentration = await screen.findByRole('region', { name: 'CONCENTRATION' });
    const routines = screen.getByRole('group', { name: 'ROUTINES — JOURS COMPLÉTÉS' });
    const link = screen.getByRole('button', { name: 'Tâches terminées' });
    const before = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(screen.getByRole('group', { name: 'Chiffres du mois' }), concentration)).toBe(true);
    expect(before(concentration, routines)).toBe(true);
    expect(before(routines, link)).toBe(true);
    fireEvent.click(link);
    expect(useNavigationStore.getState().route).toEqual({ tab: 'tasks', screen: 'done' });
  });

  it('carte des routines jour par jour, taux par routine (routines archivées comptées par leurs validations)', async () => {
    await task(h, '2026-09-02', true);
    const lit = await seedRoutine(h, { title: 'Faire mon lit' });
    const archived = await seedRoutine(h, { title: 'Ancienne', archived: true });
    for (const day of ['2026-09-08', '2026-09-09']) await seedLog(h, lit, day);
    await seedLog(h, archived, '2026-09-09');
    renderReport(h);
    const grid = await screen.findByRole('group', { name: 'ROUTINES — JOURS COMPLÉTÉS' });
    expect(within(grid).getByRole('img', { name: '9 septembre, tout validé : 2 sur 2' })).toHaveAttribute('data-state', 'all');
    expect(within(grid).getByRole('img', { name: '8 septembre, tout validé : 1 sur 1' })).toBeInTheDocument();
    expect(within(grid).getByRole('img', { name: '10 septembre, rien de validé sur 1' })).toHaveAttribute('data-state', 'missed');
    expect(within(grid).getByRole('img', { name: '23 septembre, 1 prévues' })).toHaveAttribute('data-today', 'true');
    const rates = screen.getByRole('list', { name: 'Taux du mois par routine' });
    expect(within(rates).getByText('Faire mon lit')).toBeInTheDocument();
    expect(within(rates).queryByText('Ancienne')).toBeNull();
  });

  it('critère 10 : ouvert depuis les Routines, le rapport défile jusqu’à la section routines et « Retour » ramène aux Routines', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    await task(h, '2026-09-02', true);
    await seedRoutine(h, { title: 'Faire mon lit' });
    renderReport(h, { entry: 'routines' });
    await screen.findByRole('group', { name: 'ROUTINES — JOURS COMPLÉTÉS' });
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Retour' }));
    expect(useNavigationStore.getState().route).toEqual(DEFAULT_ROUTES.routines);
  });

  it('« Retour » depuis l’icône d’Aujourd’hui ramène à Aujourd’hui', async () => {
    await task(h, '2026-09-02', true);
    renderReport(h);
    await screen.findByRole('heading', { level: 1, name: 'septembre' });
    useNavigationStore.getState().navigate({ tab: 'tasks', screen: 'report' });
    fireEvent.click(screen.getByRole('button', { name: 'Retour' }));
    expect(useNavigationStore.getState().route).toEqual(DEFAULT_ROUTES.tasks);
  });

  it('critère 11 : sur PC, la mise en page est marquée « pc » (tuiles sur une ligne)', async () => {
    mockViewport(1440);
    await task(h, '2026-09-02', true);
    const { container } = renderReport(h);
    await screen.findByRole('group', { name: 'Chiffres du mois' });
    expect(container.querySelector('.ct-stats')).toHaveAttribute('data-layout', 'pc');
    expect(useAppStore.getState().spaceFilter).toBe('all');
  });
});
