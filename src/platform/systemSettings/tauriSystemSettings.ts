import { SystemSettingsError, type SystemSettings } from './index';

/** Commande Rust (src-tauri/src/speech/ios.rs, méthode Swift `openAppSettings` qui résout toujours) : seul fichier qui la nomme. */
export const SETTINGS_OPEN_COMMAND = 'app_settings_open';

export type SettingsInvoker = (command: string) => Promise<unknown>;

export function createTauriSystemSettings(invoke?: SettingsInvoker): SystemSettings {
  const call: SettingsInvoker =
    invoke ??
    (async (command) => {
      const core = await import('@tauri-apps/api/core');
      return core.invoke(command);
    });
  return {
    openApp: async () => {
      try {
        const result = (await call(SETTINGS_OPEN_COMMAND)) as { opened?: unknown };
        if (result.opened !== true) throw new SystemSettingsError('settings-open-failed');
      } catch (error) {
        if (error instanceof SystemSettingsError) throw error;
        throw new SystemSettingsError('settings-open-failed', error);
      }
    },
  };
}
