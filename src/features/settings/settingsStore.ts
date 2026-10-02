import { createStore } from 'zustand';
import type { PlainMessageKey } from '../../i18n';
import { defineFeatureStore, type AppContainer } from '../app/container';

export type SettingsStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Réglages affichés par l'écran minimal livré avec T-06 : l'interrupteur
 * « Reporter les tâches non faites » seul (`tasks.carryOverUndone`, partagé).
 * Les autres réglages arrivent avec leurs stories (M12).
 */
export interface SettingsState {
  readonly status: SettingsStatus;
  readonly carryOverUndone: boolean;
  readonly errorKey: PlainMessageKey | null;
  /** Lit le réglage (défaut : activé, Q1). Ne rejette jamais. */
  load(): Promise<void>;
  /** Enregistre le choix ; en cas d'échec, l'interrupteur revient à la valeur enregistrée. Ne rejette jamais. */
  setCarryOverUndone(value: boolean): Promise<void>;
}

export const settingsStore = defineFeatureStore<SettingsState>((container: AppContainer) =>
  createStore<SettingsState>()((set, get) => ({
    status: 'idle',
    carryOverUndone: true,
    errorKey: null,

    async load() {
      set({ status: 'loading', errorKey: null });
      try {
        set({ carryOverUndone: await container.data.repos.settings.get('tasks.carryOverUndone'), status: 'ready' });
      } catch {
        set({ status: 'error', errorKey: 'settings.loadError' });
      }
    },

    async setCarryOverUndone(value) {
      const previous = get().carryOverUndone;
      set({ carryOverUndone: value, errorKey: null });
      try {
        await container.data.repos.settings.set('tasks.carryOverUndone', value);
      } catch {
        set({ carryOverUndone: previous, errorKey: 'settings.saveError' });
      }
    },
  })),
);
