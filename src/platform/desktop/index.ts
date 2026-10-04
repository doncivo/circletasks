import { detectOs, detectRuntime, type OsFamily, type Runtime } from '../runtime';
import type { DesktopPlatform } from './types';

export { logDesktopFailure } from './log';
export { LATEST_RELEASE_URL, RELEASES_REPOSITORY_URL } from './releases';
export {
  GlobalShortcutError,
  UpdateInstallError,
  type DesktopPlatform,
  type GlobalShortcutFailure,
  type GlobalShortcuts,
  type PendingUpdate,
  type TrayLabels,
  type UpdateFailureKind,
  type UpdateProgress,
} from './types';

/**
 * Intégration PC : renvoie l'implémentation Tauri sur Windows installé, `null` ailleurs
 * (navigateur, Playwright, iPhone : aucune ligne « Démarrer avec Windows », aucune mise à jour PC).
 * Import dynamique : les plugins ne sont chargés que dans l'app PC.
 */
export async function openDesktopPlatform(
  runtime: Runtime = detectRuntime(),
  os: OsFamily = detectOs(),
): Promise<DesktopPlatform | null> {
  if (runtime !== 'tauri' || os !== 'windows') return null;
  const { createTauriDesktop } = await import('./tauriDesktop');
  return createTauriDesktop();
}
