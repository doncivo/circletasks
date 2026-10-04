import { setFormatPrefs } from '../../i18n/formatPrefs';
import type { AppContainer } from '../app/container';
import { createSettingsUseCases } from './settingsUseCases';

/**
 * M12 apparence : lit les préférences d'affichage (premier jour, format d'heure) AVANT le premier rendu et les applique au module
 * `formatPrefs`. Une lecture qui échoue laisse les défauts (lundi, 24 h) : l'app reste utilisable.
 */
export async function restoreAppearance(container: Pick<AppContainer, 'data'>): Promise<void> {
  try {
    const formats = await createSettingsUseCases(container).loadFormats();
    setFormatPrefs({ firstWeekday: formats.firstWeekday, timeFormat: formats.timeFormat });
  } catch {
    // Défauts conservés.
  }
}
