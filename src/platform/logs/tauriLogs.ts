import type { LogEntry, LogTransport } from './types';

/**
 * Transport réel du journal (I-04, ADR 0014 §2) : **seul fichier** à nommer `log_append`, `log_read` et `log_clear` (contrôle statique,
 * critère 9). Capabilities `logs.json` (PC) et `logs-ios.json` (iPhone), fenêtre `main` seulement.
 */
export function createTauriLogTransport(): LogTransport {
  return {
    async append(entries: readonly LogEntry[]) {
      const { invoke } = await import('@tauri-apps/api/core');
      const result = await invoke<{ written: number; writeError: string | null }>('log_append', { entries });
      return { writeError: result.writeError };
    },
    async read(max: number) {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<{ entries: LogEntry[]; writeError: string | null }>('log_read', { max });
    },
    async clear() {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('log_clear');
    },
  };
}
