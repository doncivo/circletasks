import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { TodayScreen } from './features/today/TodayScreen';
import { AppContainerProvider, useAppContainer } from './features/app/AppContainerContext';
import { useAppStore } from './features/app/appStore';
import { UndoToast } from './features/app/UndoToast';
import { bootstrapApp } from './features/app/bootstrap';
import type { AppContainer } from './features/app/container';
import { TABS, useNavigationStore, type TabDefinition, type TabId } from './features/app/navigation';
import { startDesktopIntegration } from './features/app/desktop';
import { toKeyInput, type ShortcutId } from './features/app/shortcuts';
import { startAppStartup, type AppStartup } from './features/app/startup';
import { registerTabShortcuts } from './features/app/tabShortcuts';
import { AppStatusBanner } from './features/app/AppStatusBanner';
import { startNetworkStatus } from './features/app/appStatus';
import { CalendarsScreen, registerExternalEventsSource } from './features/calendars';
import { ChecklistsScreen, registerChecklistsSource } from './features/checklists';
import { EventEditorHost, EventsScreen, HolidayDetailHost, HolidaySettingsScreen, registerEventsSource } from './features/events';
import { GoalsScreen, registerGoalsSource } from './features/goals';
import { registerRoutinesSource, RoutinesMonthReport, RoutinesScreen } from './features/routines';
import { SearchOverlay, registerSearchShortcut } from './features/search';
import { ShortcutsHelp, registerEscapeFallback, registerShellShortcuts } from './features/shortcuts';
import { SettingsScreen } from './features/settings';
import { RecapSettingsScreen } from './features/reminders';
import { SomedayScreen } from './features/someday';
import { persistSpaceFilter, QuietHoursRoute, registerSpaceShortcuts, restoreSpaceFilter, SpacesScreen } from './features/spaces';
import { DoneTasksScreen, ReportScreen, TaskDetail, TrashScreen } from './features/tasks';
import { UpdateBanner } from './features/updater';
import { WeekScreen } from './features/week';
import { t } from './i18n';
import { AppShell, TabRail } from './ui';
import { useLayout } from './ui/useLayout';

// Routines (M4) : branchées sur Aujourd'hui et la Semaine avant le premier rendu des écrans (todaySources).
registerRoutinesSource();
// Checklists (M6) : datées, elles apparaissent dans Aujourd'hui et la Semaine (C-03).
registerChecklistsSource();
// Événements locaux (M7) : bandeaux d'Aujourd'hui et éléments de la Semaine (E-01).
registerEventsSource();
// Agendas externes (M8) : bandeaux d'Aujourd'hui, lus par la Semaine par son propre store (K-03).
registerExternalEventsSource();
// Objectifs de la semaine (M17) : encadrés épinglés d'Aujourd'hui (OB-02).
registerGoalsSource();

/** Raccourcis encore actifs pendant que la liste des raccourcis est ouverte (P-08). */
const HELP_KEYS: readonly ShortcutId[] = ['app.shortcutsHelp', 'app.escape'];

const TAB_ITEMS = TABS.filter((tab) => tab.id !== 'settings');

function requireTab(id: TabId): TabDefinition {
  const found = TABS.find((tab) => tab.id === id);
  if (!found) throw new Error(`Onglet manquant dans TABS : ${id}`);
  return found;
}

const SETTINGS_ITEM = requireTab('settings');

/**
 * Coquille réelle de l'app (T-01) : onglets verticaux + écran Aujourd'hui minimal.
 * Les autres onglets restent neutres tant que leur story n'est pas livrée
 * (aucun écran inventé) ; `route.tab` reste la seule source de vérité.
 */
function AppShellContent() {
  const container = useAppContainer();
  const route = useNavigationStore((s) => s.route);
  const goToTab = useNavigationStore((s) => s.goToTab);
  const layout = useLayout();

  // A-09 : état du réseau (« Hors ligne »).
  useEffect(() => startNetworkStatus(), []);

  // ES-03 : Ctrl+1 / Ctrl+2 / Ctrl+3 (Pro / Perso / Tout) et mémorisation du filtre de cet appareil.
  useEffect(() => registerSpaceShortcuts(container.shortcuts), [container]);
  useEffect(() => persistSpaceFilter(container), [container]);

  // A-04 : Alt+1 à Alt+6 (registre de raccourcis, actifs même dans un champ de saisie).
  useEffect(() => registerTabShortcuts(container.shortcuts), [container]);

  // RC-01 : Ctrl+K ouvre la recherche depuis n'importe quel écran, y compris dans un champ de saisie.
  useEffect(() => registerSearchShortcut(container), [container]);

  // D-04 : Échap (dernier recours, priorité la plus basse : posé avant les effets des écrans), Ctrl+, (Réglages).
  // P-08 : Ctrl+/ (liste des raccourcis), PC seulement : l'iPhone n'a pas de clavier.
  useLayoutEffect(() => registerEscapeFallback(container), [container]);
  useEffect(() => registerShellShortcuts(container, { help: layout === 'pc' }), [container, layout]);

  return (
    <AppShell
      // Semaine : la fiche détail passe par-dessus la grille (S-01), qui garde ses sept colonnes.
      detailOverlay={route.tab === 'week'}
      tabRail={
        <TabRail
          items={TAB_ITEMS}
          settingsItem={SETTINGS_ITEM}
          activeId={route.tab}
          onSelect={(id) => goToTab(id as TabId)}
        />
      }
    >
      <AppStatusBanner />
      <UpdateBanner />
      <EventEditorHost />
      <HolidayDetailHost />
      <SearchOverlay />
      {layout === 'pc' && <ShortcutsHelp />}
      {/* RC-03 : une tâche ouverte depuis la recherche passe par-dessus l'onglet courant. Aujourd'hui, la Semaine, Un jour, Terminées et
          Objectif rendent leur propre fiche ; les autres écrans (Routines, Événements, Checklists, Réglages, Rapport) en reçoivent une ici. */}
      {(route.tab === 'routines' || route.tab === 'events' || route.tab === 'checklists' || route.tab === 'settings' || (route.tab === 'tasks' && route.screen === 'report')) && <TaskDetail />}
      {route.tab === 'tasks' ? (
        route.screen === 'report' ? (
          <ReportScreen />
        ) : route.screen === 'done' ? (
          <DoneTasksScreen />
        ) : route.screen === 'someday' ? (
          // Un jour (SD-01) : écran plein sur iPhone, panneau à droite d'Aujourd'hui sur PC.
          layout === 'pc' ? (
            <>
              <TodayScreen />
              <SomedayScreen />
            </>
          ) : (
            <SomedayScreen />
          )
        ) : route.screen === 'goals' ? (
          // Objectif (OB-01) : écran plein sur iPhone, panneau à droite d'Aujourd'hui sur PC.
          layout === 'pc' ? (
            <>
              <TodayScreen />
              <GoalsScreen />
            </>
          ) : (
            <GoalsScreen />
          )
        ) : (
          <TodayScreen />
        )
      ) : route.tab === 'week' ? (
        <WeekScreen />
      ) : route.tab === 'routines' ? (
        route.screen === 'report' ? <RoutinesMonthReport /> : <RoutinesScreen />
      ) : route.tab === 'events' ? (
        <EventsScreen />
      ) : route.tab === 'checklists' ? (
        <ChecklistsScreen />
      ) : route.tab === 'settings' ? (
        route.screen === 'trash' ? <TrashScreen /> : route.screen === 'reminders' ? <RecapSettingsScreen /> : route.screen === 'holidays' ? <HolidaySettingsScreen /> : route.screen === 'spaces' ? <SpacesScreen /> : route.screen === 'calendars' ? <CalendarsScreen /> : route.screen === 'quiet' ? <QuietHoursRoute /> : <SettingsScreen />
      ) : (
        <div className="ct-app__placeholder" aria-hidden="true" />
      )}
    </AppShell>
  );
}

export function App() {
  const layout = useLayout();
  const dbStatus = useAppStore((s) => s.dbStatus);
  const dbBackupFailed = useAppStore((s) => s.dbBackupFailed);
  const [container, setContainer] = useState<AppContainer | null>(null);
  const mounted = useRef(true);
  const startup = useRef<AppStartup | null>(null);

  useEffect(() => {
    if (useAppStore.getState().dbStatus === 'idle') {
      void bootstrapApp().then(async (created) => {
        if (!created) return;
        // Espaces (ES-01) chargés une fois ici, avant le premier rendu des écrans :
        // les features les lisent dans `useAppStore`, jamais via `src/db/seed`.
        try {
          useAppStore.getState().setSpaces(await created.data.repos.spaces.listAll());
        } catch {
          useAppStore.getState().setSpaces([]);
        }
        // Projets (ES-04) : liste « Projet », menu « Projet : tous », fiche détail.
        try {
          useAppStore.getState().setProjects(await created.data.repos.projects.listForFilter('all', { includeArchived: true }));
        } catch {
          useAppStore.getState().setProjects([]);
        }
        // Filtre Pro / Perso / Tout (ES-03) : dernier choix de cet appareil, restauré avant le premier rendu.
        await restoreSpaceFilter(created);
        // Report automatique (T-06) : premier contrôle AVANT le premier rendu d'Aujourd'hui ;
        // démarrage nettoyé si l'app est démontée avant la fin (startup.ts).
        const started = startAppStartup(created);
        startup.current = started;
        await started.ready;
        if (!mounted.current) {
          started.dispose();
          return;
        }
        setContainer(created);
      });
    }
  }, []);

  // Démontage : arrête minuterie et écouteurs du démarrage (StrictMode : le drapeau est réarmé au remontage).
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      startup.current?.dispose();
      startup.current = null;
    };
  }, []);

  // PC : zone de notification, « Ajout rapide », vérifications de mise à jour (D-01, D-03).
  useEffect(() => {
    if (!container) return undefined;
    return startDesktopIntegration(container).dispose;
  }, [container]);

  useEffect(() => {
    if (!container) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      // Sous la liste des raccourcis (fenêtre modale), seuls Ctrl+/ et Échap agissent : Espace, Entrée ou Suppr ne touchent pas l'écran dessous.
      const underHelp = useNavigationStore.getState().overlays.at(-1)?.kind === 'shortcutsHelp';
      if (container.shortcuts.handle(toKeyInput(event), underHelp ? HELP_KEYS : undefined)) event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [container]);

  return (
    <div className="app-shell" data-layout={layout} data-db-status={dbStatus}>
      {dbStatus === 'loading' && <p role="status">{t('app.loading')}</p>}
      {dbStatus === 'error' && <p role="alert">{t(dbBackupFailed ? 'app.dbBackupError' : 'app.dbError')}</p>}
      {container ? (
        <AppContainerProvider container={container}>
          <AppShellContent />
          {/* Bandeau « Annuler » et Ctrl+Z globaux (T-13) : au-dessus de tous les écrans. */}
          <UndoToast />
        </AppContainerProvider>
      ) : (
        dbStatus !== 'error' && <h1>{t('app.name')}</h1>
      )}
    </div>
  );
}
