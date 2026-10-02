import { detectTimeZoneChange, type TimeZoneChange } from '../../domain/timeZone';
import { detectTimeZone } from '../../platform';
import type { AppContainer } from './container';

export interface TimeZoneWatcherOptions {
  /** Détection injectable (tests, Playwright) ; défaut : fuseau du système. */
  readonly detect?: () => string | null;
  /** Fuseau courant connu (premier contrôle compris) : l'affichage s'y recale. */
  readonly onCurrent?: (timeZone: string) => void;
  /**
   * Point d'extension N-06 : appelé après chaque CHANGEMENT de fuseau (jamais au premier
   * enregistrement), une fois `general.timeZone` mis à jour. Ne rejette pas : les erreurs sont absorbées.
   */
  readonly onChange?: (change: TimeZoneChange) => void | Promise<void>;
}

export interface TimeZoneWatcher {
  /** Compare au dernier fuseau enregistré, met `general.timeZone` à jour. Ne rejette jamais. */
  check(): Promise<void>;
}

/**
 * Détection du changement de fuseau (T-11) : au démarrage et au retour au premier plan
 * (appelé par `startAppStartup`). Contrôles sérialisés. Les tâches et routines restent en
 * heure flottante : seul l'affichage des événements externes et « Aujourd'hui » se recalculent.
 */
export function createTimeZoneWatcher(container: Pick<AppContainer, 'data'>, options: TimeZoneWatcherOptions = {}): TimeZoneWatcher {
  const detect = options.detect ?? detectTimeZone;
  let chain: Promise<void> = Promise.resolve();

  const run = async (): Promise<void> => {
    try {
      const current = detect();
      if (current === null) return;
      options.onCurrent?.(current);
      const stored = await container.data.repos.settings.get('general.timeZone');
      const change = detectTimeZoneChange(stored, current);
      if (!change) return;
      await container.data.repos.settings.set('general.timeZone', current);
      if (change.previous !== null) await options.onChange?.(change);
    } catch {
      // Lecture / écriture du réglage impossible : nouvel essai au prochain retour au premier plan.
    }
  };

  return {
    check: () => {
      chain = chain.then(run);
      return chain;
    },
  };
}
