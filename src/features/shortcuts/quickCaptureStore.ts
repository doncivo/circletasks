import { createStore } from 'zustand';
import type { PlainMessageKey } from '../../i18n';
import { t } from '../../i18n';
import { GlobalShortcutError, logDesktopFailure, type GlobalShortcutFailure } from '../../platform';
import { defineFeatureStore, type AppContainer } from '../app/container';
import { appShortcutUsing, formatChord } from '../app/shortcutsHelp';
import { createQuickCaptureUseCases, DEFAULT_QUICK_CAPTURE_KEYS } from './quickCaptureUseCases';

/** `off` : désactivée par l'utilisateur ; `unavailable` : activée mais le système a refusé (prise ailleurs) ; `active` : enregistrée. */
export type QuickCaptureStatus = 'off' | 'active' | 'unavailable';

const FAILURE_MESSAGES: Readonly<Record<GlobalShortcutFailure, PlainMessageKey>> = {
  syntax: 'shortcutsUi.errors.syntax',
  'no-modifier': 'shortcutsUi.errors.noModifier',
  'windows-key': 'shortcutsUi.errors.windowsKey',
  reserved: 'shortcutsUi.errors.reserved',
  'in-use': 'shortcutsUi.errors.inUse',
  unavailable: 'shortcutsUi.errors.unavailable',
};

export interface QuickCaptureState {
  /** Faux avant `init()` : la ligne n'affiche rien d'inventé. */
  readonly loaded: boolean;
  readonly keys: string;
  readonly status: QuickCaptureStatus;
  /** La ligne attend une nouvelle combinaison (critère 10). */
  readonly capturing: boolean;
  /** Message d'erreur de la dernière tentative ; null sinon. */
  readonly errorKey: PlainMessageKey | null;
  /** Résultat annoncé aux lecteurs d'écran (critère 12). */
  readonly announcement: string;
  /** Lit le réglage et enregistre la combinaison auprès du système (démarrage). Ne rejette jamais. */
  init(): Promise<void>;
  beginCapture(): void;
  /** Échap pendant la capture : rien ne change. */
  cancelCapture(): void;
  /** Combinaison refusée avant tout appel au système (touche Windows, aucun modificateur) : message, rien ne change. */
  rejectChord(errorKey: PlainMessageKey): void;
  /** Remplace la combinaison sans redémarrage ; en cas de refus, l'ancienne reste active. Ne rejette jamais. */
  applyChord(keys: string): Promise<void>;
  /** Interrupteur : retire ou rétablit l'enregistrement système. Ne rejette jamais. */
  setEnabled(enabled: boolean): Promise<void>;
  /** « Rétablir Ctrl+Alt+Espace ». */
  reset(): Promise<void>;
}

/**
 * Capture rapide globale (D-04) : réglage local `shortcut.quickCapture`, enregistrement système via le port
 * `GlobalShortcuts` de `container.desktop` (PC seulement ; sans lui, tout est sans effet).
 */
export const quickCaptureStore = defineFeatureStore<QuickCaptureState>((container) => createQuickCaptureStore(container));

function createQuickCaptureStore(container: AppContainer) {
  const useCases = createQuickCaptureUseCases(container);
  const shortcuts = () => container.desktop?.globalShortcuts ?? null;
  const reasonOf = (error: unknown): GlobalShortcutFailure => (error instanceof GlobalShortcutError ? error.reason : 'unavailable');

  return createStore<QuickCaptureState>()((set, get) => {
    /** Enregistre `keys` auprès du système ; renvoie la cause d'un refus, null si réussi. */
    async function registerSystem(keys: string): Promise<GlobalShortcutFailure | null> {
      const port = shortcuts();
      if (!port) return 'unavailable';
      try {
        await port.register(keys);
        return null;
      } catch (error) {
        logDesktopFailure('quick-capture-register', error);
        return reasonOf(error);
      }
    }

    async function persist(keys: string, enabled: boolean): Promise<boolean> {
      try {
        await useCases.save({ enabled, keys });
        return true;
      } catch {
        return false;
      }
    }

    return {
      loaded: false,
      keys: DEFAULT_QUICK_CAPTURE_KEYS,
      status: 'off',
      capturing: false,
      errorKey: null,
      announcement: '',

      async init() {
        if (!shortcuts()) return;
        let setting = { enabled: true, keys: DEFAULT_QUICK_CAPTURE_KEYS };
        try {
          setting = await useCases.load();
        } catch {
          // Base muette : le défaut s'applique, l'écran Réglages signalera l'échec de lecture.
        }
        if (!setting.enabled) {
          set({ loaded: true, keys: setting.keys, status: 'off' });
          return;
        }
        // Combinaison prise entre-temps : état « indisponible » (Q-01 critère 7), l'app reste utilisable.
        const failure = await registerSystem(setting.keys);
        set({ loaded: true, keys: setting.keys, status: failure ? 'unavailable' : 'active' });
      },

      beginCapture: () => set({ capturing: true, errorKey: null, announcement: t('shortcutsUi.settings.capturePrompt') }),

      cancelCapture: () => set({ capturing: false, errorKey: null, announcement: t('shortcutsUi.settings.cancelled') }),

      rejectChord: (errorKey) => set({ errorKey, capturing: false, announcement: t(errorKey) }),

      async applyChord(keys) {
        const conflict = appShortcutUsing(keys);
        if (conflict) {
          set({ errorKey: 'shortcutsUi.errors.appConflict', capturing: false, announcement: t('shortcutsUi.errors.appConflict') });
          return;
        }
        const failure = await registerSystem(keys);
        if (failure) {
          const errorKey = FAILURE_MESSAGES[failure];
          set({ errorKey, capturing: false, announcement: t(errorKey) });
          return;
        }
        const { keys: previous, status: previousStatus } = get();
        if (!(await persist(keys, true))) {
          // Réglage non écrit : on revient à l'état précédent pour que système et réglage restent d'accord.
          if (previousStatus === 'active') await registerSystem(previous);
          else await shortcuts()?.unregister().catch(() => undefined);
          set({ errorKey: 'shortcutsUi.settings.saveError', capturing: false, announcement: t('shortcutsUi.settings.saveError') });
          return;
        }
        set({ keys, status: 'active', capturing: false, errorKey: null, announcement: t('shortcutsUi.settings.changed', { keys: formatChord(keys) }) });
      },

      async setEnabled(enabled) {
        const { keys } = get();
        if (!enabled) {
          try {
            await shortcuts()?.unregister();
          } catch (error) {
            logDesktopFailure('quick-capture-unregister', error);
            set({ errorKey: 'shortcutsUi.errors.unavailable', announcement: t('shortcutsUi.errors.unavailable') });
            return;
          }
          const saved = await persist(keys, false);
          set({
            status: 'off',
            capturing: false,
            errorKey: saved ? null : 'shortcutsUi.settings.saveError',
            announcement: t('shortcutsUi.settings.turnedOff'),
          });
          return;
        }
        const failure = await registerSystem(keys);
        if (failure) {
          const errorKey = FAILURE_MESSAGES[failure];
          set({ status: 'unavailable', errorKey, announcement: t(errorKey) });
          await persist(keys, true);
          return;
        }
        const saved = await persist(keys, true);
        set({
          status: 'active',
          errorKey: saved ? null : 'shortcutsUi.settings.saveError',
          announcement: t('shortcutsUi.settings.turnedOn', { keys: formatChord(keys) }),
        });
      },

      reset: () => get().applyChord(DEFAULT_QUICK_CAPTURE_KEYS),
    };
  });
}
