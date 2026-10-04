/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Défini par la CLI Tauri pendant `tauri dev` / `tauri build` (windows, ios…). */
  readonly TAURI_ENV_PLATFORM?: string;
  /** Développement et Playwright seulement : URL des simulateurs d'agendas (tests/sim) et ID client du simulateur Google. */
  readonly VITE_CT_GOOGLE_SIM?: string;
  readonly VITE_CT_CALDAV_SIM?: string;
  readonly VITE_CT_GOOGLE_SIM_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
