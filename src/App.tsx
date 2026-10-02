import { useEffect, useRef, useState } from 'react';
import { TodayScreen } from './features/today/TodayScreen';
import { AppContainerProvider } from './features/app/AppContainerContext';
import { useAppStore } from './features/app/appStore';
import { bootstrapApp } from './features/app/bootstrap';
import type { AppContainer } from './features/app/container';
import { TABS, useNavigationStore, type TabDefinition, type TabId } from './features/app/navigation';
import { toKeyInput } from './features/app/shortcuts';
import { startAppStartup, type AppStartup } from './features/app/startup';
import { SettingsScreen } from './features/settings';
import { DoneTasksScreen, ReportScreen } from './features/tasks';
import { t } from './i18n';
import { AppShell, TabRail } from './ui';
import { useLayout } from './ui/useLayout';

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
  const route = useNavigationStore((s) => s.route);
  const goToTab = useNavigationStore((s) => s.goToTab);

  return (
    <AppShell
      tabRail={
        <TabRail
          items={TAB_ITEMS}
          settingsItem={SETTINGS_ITEM}
          activeId={route.tab}
          onSelect={(id) => goToTab(id as TabId)}
        />
      }
    >
      {route.tab === 'tasks' ? (
        route.screen === 'report' ? <ReportScreen /> : route.screen === 'done' ? <DoneTasksScreen /> : <TodayScreen />
      ) : route.tab === 'settings' ? (
        <SettingsScreen />
      ) : (
        <div className="ct-app__placeholder" aria-hidden="true" />
      )}
    </AppShell>
  );
}

export function App() {
  const layout = useLayout();
  const dbStatus = useAppStore((s) => s.dbStatus);
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

  useEffect(() => {
    if (!container) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (container.shortcuts.handle(toKeyInput(event))) event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [container]);

  return (
    <div className="app-shell" data-layout={layout} data-db-status={dbStatus}>
      {dbStatus === 'loading' && <p role="status">{t('app.loading')}</p>}
      {dbStatus === 'error' && <p role="alert">{t('app.dbError')}</p>}
      {container ? (
        <AppContainerProvider container={container}>
          <AppShellContent />
        </AppContainerProvider>
      ) : (
        dbStatus !== 'error' && <h1>{t('app.name')}</h1>
      )}
    </div>
  );
}
