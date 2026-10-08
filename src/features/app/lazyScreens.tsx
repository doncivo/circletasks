import { Component, createElement, lazy, Suspense, useState, type ComponentType, type ErrorInfo, type ReactElement, type ReactNode } from 'react';
import { t } from '../../i18n';
import { logFailure } from '../../platform';
import { Button } from '../../ui';
import { whenIdle } from './idle';
import { SCREEN_LOADED_PREFIX, type ScreenName } from './screenNames';
import './lazyScreens.css';

/**
 * Écrans chargés à la demande (PERF-02, avenant à l'ADR 0001) : seul Aujourd'hui, l'écran du premier rendu, est dans le bloc de
 * départ. Chaque écran est importé depuis son fichier (jamais depuis le barrel de sa feature) pour que son code reste dans son
 * propre bloc. `preloadScreens` les charge en arrière-plan après le premier rendu, si bien que le repli de Suspense ne s'affiche
 * en pratique qu'à une navigation faite dans les tout premiers instants.
 */
type Loader<P> = () => Promise<{ default: ComponentType<P> }>;

export { SCREEN_LOADED_PREFIX, type ScreenName };

const loaders: Array<() => Promise<unknown>> = [];


function markLoaded(name: ScreenName | undefined): void {
  if (name !== undefined) document.documentElement.setAttribute(SCREEN_LOADED_PREFIX + name, 'true');
}

/** Repli neutre : la zone vide de l'écran (même fond que la coquille, aucun texte, aucun saut de mise en page). */
function Fallback(): ReactElement {
  return <div className="ct-app__placeholder" aria-hidden="true" />;
}

/**
 * Frontière d'erreur d'un écran : bloc illisible -> message et « Réessayer » (le parent recrée le composant paresseux). Après un
 * nouvel échec, « Recharger » relance la page : sur WebKit, un second `import()` du même fichier peut renvoyer le même rejet.
 */
class ScreenErrorBoundary extends Component<{ readonly onRetry: () => void; readonly reload: boolean; readonly children: ReactNode }, { readonly failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error, _info: ErrorInfo): void {
    logFailure('screen-load', error);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="ct-app__screen-error" role="alert">
        <p>{t('app.screenError')}</p>
        <Button variant="secondary" onClick={this.props.reload ? () => window.location.reload() : this.props.onRetry}>
          {this.props.reload ? t('app.screenReload') : t('app.screenRetry')}
        </Button>
      </div>
    );
  }
}

/**
 * Chaque écran porte sa propre frontière Suspense et d'erreur : un écran voisin déjà affiché (Aujourd'hui à côté d'Un jour) ne se
 * masque pas. Module déjà arrivé (préchargement ou affichage précédent) : rendu direct à la création de l'instance, sans repli ni
 * Suspense ; le choix est fixé pour la vie de l'instance (pas de remontage, donc pas de perte d'état). Le composant paresseux est
 * propre à chaque instance : un « Réessayer » n'en touche aucune autre.
 */
export function lazyScreen<P extends object>(load: Loader<P>, name?: ScreenName): ComponentType<P> {
  let loaded: ComponentType<P> | null = null;
  const remember = (): Promise<{ default: ComponentType<P> }> =>
    loaded
      ? Promise.resolve({ default: loaded })
      : load()
          .then((module) => {
            loaded = module.default;
            return module;
          })
          .finally(() => markLoaded(name));
  loaders.push(remember);
  return function LazyScreen(props: P): ReactElement {
    const [direct] = useState(() => loaded);
    const [Lazy, setLazy] = useState(() => lazy<ComponentType<P>>(remember));
    const [attempt, setAttempt] = useState(0);
    const body = direct ? createElement(direct, props) : <Suspense fallback={<Fallback />}>{createElement(Lazy as unknown as ComponentType<P>, props)}</Suspense>;
    return (
      <ScreenErrorBoundary
        key={attempt}
        reload={attempt >= 1}
        onRetry={() => {
          if (!loaded) setLazy(() => lazy<ComponentType<P>>(remember));
          setAttempt((n) => n + 1);
        }}
      >
        {body}
      </ScreenErrorBoundary>
    );
  };
}

export const ReportScreen = lazyScreen<{ entry?: 'tasks' | 'routines' }>(() => import('../stats/ReportScreen').then((m) => ({ default: m.ReportScreen })), 'reportscreen');
export const DoneTasksScreen = lazyScreen<object>(() => import('../tasks/DoneTasksScreen').then((m) => ({ default: m.DoneTasksScreen })), 'donetasksscreen');
export const TrashScreen = lazyScreen<object>(() => import('../tasks/TrashScreen').then((m) => ({ default: m.TrashScreen })), 'trashscreen');
export const TaskDetail = lazyScreen<object>(() => import('../tasks/TaskDetail').then((m) => ({ default: m.TaskDetail })), 'taskdetail');
export const SomedayScreen = lazyScreen<object>(() => import('../someday/SomedayScreen').then((m) => ({ default: m.SomedayScreen })), 'somedayscreen');
export const GoalsScreen = lazyScreen<object>(() => import('../goals/GoalsScreen').then((m) => ({ default: m.GoalsScreen })), 'goalsscreen');
export const WeekScreen = lazyScreen<object>(() => import('../week/WeekScreen').then((m) => ({ default: m.WeekScreen })), 'weekscreen');
export const RoutinesScreen = lazyScreen<object>(() => import('../routines/RoutinesScreen').then((m) => ({ default: m.RoutinesScreen })), 'routinesscreen');
export const EventsScreen = lazyScreen<object>(() => import('../events/EventsScreen').then((m) => ({ default: m.EventsScreen })), 'eventsscreen');
export const ChecklistsScreen = lazyScreen<object>(() => import('../checklists/ChecklistsScreen').then((m) => ({ default: m.ChecklistsScreen })), 'checklistsscreen');
export const SettingsScreen = lazyScreen<object>(() => import('../settings/SettingsScreen').then((m) => ({ default: m.SettingsScreen })), 'settingsscreen');
export const AppearanceScreen = lazyScreen<object>(() => import('../settings/AppearanceScreen').then((m) => ({ default: m.AppearanceScreen })), 'appearancescreen');
export const TabsScreen = lazyScreen<object>(() => import('../settings/TabsScreen').then((m) => ({ default: m.TabsScreen })), 'tabsscreen');
export const ImportScreen = lazyScreen<object>(() => import('../settings/ImportScreen').then((m) => ({ default: m.ImportScreen })), 'importscreen');
export const RecapSettingsScreen = lazyScreen<object>(() => import('../reminders/RecapSettingsScreen').then((m) => ({ default: m.RecapSettingsScreen })), 'recapsettingsscreen');
export const HolidaySettingsScreen = lazyScreen<object>(() => import('../events/HolidaySettingsScreen').then((m) => ({ default: m.HolidaySettingsScreen })), 'holidaysettingsscreen');
export const SpacesScreen = lazyScreen<object>(() => import('../spaces/SpacesScreen').then((m) => ({ default: m.SpacesScreen })), 'spacesscreen');
export const CalendarsScreen = lazyScreen<object>(() => import('../calendars/CalendarsScreen').then((m) => ({ default: m.CalendarsScreen })), 'calendarsscreen');
export const SyncDetailsScreen = lazyScreen<object>(() => import('../sync/SyncDetailsScreen').then((m) => ({ default: m.SyncDetailsScreen })), 'syncdetailsscreen');
export const QuietHoursRoute = lazyScreen<object>(() => import('../spaces/QuietHoursRoute').then((m) => ({ default: m.QuietHoursRoute })), 'quiethoursroute');

/** Charge tous les écrans à la demande, un par un, aux moments d'inactivité (repli 200 ms sur iPhone). Rend l'arrêt. */
export function preloadScreens(): () => void {
  let cancel: () => void = () => undefined;
  let index = 0;
  const step = (): void => {
    const load = loaders[index];
    index += 1;
    if (!load) return;
    void load().catch((error: unknown) => logFailure('screen-preload', error));
    cancel = whenIdle(step, 200);
  };
  cancel = whenIdle(step, 200);
  return () => cancel();
}
