import { useEffect, useState } from 'react';
import { systemClock } from '../../domain/clock';
import { openFocusWindowClient, type FocusWindowClient } from '../../platform/focus';
import { FocusMiniWindow } from './FocusMiniWindow';

/** Racine de la page chargée par la mini-fenêtre (`?window=focus`, src/main.tsx) : aucune base, aucun conteneur. */
export function FocusWindowRoot() {
  const [client, setClient] = useState<FocusWindowClient | null>(null);
  useEffect(() => {
    document.documentElement.dataset['window'] = 'focus';
    void openFocusWindowClient().then(setClient);
  }, []);
  return client ? <FocusMiniWindow client={client} clock={systemClock} /> : null;
}
