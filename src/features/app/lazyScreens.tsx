import { createElement, lazy, Suspense, type ComponentType, type ReactElement } from 'react';

/**
 * Écrans chargés à la demande (PERF-02, avenant à l'ADR 0001) : seul Aujourd'hui, l'écran du premier rendu, est dans le bloc de
 * départ. Chaque écran est importé depuis son fichier (jamais depuis le barrel de sa feature) pour que son code reste dans son
 * propre bloc. `preloadScreens` les charge en arrière-plan après le premier rendu, si bien que le repli de Suspense ne s'affiche
 * en pratique qu'à une navigation faite dans les tout premiers instants.
 */
type Loader<P> = () => Promise<{ default: ComponentType<P> }>;

const loaders: Array<() => Promise<unknown>> = [];

/** Repli neutre : la zone vide de l'écran (même fond que la coquille, aucun texte, aucun saut de mise en page). */
function Fallback(): ReactElement {
  return <div className="ct-app__placeholder" aria-hidden="true" />;
}

/** Chaque écran porte sa propre frontière Suspense : un écran voisin déjà affiché (Aujourd'hui à côté d'Un jour) ne se masque pas. */
function screen<P extends object>(load: Loader<P>): ComponentType<P> {
  loaders.push(load);
  const Lazy = lazy(load);
  return function LazyScreen(props: P): ReactElement {
    return <Suspense fallback={<Fallback />}>{createElement(Lazy as unknown as ComponentType<P>, props)}</Suspense>;
  };
}

export const ReportScreen = screen<{ entry?: 'tasks' | 'routines' }>(() => import('../stats/ReportScreen').then((m) => ({ default: m.ReportScreen })));
export const DoneTasksScreen = screen<object>(() => import('../tasks/DoneTasksScreen').then((m) => ({ default: m.DoneTasksScreen })));
export const TrashScreen = screen<object>(() => import('../tasks/TrashScreen').then((m) => ({ default: m.TrashScreen })));
export const TaskDetail = screen<object>(() => import('../tasks/TaskDetail').then((m) => ({ default: m.TaskDetail })));
export const SomedayScreen = screen<object>(() => import('../someday/SomedayScreen').then((m) => ({ default: m.SomedayScreen })));
export const GoalsScreen = screen<object>(() => import('../goals/GoalsScreen').then((m) => ({ default: m.GoalsScreen })));
export const WeekScreen = screen<object>(() => import('../week/WeekScreen').then((m) => ({ default: m.WeekScreen })));
export const RoutinesScreen = screen<object>(() => import('../routines/RoutinesScreen').then((m) => ({ default: m.RoutinesScreen })));
export const EventsScreen = screen<object>(() => import('../events/EventsScreen').then((m) => ({ default: m.EventsScreen })));
export const ChecklistsScreen = screen<object>(() => import('../checklists/ChecklistsScreen').then((m) => ({ default: m.ChecklistsScreen })));
export const SettingsScreen = screen<object>(() => import('../settings/SettingsScreen').then((m) => ({ default: m.SettingsScreen })));
export const AppearanceScreen = screen<object>(() => import('../settings/AppearanceScreen').then((m) => ({ default: m.AppearanceScreen })));
export const TabsScreen = screen<object>(() => import('../settings/TabsScreen').then((m) => ({ default: m.TabsScreen })));
export const ImportScreen = screen<object>(() => import('../settings/ImportScreen').then((m) => ({ default: m.ImportScreen })));
export const RecapSettingsScreen = screen<object>(() => import('../reminders/RecapSettingsScreen').then((m) => ({ default: m.RecapSettingsScreen })));
export const HolidaySettingsScreen = screen<object>(() => import('../events/HolidaySettingsScreen').then((m) => ({ default: m.HolidaySettingsScreen })));
export const SpacesScreen = screen<object>(() => import('../spaces/SpacesScreen').then((m) => ({ default: m.SpacesScreen })));
export const CalendarsScreen = screen<object>(() => import('../calendars/CalendarsScreen').then((m) => ({ default: m.CalendarsScreen })));
export const QuietHoursRoute = screen<object>(() => import('../spaces/QuietHoursRoute').then((m) => ({ default: m.QuietHoursRoute })));

/** Charge tous les écrans à la demande, un par un, aux moments d'inactivité du navigateur (après le premier rendu). Rend l'arrêt. */
export function preloadScreens(): () => void {
  let cancelled = false;
  let handle: number | undefined;
  let index = 0;
  const idle = (cb: () => void): number =>
    typeof window.requestIdleCallback === 'function' ? window.requestIdleCallback(cb, { timeout: 2000 }) : window.setTimeout(cb, 200);
  const cancel = (id: number): void => (typeof window.cancelIdleCallback === 'function' ? window.cancelIdleCallback(id) : window.clearTimeout(id));
  const step = (): void => {
    if (cancelled) return;
    const load = loaders[index];
    index += 1;
    if (!load) return;
    void load().catch(() => undefined);
    handle = idle(step);
  };
  handle = idle(step);
  return () => {
    cancelled = true;
    if (handle !== undefined) cancel(handle);
  };
}
