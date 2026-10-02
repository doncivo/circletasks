import { t } from '../../i18n';
import { logDesktopFailure, type TrayLabels } from '../../platform';
import { startUpdateChecks } from '../updater/updateChecks';
import type { AppContainer } from './container';
import { useQuickAddStore } from './quickAdd';

/** Textes du menu de la zone de notification (D-01) : seule source, src/i18n. */
export function trayLabels(): TrayLabels {
  return {
    open: t('desktop.tray.open'),
    quickAdd: t('desktop.tray.quickAdd'),
    sync: t('desktop.tray.sync'),
    quit: t('desktop.tray.quit'),
    // « Synchroniser » reste grisé tant que M15 n'existe pas (Y-03, ordre 4) : à passer à vrai avec Y-03.
    syncEnabled: false,
  };
}

export interface DesktopIntegration {
  /** Retire les écouteurs et minuteries ; sûr avant la fin de l'initialisation et idempotent. */
  dispose(): void;
}

/**
 * Branche l'app PC sur le système (D-01, D-03) : menu de la zone de notification avec les
 * textes de l'interface, entrée « Ajout rapide », vérifications de mise à jour. Sans
 * intégration PC (navigateur, iPhone), ne fait rien. Aucune erreur ne remonte : l'échec
 * d'un branchement est journalisé et l'app reste utilisable.
 */
export function startDesktopIntegration(container: AppContainer): DesktopIntegration {
  const desktop = container.desktop;
  if (!desktop) return { dispose: () => undefined };

  let disposed = false;
  let unlisten: (() => void) | null = null;
  let unlistenQuit: (() => void) | null = null;

  desktop.setTrayLabels(trayLabels()).catch((error: unknown) => logDesktopFailure('tray-labels', error));
  desktop
    .onQuickAdd(() => useQuickAddStore.getState().request())
    .then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    })
    .catch((error: unknown) => logDesktopFailure('quick-add', error));
  // « Quitter » : on laisse les écritures en cours se terminer. Le pilote SQL sérialise ses appels :
  // une lecture ne rend la main qu'après les écritures déjà en file.
  desktop
    .onQuitting(async () => {
      await container.data.repos.settings.get('device.id');
    })
    .then((stop) => {
      if (disposed) stop();
      else unlistenQuit = stop;
    })
    .catch((error: unknown) => logDesktopFailure('quitting', error));
  const checks = startUpdateChecks(container);

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unlisten?.();
      unlistenQuit?.();
      checks.dispose();
    },
  };
}
