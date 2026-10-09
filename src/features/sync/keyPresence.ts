import { useEffect, useState } from 'react';
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
export function useKeyInfo(): { readonly presence: KeyPresence; readonly shortKid: string | null } {
  const container = useAppContainer();
  const phase = useFeatureStore(syncStore, (s) => s.status.phase);
  const platform = container.syncPlatform;
  const [value, setValue] = useState<KeyPresence>('unknown');
  const [kid, setKid] = useState<string | null>(null);

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
        },
        () => {
          // Coffre illisible : ni présente ni absente ; la phase du service dit l'erreur (jamais silencieux).
          if (cancelled) return;
          setValue('unknown');
          setKid(null);
        },
      );
    };
    read();
    const stop = onPairingChange(container, read);
    return () => {
      cancelled = true;
      stop();
    };
  }, [container, platform, phase, readable]);

  if (!readable) return { presence: 'unknown', shortKid: null };
  return phase === 'needs-pairing' ? { presence: 'absent', shortKid: null } : { presence: value, shortKid: kid };
}
