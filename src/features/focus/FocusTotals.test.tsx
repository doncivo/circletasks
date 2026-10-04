import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManualClock } from '../../domain/clock';
import type { TaskId } from '../../domain/types';
import type { FocusWindowState } from '../../platform/focus';
import { SPACE_PERSO_ID, SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { setFormatPrefs } from '../../i18n/formatPrefs';
import { AppContainerProvider } from '../app/AppContainerContext';
import { useAppStore } from '../app/appStore';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { ReportScreen } from '../stats';
import { TaskDetail } from '../tasks/TaskDetail';
import { FocusView } from './FocusView';
import { focusStore } from './focusStore';
import { MIN, seedFocusTask, setupFocus, type FocusHarness } from './testKit';

function mockViewport(width: number): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width >= 1024 && query.includes('min-width: 1024px'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

function stateOf(today: { minutes: number; sessions: number }): FocusWindowState {
  return {
    phase: 'running',
    session: { id: 's1', plannedMin: 25, startedAt: '2026-10-04T08:00:00.000Z', endedAt: null, pausedSec: 0, pausedAt: null },
    title: 'Envoyer la facture',
    time: null,
    spaceName: 'Pro',
    canFinishTask: true,
    today,
    sound: { enabled: false, nonce: 0 },
    endedMinutes: 0,
    locale: 'fr',
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Pied de l’écran Focus (F-03 critères 1 et 2)', () => {
  const clock = () => createManualClock(Date.parse('2026-10-04T08:05:00.000Z'));

  it('critère 1 : « Aujourd’hui : 1 h 15 de concentration · 3 sessions »', () => {
    render(<FocusView state={stateOf({ minutes: 75, sessions: 3 })} variant="screen" clock={clock()} onAction={() => undefined} />);
    expect(screen.getByText('Aujourd’hui : 1 h 15 de concentration · 3 sessions')).toBeInTheDocument();
  });

  it('critère 2 : aucune session, « Aujourd’hui : 0 min de concentration »', () => {
    render(<FocusView state={stateOf({ minutes: 0, sessions: 0 })} variant="window" clock={clock()} onAction={() => undefined} />);
    expect(screen.getByText('Aujourd’hui : 0 min de concentration')).toBeInTheDocument();
  });
});

describe('Totaux de concentration : magasin, fiche et rapport (F-03)', () => {
  let h: FocusHarness;
  let counter = 0;

  beforeEach(async () => {
    mockViewport(1440);
    h = await setupFocus(`5${String(counter++).padStart(2, '0')}`, {}, '2026-10-04T08:00:00.000Z');
    useAppStore.getState().setSpaces(await h.container.data.repos.spaces.listAll());
    setFormatPrefs({ firstWeekday: 'monday' });
  });
  afterEach(async () => {
    useAppStore.setState({ spaces: [], projects: [], spaceFilter: 'all', projectFilter: null, day: null });
    useNavigationStore.setState(INITIAL_NAVIGATION);
    await h.db.close();
  });

  const store = () => focusStore.get(h.container);

  async function session(taskId: TaskId, minutes: number) {
    await store().getState().start(taskId);
    h.db.clock.advance(minutes * MIN);
    await store().getState().stop();
    h.db.clock.advance(MIN);
  }

  it('critère 1 : le pied du magasin compte toutes les sessions terminées du jour, tous espaces confondus', async () => {
    const pro = await seedFocusTask(h.container, 'Pro');
    const perso = await seedFocusTask(h.container, 'Perso', { spaceId: SPACE_PERSO_ID });
    await session(pro.id, 45);
    await session(perso.id, 20);
    await session(pro.id, 10);
    expect(store().getState().today).toEqual({ minutes: 75, sessions: 3 });
    // Le filtre d'espace n'y change rien (D3).
    useAppStore.getState().setSpaceFilter(SPACE_PRO_ID);
    expect(store().getState().today).toEqual({ minutes: 75, sessions: 3 });
  });

  it('critère 2 : sans session, le pied est à zéro ; une session en cours n’est pas comptée', async () => {
    await store().getState().restore();
    expect(store().getState().today).toEqual({ minutes: 0, sessions: 0 });
    const task = await seedFocusTask(h.container);
    await store().getState().start(task.id);
    h.db.clock.advance(10 * MIN);
    expect(store().getState().today).toEqual({ minutes: 0, sessions: 0 });
    await store().getState().stop();
    expect(store().getState().today).toEqual({ minutes: 10, sessions: 1 });
  });

  it('critère 3 : la fiche affiche « Concentration  50 min · 2 sessions », absente sans session, mise à jour à la clôture', async () => {
    const task = await seedFocusTask(h.container);
    useNavigationStore.getState().openDetail({ type: 'task', id: task.id });
    render(
      <AppContainerProvider container={h.container}>
        <TaskDetail />
      </AppContainerProvider>,
    );
    const fiche = await screen.findByRole('complementary', { name: 'Détail de la tâche' });
    await within(fiche).findByRole('heading', { name: 'Envoyer la facture' });
    expect(within(fiche).queryByText('Concentration')).not.toBeInTheDocument();
    await act(async () => {
      await session(task.id, 25);
      await session(task.id, 25);
    });
    expect(await within(fiche).findByText('Concentration')).toBeInTheDocument();
    expect(await within(fiche).findByText('50 min · 2 sessions')).toBeInTheDocument();
    // Une troisième session en cours ne compte qu'à sa fermeture.
    await act(async () => {
      await store().getState().start(task.id);
      h.db.clock.advance(30 * MIN);
    });
    expect(within(fiche).getByText('50 min · 2 sessions')).toBeInTheDocument();
    await act(async () => {
      await store().getState().stop();
    });
    expect(await within(fiche).findByText('1 h 20 · 3 sessions')).toBeInTheDocument();
  });

  it('critère 3 : la ligne reste après la suppression de la tâche (la session reste comptée)', async () => {
    const task = await seedFocusTask(h.container);
    await session(task.id, 25);
    await h.db.data.repos.tasks.softDelete([task.id]);
    expect(await h.db.data.repos.focusSessions.totalsForTask(task.id)).toEqual({ seconds: 1500, sessions: 1 });
  });

  describe('rapport : section CONCENTRATION (critères 4 à 7)', () => {
    async function seed() {
      await h.db.driver.execute("INSERT INTO project (id, space_id, name, color, sort_order, created_at, updated_at, device_id, hlc) VALUES ('10000000-0000-4000-8000-0000000000b1', ?, 'Mission client', '#2f6b7a', 1, 'z', 'z', 'd', 'h')", [SPACE_PRO_ID]);
      useAppStore.getState().setProjects(await h.container.data.repos.projects.listForFilter('all', { includeArchived: true }));
      const facture = await seedFocusTask(h.container, 'Envoyer la facture');
      h.container.taskEntities.publish([await h.container.data.repos.tasks.update(facture.id, { projectId: '10000000-0000-4000-8000-0000000000b1' as never })]);
      const courses = await seedFocusTask(h.container, 'Courses', { spaceId: SPACE_PERSO_ID });
      const notaire = await seedFocusTask(h.container, 'Appeler le notaire');
      await session(facture.id, 90);
      await session(facture.id, 60);
      await session(courses.id, 20);
      await session(notaire.id, 35);
    }

    function renderReport() {
      return render(
        <AppContainerProvider container={h.container}>
          <ReportScreen />
        </AppContainerProvider>,
      );
    }

    it('critère 4 : Aujourd’hui, Cette semaine, Ce mois et les tâches les plus travaillées (« Envoyer la facture · 2 h 30 »)', async () => {
      await seed();
      useAppStore.getState().setDay('2026-10-04' as never);
      renderReport();
      const section = await screen.findByRole('region', { name: 'CONCENTRATION' });
      const rows = within(section).getAllByRole('listitem').map((row) => row.textContent);
      expect(rows).toEqual(['Aujourd’hui3 h 25', 'Cette semaine3 h 25', 'Ce mois3 h 25', 'Envoyer la facture2 h 30', 'Appeler le notaire35 min', 'Courses20 min']);
    });

    // Le délai (< 300 ms) est mesuré par monthReportLoader.perf.test.ts ; ici seul le résultat compte (suite chargée).
    it('critère 5 : le filtre Pro puis le projet « Mission client » recalculent aussitôt les totaux', async () => {
      await seed();
      useAppStore.getState().setDay('2026-10-04' as never);
      renderReport();
      const section = await screen.findByRole('region', { name: 'CONCENTRATION' });
      await within(section).findByText('Courses');
      act(() => useAppStore.getState().setSpaceFilter(SPACE_PRO_ID));
      await waitFor(() => expect(within(section).queryByText('Courses')).not.toBeInTheDocument(), { timeout: 2_000 });
      expect(within(section).getAllByRole('listitem').map((row) => row.textContent)).toEqual(['Aujourd’hui3 h 05', 'Cette semaine3 h 05', 'Ce mois3 h 05', 'Envoyer la facture2 h 30', 'Appeler le notaire35 min']);
      act(() => useAppStore.getState().setProjectFilter('10000000-0000-4000-8000-0000000000b1' as never));
      await waitFor(() => expect(within(section).queryByText('Appeler le notaire')).not.toBeInTheDocument(), { timeout: 2_000 });
      expect(within(section).getAllByRole('listitem').map((row) => row.textContent)).toEqual(['Aujourd’hui2 h 30', 'Cette semaine2 h 30', 'Ce mois2 h 30', 'Envoyer la facture2 h 30']);
    });

    it.each([
      ['monday', 'Cette semaine4 h 25'],
      ['saturday', 'Cette semaine4 h 25'],
      ['sunday', 'Cette semaine3 h 25'],
    ] as const)('critère 7 : « Cette semaine » suit le premier jour de semaine (%s)', async (firstWeekday, expected) => {
      await seed();
      useAppStore.getState().setDay('2026-10-04' as never);
      // Une session le samedi 3 oct. (1 h) et une le dimanche 27 sept. (hors de toute semaine du 4 oct. choisie ci-dessous).
      const insert = "INSERT INTO focus_session (id, space_id, planned_min, started_at, ended_at, paused_sec, created_at, updated_at, device_id, hlc) VALUES (?, ?, 25, ?, ?, 0, 'z', 'z', 'd', 'h')";
      await h.db.driver.execute(insert, ['40000000-0000-4000-8000-0000000000e1', SPACE_PRO_ID, new Date(2026, 9, 3, 10, 0).toISOString(), new Date(2026, 9, 3, 11, 0).toISOString()]);
      await h.db.driver.execute(insert, ['40000000-0000-4000-8000-0000000000e2', SPACE_PRO_ID, new Date(2026, 8, 27, 10, 0).toISOString(), new Date(2026, 8, 27, 11, 0).toISOString()]);
      setFormatPrefs({ firstWeekday });
      renderReport();
      const section = await screen.findByRole('region', { name: 'CONCENTRATION' });
      await waitFor(() => expect(within(section).getAllByRole('listitem')[1]?.textContent).toBe(expected));
      // Le jour et le mois ne dépendent pas du premier jour de semaine.
      expect(within(section).getAllByRole('listitem')[0]?.textContent).toBe('Aujourd’hui3 h 25');
      expect(within(section).getAllByRole('listitem')[2]?.textContent).toBe('Ce mois4 h 25');
    });

    it('sans session ce mois-ci : message vide (le mois a une tâche, donc le rapport n’est pas vide, H-01)', async () => {
      await seedFocusTask(h.container, 'Envoyer la facture');
      useAppStore.getState().setDay('2026-10-04' as never);
      renderReport();
      const section = await screen.findByRole('region', { name: 'CONCENTRATION' });
      expect(within(section).getByText('Aucune session ce mois-ci.')).toBeInTheDocument();
    });
  });
});
