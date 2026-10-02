import { createStore } from 'zustand';
import { defaultSetting } from '../../domain/model';
import { validateRecapSettings, type RecapSettings, type RecapSettingsError } from '../../domain/recap';
import type { PlainMessageKey } from '../../i18n';
import { logDesktopFailure } from '../../platform';
import { defineFeatureStore, type AppContainer } from '../app/container';

export type SettingsStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Réglages affichés par l'écran minimal : « Reporter les tâches non faites »
 * (`tasks.carryOverUndone`, partagé, T-06) et, sur PC seulement, « Démarrer avec Windows »
 * (`desktop.launchAtStartup`, local, D-02) ; A-03 : « Masquer les routines de la liste » (`today.hideRoutines`, partagé). Les autres réglages arrivent avec leurs stories (M12).
 */
export interface SettingsState {
  readonly status: SettingsStatus;
  readonly carryOverUndone: boolean;
  /** A-03 : masquer les routines de la liste d'Aujourd'hui (`today.hideRoutines`, partagé, défaut : non). */
  readonly hideRoutines: boolean;
  /**
   * D-02 : état de l'entrée de démarrage Windows ; null tant qu'il n'est pas lu et hors PC
   * (la ligne n'existe alors pas).
   */
  readonly launchAtStartup: boolean | null;
  /** N-04 : récapitulatifs du matin et du soir (`reminders.morningRecap` / `eveningRecap`, partagés ; 07:30 et 21:00 actifs par défaut, QB-09). */
  readonly recaps: RecapSettings;
  readonly errorKey: PlainMessageKey | null;
  /**
   * N-04 : enregistre les récapitulatifs après validation (heures 24 h, soir après matin). Rend 'ok', l'erreur de validation (rien
   * n'est écrit) ou 'error' (écriture impossible). Aucune notification n'est planifiée (ordre 5, iPhone). Ne rejette jamais.
   */
  saveRecaps(next: RecapSettings): Promise<'ok' | RecapSettingsError | 'error'>;
  /** Lit les réglages (défaut : activé, Q1). Ne rejette jamais. */
  load(): Promise<void>;
  /** Enregistre le choix ; en cas d'échec, l'interrupteur revient à la valeur enregistrée. Ne rejette jamais. */
  setCarryOverUndone(value: boolean): Promise<void>;
  /** A-03 : enregistre le choix ; en cas d'échec, l'interrupteur revient à la valeur enregistrée. Ne rejette jamais. */
  setHideRoutines(value: boolean): Promise<void>;
  /** D-02 : crée ou supprime l'entrée de démarrage Windows (puis mémorise le choix). Ne rejette jamais. */
  setLaunchAtStartup(value: boolean): Promise<void>;
}

export const settingsStore = defineFeatureStore<SettingsState>((container: AppContainer) =>
  createStore<SettingsState>()((set, get) => ({
    status: 'idle',
    carryOverUndone: true,
    hideRoutines: false,
    launchAtStartup: null,
    recaps: { morning: defaultSetting('reminders.morningRecap'), evening: defaultSetting('reminders.eveningRecap') },
    errorKey: null,

    async load() {
      set({ status: 'loading', errorKey: null });
      try {
        const [carryOverUndone, hideRoutines, morning, evening] = await Promise.all([
          container.data.repos.settings.get('tasks.carryOverUndone'),
          container.data.repos.settings.get('today.hideRoutines'),
          container.data.repos.settings.get('reminders.morningRecap'),
          container.data.repos.settings.get('reminders.eveningRecap'),
        ]);
        set({ carryOverUndone, hideRoutines, recaps: { morning, evening }, status: 'ready' });
      } catch {
        set({ status: 'error', errorKey: 'settings.loadError' });
        return;
      }
      // D-02, critère 6 : l'interrupteur reflète l'état réel de l'entrée système (qui a pu être
      // retirée hors de l'app), pas le réglage mémorisé ; le miroir local est réaligné.
      const desktop = container.desktop;
      if (!desktop) return;
      try {
        const actual = await desktop.getAutostart();
        set({ launchAtStartup: actual });
        if (actual !== (await container.data.repos.settings.get('desktop.launchAtStartup'))) {
          await container.data.repos.settings.set('desktop.launchAtStartup', actual);
        }
      } catch (error) {
        logDesktopFailure('autostart-read', error);
        set({ errorKey: 'settings.loadError' });
      }
    },

    async saveRecaps(next) {
      const checked = validateRecapSettings(next);
      if (!checked.ok) return checked.error;
      const previous = get().recaps;
      set({ recaps: checked.value, errorKey: null });
      try {
        await container.data.repos.settings.set('reminders.morningRecap', checked.value.morning);
        await container.data.repos.settings.set('reminders.eveningRecap', checked.value.evening);
        return 'ok';
      } catch {
        set({ recaps: previous, errorKey: 'reminders.recapSaveError' });
        return 'error';
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

    async setHideRoutines(value) {
      const previous = get().hideRoutines;
      set({ hideRoutines: value, errorKey: null });
      try {
        await container.data.repos.settings.set('today.hideRoutines', value);
      } catch {
        set({ hideRoutines: previous, errorKey: 'settings.saveError' });
      }
    },

    async setLaunchAtStartup(value) {
      const desktop = container.desktop;
      if (!desktop) return;
      const previous = get().launchAtStartup;
      set({ launchAtStartup: value, errorKey: null });
      try {
        await desktop.setAutostart(value);
      } catch (error) {
        logDesktopFailure('autostart-set', error);
        set({ launchAtStartup: previous, errorKey: 'settings.autostartError' });
        return;
      }
      try {
        await container.data.repos.settings.set('desktop.launchAtStartup', value);
      } catch {
        // L'entrée système est à jour (source de vérité, relue à l'ouverture) : seul le miroir local manque.
        set({ errorKey: 'settings.saveError' });
      }
    },
  })),
);
