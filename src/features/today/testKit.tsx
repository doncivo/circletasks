import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { expect, vi } from 'vitest';
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
import type { Haptics } from '../../platform/haptics';
import { TodayScreen } from './TodayScreen';
import { LazyEventForm } from '../events/lazyEventForm';
import { LazyRoutineForm } from '../routines/lazyRoutineForm';
import { LazyTaskCreateOptions } from '../tasks/TaskCreateSheet';

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

export async function setupToday(deviceSuffix: string, startAt = '2026-10-02T10:00:00.000Z', haptics?: Haptics): Promise<TodayHarness> {
  await LazyTaskCreateOptions.preload();
  const device = asEntityId<DeviceId>(`60000000-0000-4000-8000-0000000${deviceSuffix.padStart(5, '0')}`);
  const db = await openTestDb(device, startAt);
  const container = createAppContainer({ clock: db.clock, hlc: createHlcClock({ clock: db.clock, deviceId: device }), data: db.data, ...(haptics ? { haptics } : {}) });
  useAppStore.getState().setSpaces(await container.data.repos.spaces.listAll());
  // Segments Événement et Routine de la feuille Ajout : chargés d'avance (en production, au premier rendu de la feuille ou au repos), pour que les tests les voient rendus directement.
  await Promise.all([LazyEventForm.preload(), LazyRoutineForm.preload()]);
  return { db, container, today: todayLocal(db.clock) };
}

export async function teardownToday(harness: TodayHarness): Promise<void> {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useAppStore.setState({ spaceFilter: 'all', spaces: [], projects: [], projectFilter: null, day: null });
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

/**
 * UI-REFONTE-02 : sur iPhone, « Mode édition » et « Vue compacte » sont des interrupteurs du menu « Plus d’options » ; sur PC, des boutons
 * de l'écran. Ces aides commandent l'un ou l'autre selon ce qui est rendu, pour les tests A-05 et A-06 écrits avant la refonte.
 */
export async function toggleViaMenu(name: 'Mode édition' | 'Vue compacte'): Promise<void> {
  const direct = screen.queryByRole('button', { name });
  if (direct) {
    fireEvent.click(direct);
    return;
  }
  fireEvent.click(screen.getByRole('button', { name: 'Plus d’options' }));
  fireEvent.click(await screen.findByRole('menuitemcheckbox', { name }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Plus d’options' })).toBeNull());
}

/** État de l'interrupteur (bouton `aria-pressed` sur PC, entrée `aria-checked` du menu sur iPhone, menu refermé ensuite). */
export async function menuToggleState(name: 'Mode édition' | 'Vue compacte'): Promise<boolean> {
  const direct = screen.queryByRole('button', { name });
  if (direct) return direct.getAttribute('aria-pressed') === 'true';
  fireEvent.click(screen.getByRole('button', { name: 'Plus d’options' }));
  const item = await screen.findByRole('menuitemcheckbox', { name });
  const checked = item.getAttribute('aria-checked') === 'true';
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Plus d’options' })).getByRole('button', { name: 'Fermer' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Plus d’options' })).toBeNull());
  return checked;
}
