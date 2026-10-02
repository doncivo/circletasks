import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart';
import { openUrl } from '@tauri-apps/plugin-opener';
import { relaunch } from '@tauri-apps/plugin-process';
import { check } from '@tauri-apps/plugin-updater';
import { CONFIRM_QUIT_COMMAND, LATEST_RELEASE_URL, QUICK_ADD_EVENT, QUITTING_EVENT, SET_TRAY_LABELS_COMMAND } from './releases';
import { UpdateInstallError, type DesktopPlatform, type PendingUpdate, type UpdateFailureKind } from './types';

/**
 * Classe une erreur du plugin updater. Les erreurs de signature viennent de minisign
 * (« Signature verification failed », « Invalid encoding… ») ou du contrôle de la version
 * signée (« signed version »).
 */
export function classifyUpdateError(error: unknown): UpdateFailureKind {
  const text = error instanceof Error ? error.message : String(error);
  return /signature|minisign|signed version|public key|base64/i.test(text) ? 'signature' : 'other';
}

/** Implémentation Tauri (Windows). Ne s'importe que via `openDesktopPlatform`. */
export function createTauriDesktop(): DesktopPlatform {
  return {
    setTrayLabels: async (labels) => {
      await invoke(SET_TRAY_LABELS_COMMAND, { labels });
    },

    onQuickAdd: async (handler) => listen(QUICK_ADD_EVENT, () => handler()),

    onQuitting: async (handler) =>
      listen(QUITTING_EVENT, () => {
        void handler()
          .catch(() => undefined)
          .finally(() => invoke(CONFIRM_QUIT_COMMAND).catch(() => undefined));
      }),

    getAutostart: () => isEnabled(),

    setAutostart: async (enabled) => {
      if (enabled) await enable();
      else await disable();
    },

    getVersion: () => getVersion(),

    checkForUpdate: async () => {
      const update = await check();
      if (!update) return null;
      const pending: PendingUpdate = {
        version: update.version,
        notes: update.body?.trim() ? update.body : null,
        install: async (onProgress) => {
          let downloadedBytes = 0;
          let totalBytes: number | null = null;
          try {
            await update.downloadAndInstall((event) => {
              if (event.event === 'Started') totalBytes = event.data.contentLength ?? null;
              else if (event.event === 'Progress') downloadedBytes += event.data.chunkLength;
              onProgress({ downloadedBytes, totalBytes });
            });
          } catch (error) {
            throw new UpdateInstallError(classifyUpdateError(error), error);
          }
          await relaunch();
        },
        dispose: async () => {
          try {
            await update.close();
          } catch {
            // Ressource déjà libérée : sans conséquence.
          }
        },
      };
      return pending;
    },

    openLatestRelease: () => openUrl(LATEST_RELEASE_URL),
  };
}
