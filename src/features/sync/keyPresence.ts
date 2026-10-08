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
  const container = useAppContainer();
  const phase = useFeatureStore(syncStore, (s) => s.status.phase);
  const platform = container.syncPlatform;
  const [value, setValue] = useState<KeyPresence>('unknown');

  const readable = platform !== null && phase !== 'not-configured';
  useEffect(() => {
    if (!platform || !readable) return;
    let cancelled = false;
    const read = (): void => {
      platform.key.status().then(
        (key) => {
          if (!cancelled) setValue(key.present ? 'present' : 'absent');
        },
        () => {
          // Coffre illisible : ni présente ni absente ; la phase du service dit l'erreur (jamais silencieux).
          if (!cancelled) setValue('unknown');
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

  if (!readable) return 'unknown';
  return phase === 'needs-pairing' ? 'absent' : value;
}
