/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Défini par la CLI Tauri pendant `tauri dev` / `tauri build` (windows, ios…). */
  readonly TAURI_ENV_PLATFORM?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
