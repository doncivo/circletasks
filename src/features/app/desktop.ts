import { t } from '../../i18n';
import { logDesktopFailure, type TrayLabels } from '../../platform';
import { quickCaptureStore } from '../shortcuts';
import { startUpdateChecks } from '../updater/updateChecks';
import type { AppContainer } from './container';
import { useQuickAddStore } from './quickAdd';
import { formatChord } from './shortcutsHelp';

/** Textes du menu de la zone de notification (D-01) : seule source, src/i18n. */
export function trayLabels(quickCaptureKeys: string | null = null): TrayLabels {
  return {
    open: t('desktop.tray.open'),
    // D-04 : la combinaison de la capture rapide s'affiche à droite de l'entrée (tabulation = colonne des raccourcis du menu Windows).
    quickAdd: quickCaptureKeys ? `${t('desktop.tray.quickAdd')}\t${formatChord(quickCaptureKeys)}` : t('desktop.tray.quickAdd'),
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

  // D-04 : menu de la zone de notification (avec la combinaison de la capture rapide quand elle est active), puis
  // enregistrement du raccourci global ; le menu est réécrit à chaque changement de combinaison ou d'état.
  const quickCapture = quickCaptureStore.get(container);
  const pushLabels = (): void => {
    const { keys, status } = quickCapture.getState();
    desktop.setTrayLabels(trayLabels(status === 'active' ? keys : null)).catch((error: unknown) => logDesktopFailure('tray-labels', error));
  };
  pushLabels();
  const stopQuickCapture = quickCapture.subscribe((state, previous) => {
    if (state.keys !== previous.keys || state.status !== previous.status) pushLabels();
  });
  void quickCapture.getState().init();
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
      // Y-02 : dernier cycle de synchro avant de quitter, 4,5 s au plus (puis sortie quoi qu'il arrive).
      if (container.sync) await Promise.race([container.sync.syncNow('quit'), new Promise((resolve) => setTimeout(resolve, 4_500))]);
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
      stopQuickCapture();
      checks.dispose();
    },
  };
}
