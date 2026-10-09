import { useCallback, useEffect, useState } from 'react';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { onPairingChange } from './pairingStatus';
import { syncStore } from './syncStore';

/**
 * Présence de la clé de synchronisation sur cet appareil, vue par l'interface (Y-IOS-02, point de contrôle d'Ali, 0.2.1).
 *
 * - `absent` : le coffre (Trousseau de l'iPhone, coffre de Windows) a répondu « aucune clé » : l'appareil est à associer ; il ne
 *   propose que l'association et « Oublier », jamais « Synchroniser » ni « Réinitialiser la synchronisation ».
 * - `present` : clé lue (jamais la clé elle-même : seulement sa présence).
 * - `unknown` : pas encore lue, ou coffre illisible (`vault-unavailable`, iPhone verrouillé) : rien de destructeur n'est proposé ;
 *   l'erreur reste dite par la phase du service.
 *
 * Relue à chaque changement de phase et d'association : la phase `needs-pairing` du moteur vaut « absente » sans attendre la lecture.
 */
export type KeyPresence = 'present' | 'absent' | 'unknown';

export function useKeyPresence(): KeyPresence {
  return useKeyInfo().presence;
}

/** Nombre de caractères du `kid` montrés dans Détails (comparaison PC / iPhone ; le `kid` n'est pas la clé, il est publié en clair). */
export const SHORT_KID_CHARS = 8;

/** Présence et identifiant court (`kid`) de la clé de cet appareil ; jamais la clé. */
export interface KeyInfo {
  readonly presence: KeyPresence;
  readonly shortKid: string | null;
  /** La dernière lecture du coffre a échoué (Trousseau verrouillé, coffre indisponible) : à dire, jamais à taire. */
  readonly unreadable: boolean;
  /** Relit la clé (« Réessayer »). */
  readonly reread: () => void;
}

/**
 * Présence et identifiant court (`kid`) de la clé de cet appareil ; jamais la clé. Relue à chaque changement de phase et d'association, à
 * la demande (`reread`) et au retour au premier plan (revue de la PR #17 : iPhone déverrouillé, coffre de Windows rouvert).
 */
export function useKeyInfo(): KeyInfo {
  const container = useAppContainer();
  const phase = useFeatureStore(syncStore, (s) => s.status.phase);
  const platform = container.syncPlatform;
  const [value, setValue] = useState<KeyPresence>('unknown');
  const [kid, setKid] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const reread = useCallback(() => setAttempt((n) => n + 1), []);

  const readable = platform !== null && phase !== 'not-configured';
  useEffect(() => {
    if (!platform || !readable) return;
    let cancelled = false;
    const read = (): void => {
      platform.key.status().then(
        (key) => {
          if (cancelled) return;
          setValue(key.present ? 'present' : 'absent');
          setKid(key.present && key.kid ? key.kid.slice(0, SHORT_KID_CHARS) : null);
          setFailed(false);
        },
        () => {
          // Coffre illisible : ni présente ni absente ; dit par l'écran (`unreadable`) et par la phase du service (jamais silencieux).
          if (cancelled) return;
          setValue('unknown');
          setKid(null);
          setFailed(true);
        },
      );
    };
    read();
    const stop = onPairingChange(container, read);
    const onVisibility = (): void => {
      if (document.visibilityState !== 'hidden') read();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [container, platform, phase, readable, attempt]);

  if (!readable) return { presence: 'unknown', shortKid: null, unreadable: false, reread };
  if (phase === 'needs-pairing') return { presence: 'absent', shortKid: null, unreadable: false, reread };
  return { presence: value, shortKid: kid, unreadable: failed && value === 'unknown', reread };
}
