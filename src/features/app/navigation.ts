import { create } from 'zustand';
import type { HolidayCountry } from '../../domain/model';
import type { ChecklistId, EventId, ExternalEventId, GoalId, LocalDate, RoutineId, SpaceId, TaskId } from '../../domain/types';
import type { PlainMessageKey } from '../../i18n';
import { isTabAvailable } from '../../domain/tabs';
import type { ShortcutId } from './shortcuts';
import { useTabsConfigStore } from './tabsConfig';

/**
 * Coquille et navigation (PRD section 5), ADR 0004.
 *
 * Pas de routeur d'URL (fenêtre unique Tauri, pas de lien profond) : un store
 * Zustand en mémoire décrit l'onglet, l'écran interne, la fiche détail ouverte et
 * les surcouches. La présentation dépend de `useLayout()` :
 * - fiche détail : panneau à droite sur PC, feuille plein écran sur iPhone ;
 * - surcouches : palette / fenêtre centrée sur PC, écran plein sur iPhone.
 */
export const TAB_IDS = ['tasks', 'week', 'routines', 'events', 'checklists', 'settings'] as const;
export type TabId = (typeof TAB_IDS)[number];

export interface TabDefinition {
  readonly id: TabId;
  readonly labelKey: PlainMessageKey;
  /** Variable CSS de la couleur de l'onglet (src/ui/theme/tokens.css). */
  readonly colorVar: string;
  readonly shortcut: ShortcutId;
}

/** Ordre par défaut des onglets verticaux (réordonnables et masquables à l'ordre 3, P-01). */
export const TABS: readonly TabDefinition[] = [
  { id: 'tasks', labelKey: 'nav.tabs.tasks', colorVar: '--ct-color-tab-tasks', shortcut: 'app.tab.tasks' },
  { id: 'week', labelKey: 'nav.tabs.week', colorVar: '--ct-color-tab-week', shortcut: 'app.tab.week' },
  { id: 'routines', labelKey: 'nav.tabs.routines', colorVar: '--ct-color-tab-routines', shortcut: 'app.tab.routines' },
  { id: 'events', labelKey: 'nav.tabs.events', colorVar: '--ct-color-tab-events', shortcut: 'app.tab.events' },
  { id: 'checklists', labelKey: 'nav.tabs.checklists', colorVar: '--ct-color-tab-checklists', shortcut: 'app.tab.checklists' },
  { id: 'settings', labelKey: 'nav.tabs.settings', colorVar: '--ct-color-tab-settings', shortcut: 'app.tab.settings' },
];

/** Écrans internes de chaque onglet. Ajouter un écran = ajouter un membre ici. */
export type Route =
  /**
   * Aujourd'hui (A-01) : `date` absente = jour courant ; une date explicite vient des flèches « Jour précédent /
   * Jour suivant » (PC, Q10). Retour au jour courant : `goToToday()` (onglet « Tâches », Alt+1, A-04).
   */
  | { readonly tab: 'tasks'; readonly screen: 'today'; readonly date?: LocalDate }
  /** Écrans ouverts par les icônes du haut : Un jour, Objectif, Rapport mensuel (lien vers terminées, T-07), terminées. La corbeille s'ouvre depuis Réglages (T-08, Q6). */
  | { readonly tab: 'tasks'; readonly screen: 'someday' | 'goals' | 'report' | 'done' }
  /** `weekStart` null = semaine courante ; `somedayPanel` : panneau « Un jour » PC (S-06). */
  | { readonly tab: 'week'; readonly weekStart: LocalDate | null; readonly somedayPanel: boolean }
  | { readonly tab: 'routines'; readonly screen: 'list' | 'report' }
  | { readonly tab: 'events' }
  | { readonly tab: 'checklists'; readonly checklistId: ChecklistId | null }
  | { readonly tab: 'settings'; readonly screen: 'home' | 'spaces' | 'calendars' | 'reminders' | 'holidays' | 'general' | 'desktop' | 'about' | 'trash' | 'appearance' | 'tabs' | 'import' }
  /** Plages silencieuses d'un espace (ES-07), ouvertes depuis la ligne « Silence Pro » de Réglages › RAPPELS. */
  | { readonly tab: 'settings'; readonly screen: 'quiet'; readonly spaceId: SpaceId };

export const DEFAULT_ROUTES: { readonly [K in TabId]: Extract<Route, { tab: K }> } = {
  tasks: { tab: 'tasks', screen: 'today' },
  week: { tab: 'week', weekStart: null, somedayPanel: false },
  routines: { tab: 'routines', screen: 'list' },
  events: { tab: 'events' },
  checklists: { tab: 'checklists', checklistId: null },
  settings: { tab: 'settings', screen: 'home' },
};

/** Élément affiché dans la fiche détail (A-08) : même fiche depuis toutes les listes. */
export type DetailTarget =
  | { readonly type: 'task'; readonly id: TaskId }
  | { readonly type: 'routine'; readonly id: RoutineId }
  | { readonly type: 'goal'; readonly id: GoalId }
  | { readonly type: 'event'; readonly id: EventId }
  /** Événement d'un agenda externe (S-05) : fiche en lecture seule. */
  | { readonly type: 'externalEvent'; readonly id: ExternalEventId }
  /** Jour férié (E-03) : fiche en lecture seule, date modifiable à la main pour une fête religieuse tunisienne. */
  | { readonly type: 'holiday'; readonly country: HolidayCountry; readonly key: string; readonly year: number }
  | { readonly type: 'checklist'; readonly id: ChecklistId };

/**
 * Surcouches modales, empilées. `taskEditor` : fenêtre d'ajout (T-01 à T-03) ;
 * `search` (ordre 2), `shortcutsHelp` (P-08), `quickCapture` (ordre 3).
 */
export type Overlay =
  | { readonly kind: 'taskEditor'; readonly date: LocalDate | null; readonly someday: boolean }
  | { readonly kind: 'search' }
  | { readonly kind: 'shortcutsHelp' }
  | { readonly kind: 'quickCapture' };

export interface NavigationState {
  readonly route: Route;
  /** Dernière route visitée par onglet : revenir sur un onglet restaure son écran. */
  readonly lastRoutes: { readonly [K in TabId]: Extract<Route, { tab: K }> };
  readonly detail: DetailTarget | null;
  readonly overlays: readonly Overlay[];
  /**
   * A-04, Alt+1…6 : va sur l'onglet, à son dernier écran ; ferme la fiche détail. L'onglet « Tâches » fait
   * exception : il ramène toujours à Aujourd'hui du jour courant (`goToToday`), même depuis un sous-écran.
   */
  goToTab(tab: TabId): void;
  /** A-04 : Aujourd'hui du jour courant (réinitialise la date affichée et le dernier écran de l'onglet Tâches) ; ferme la fiche. */
  goToToday(): void;
  navigate(route: Route): void;
  openDetail(target: DetailTarget): void;
  closeDetail(): void;
  openOverlay(overlay: Overlay): void;
  closeOverlay(): void;
  /** Échap : ferme la surcouche du dessus, sinon la fiche détail ; false si rien à fermer. */
  escape(): boolean;
}

type NavigationData = Pick<NavigationState, 'route' | 'lastRoutes' | 'detail' | 'overlays'>;

export const INITIAL_NAVIGATION: NavigationData = {
  route: DEFAULT_ROUTES.tasks,
  lastRoutes: DEFAULT_ROUTES,
  detail: null,
  overlays: [],
};

/** État d'interface pur, sans dépendance : store de module (réinitialiser avec INITIAL_NAVIGATION en test). */
export const useNavigationStore = create<NavigationState>()((set, get) => ({
  ...INITIAL_NAVIGATION,
  goToTab: (tab) => {
    // P-01 critère 6 : un onglet masqué ne répond plus à son raccourci (il reste atteignable par un lien, via `navigate`).
    if (!isTabAvailable(useTabsConfigStore.getState().config, TAB_IDS, tab, get().route.tab)) return;
    if (tab === 'tasks') get().goToToday();
    else set((s) => ({ route: s.lastRoutes[tab], detail: null }));
  },
  goToToday: () => set((s) => ({ route: DEFAULT_ROUTES.tasks, lastRoutes: { ...s.lastRoutes, tasks: DEFAULT_ROUTES.tasks }, detail: null })),
  navigate: (route) =>
    set((s) => ({ route, lastRoutes: { ...s.lastRoutes, [route.tab]: route }, detail: route.tab === s.route.tab ? s.detail : null })),
  openDetail: (detail) => set({ detail }),
  closeDetail: () => set({ detail: null }),
  openOverlay: (overlay) => set((s) => ({ overlays: [...s.overlays, overlay] })),
  closeOverlay: () => set((s) => ({ overlays: s.overlays.slice(0, -1) })),
  escape: () => {
    const { overlays, detail } = get();
    if (overlays.length > 0) {
      set({ overlays: overlays.slice(0, -1) });
      return true;
    }
    if (detail) {
      set({ detail: null });
      return true;
    }
    return false;
  },
}));
