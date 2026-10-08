import { logFailure } from '../../platform';
import { getSystemSettings, SystemSettingsError } from '../../platform/systemSettings';
import { withExcursion } from './excursion';

/** Une action « Ouvrir les réglages » est possible seulement si l'ouvreur existe (iPhone). */
export function canOpenAppSettings(): boolean {
  return getSystemSettings() !== null;
}

/**
 * « Ouvrir les réglages » (excursion `system-settings` : aucun reverrouillage au retour). Rend `null` si c'est ouvert, sinon le code de
 * l'échec, déjà journalisé : l'appelant le dit à l'utilisateur (jamais un bouton muet).
 */
export async function openAppSettingsAction(): Promise<string | null> {
  const settings = getSystemSettings();
  if (!settings) return 'settings-unavailable';
  try {
    await withExcursion('system-settings', () => settings.openApp());
    return null;
  } catch (error) {
    const code = error instanceof SystemSettingsError ? error.code : 'settings-open-failed';
    logFailure('capture', code);
    return code;
  }
}
