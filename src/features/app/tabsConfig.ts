import { create } from 'zustand';
import { DEFAULT_TABS_CONFIG, type TabsConfig } from '../../domain/tabs';

/**
 * Disposition des onglets de cet appareil (P-01, réglage local `ui.tabs`), lue avant le premier rendu puis tenue à jour par l'écran
 * « Onglets ». État d'interface pur, sans dépendance (comme `useNavigationStore`) : la colonne d'onglets et `goToTab` le lisent.
 */
interface TabsConfigState {
  readonly config: TabsConfig;
  setConfig(config: TabsConfig): void;
}

export const useTabsConfigStore = create<TabsConfigState>()((set) => ({
  config: DEFAULT_TABS_CONFIG,
  setConfig: (config) => set({ config }),
}));
