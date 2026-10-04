import type { AppContainer } from '../app/container';

/** Réglage local `shortcut.quickCapture` (D-04) : combinaison globale et interrupteur. */
export interface QuickCaptureSetting {
  readonly enabled: boolean;
  /** Notation du registre : `Ctrl+Alt+Space`. */
  readonly keys: string;
}

/** Combinaison d'origine (PRD section 5) : « Rétablir » la remet. */
export const DEFAULT_QUICK_CAPTURE_KEYS = 'Ctrl+Alt+Space';

/**
 * Cas d'usage du raccourci global : seul point de lecture et d'écriture du réglage `shortcut.quickCapture`.
 * Contrat : chaque méthode rejette si la base échoue (l'appelant décide du message).
 */
export interface QuickCaptureUseCases {
  load(): Promise<QuickCaptureSetting>;
  save(setting: QuickCaptureSetting): Promise<void>;
}

export function createQuickCaptureUseCases(container: Pick<AppContainer, 'data'>): QuickCaptureUseCases {
  const settings = () => container.data.repos.settings;
  return {
    load: async () => {
      const stored = await settings().get('shortcut.quickCapture');
      return { enabled: stored.enabled, keys: stored.keys };
    },
    save: async (setting) => {
      await settings().set('shortcut.quickCapture', { enabled: setting.enabled, keys: setting.keys });
    },
  };
}
