import { cleanup, render } from '@testing-library/react';
import { vi } from 'vitest';
import { todayLocal } from '../../domain/clock';
import { createHlcClock } from '../../domain/hlc';
import type { Task } from '../../domain/model';
import { asEntityId, type DeviceId, type LocalDate, type LocalTime, type SpaceId } from '../../domain/types';
import { openTestDb, type TestDb } from '../../db/repositories/sql/testSetup';
import { SPACE_PRO_ID } from '../../db/seed/defaultSpaces';
import { AppContainerProvider } from '../app/AppContainerContext';
import { UndoToast } from '../app/UndoToast';
import { useAppStore } from '../app/appStore';
import { useNoticeStore } from '../app/notice';
import { createAppContainer, type AppContainer } from '../app/container';
import { INITIAL_NAVIGATION, useNavigationStore } from '../app/navigation';
import { createTaskUseCases } from '../tasks/createTaskUseCases';
import { TodayScreen } from './TodayScreen';

/** Aides des tests d'écran d'Aujourd'hui (A-01 à A-09) : base en mémoire, conteneur, rendu, jeu de tâches. */
export interface TodayHarness {
  readonly db: TestDb;
  readonly container: AppContainer;
  readonly today: LocalDate;
}

export function mockViewport(width: number): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width >= 1024 && query.includes('min-width: 1024px'),
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

export async function setupToday(deviceSuffix: string, startAt = '2026-10-02T10:00:00.000Z'): Promise<TodayHarness> {
  const device = asEntityId<DeviceId>(`60000000-0000-4000-8000-0000000${deviceSuffix.padStart(5, '0')}`);
  const db = await openTestDb(device, startAt);
  const container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: device }), data: db.data });
  useAppStore.getState().setSpaces(await container.data.repos.spaces.listAll());
  return { db, container, today: todayLocal(db.clock) };
}

export async function teardownToday(harness: TodayHarness): Promise<void> {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useAppStore.setState({ spaceFilter: 'all', spaces: [], day: null });
  useNoticeStore.setState({ notice: null });
  useNavigationStore.setState(INITIAL_NAVIGATION);
  await harness.db.close();
}

export function renderToday(container: AppContainer) {
  return render(
    <AppContainerProvider container={container}>
      <TodayScreen />
      <UndoToast />
    </AppContainerProvider>,
  );
}

export interface SeedTask {
  readonly title: string;
  readonly time?: string;
  readonly date?: LocalDate;
  readonly spaceId?: SpaceId;
}

/** Crée une tâche du jour (ou de `date`) ; `sortOrder` croît avec l'ordre des appels (horloge avancée de 1 ms). */
export async function seedTask(harness: TodayHarness, seed: SeedTask): Promise<Task> {
  harness.db.clock.advance(1);
  const result = await createTaskUseCases(harness.container).create({
    title: seed.title,
    spaceId: seed.spaceId ?? SPACE_PRO_ID,
    date: seed.date ?? harness.today,
    ...(seed.time ? { time: seed.time as LocalTime } : {}),
  });
  if (!result.ok) throw new Error(`création impossible : ${result.error}`);
  return result.value;
}
