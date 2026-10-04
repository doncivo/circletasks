import { setFormatPrefs } from '../../i18n/formatPrefs';
import type { AppContainer } from '../app/container';
import { createSettingsUseCases } from './settingsUseCases';
import { applyTheme, applyWindowTheme, openWindowThemePort, setWindowThemePort } from './theme';

/**
 * M12 apparence : lit les préférences d'affichage (thème de l'appareil, premier jour, format d'heure) AVANT le premier rendu et les
 * applique. Une lecture qui échoue laisse les défauts (système, lundi, 24 h) : l'app reste utilisable.
 */
export async function restoreAppearance(container: Pick<AppContainer, 'data'>): Promise<void> {
  const useCases = createSettingsUseCases(container);
  try {
    const formats = await useCases.loadFormats();
    setFormatPrefs({ firstWeekday: formats.firstWeekday, timeFormat: formats.timeFormat });
  } catch {
    // Défauts conservés.
  }
  try {
    applyTheme(await useCases.loadTheme());
  } catch {
    // Thème système conservé (le script de premier affichage a déjà posé le miroir local, s'il existe).
  }
}

/**
 * P-02 critère 6 : aligne la barre de titre sur le thème choisi (« Système » : la fenêtre suit Windows, y compris quand il change
 * pendant que l'app tourne ; l'interface le suit par `prefers-color-scheme`). Sans effet hors fenêtre Tauri. Renvoie la fonction d'arrêt.
 */
export function startThemeSync(container: Pick<AppContainer, 'data'>): () => void {
  let stopped = false;
  void (async () => {
    const port = await openWindowThemePort();
    if (stopped || !port) return;
    setWindowThemePort(port);
    const choice = await createSettingsUseCases(container).loadTheme().catch(() => 'system' as const);
    await applyWindowTheme(choice, port);
  })();
  return () => {
    stopped = true;
    setWindowThemePort(null);
  };
}
