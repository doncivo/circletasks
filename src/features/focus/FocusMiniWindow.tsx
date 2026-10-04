import { useEffect, useState } from 'react';
import type { Clock } from '../../domain/clock';
import { setLocale } from '../../i18n';
import type { FocusWindowClient, FocusWindowState } from '../../platform/focus';
import { FocusView } from './FocusView';

/**
 * Contenu de la mini-fenêtre PC (F-01 critère 3, D4) : une vue pilotée par événements, sans accès à la base. Elle reçoit la
 * photographie de la session de la fenêtre principale, recalcule le temps affiché depuis les horodatages avec sa propre horloge, et
 * renvoie ses ordres (pause, durée, arrêt, terminer la tâche) à la fenêtre principale, qui écrit.
 */
export function FocusMiniWindow({ client, clock }: { readonly client: FocusWindowClient; readonly clock: Clock }) {
  const [state, setState] = useState<FocusWindowState | null>(null);
  const [closeRequests, setCloseRequests] = useState(0);

  useEffect(() => {
    let disposed = false;
    const offs: (() => void)[] = [];
    void (async () => {
      const subscriptions = await Promise.all([
        client.onState((next) => {
          setLocale(next.locale);
          setState(next);
        }),
        client.onCloseRequested(() => setCloseRequests((count) => count + 1)),
        client.onMoved((position) => void client.send({ type: 'moved', x: position.x, y: position.y })),
      ]);
      if (disposed) {
        for (const off of subscriptions) off();
        return;
      }
      offs.push(...subscriptions);
      // Les écouteurs sont en place : la fenêtre principale peut envoyer l'état courant.
      await client.send({ type: 'ready' });
    })();
    return () => {
      disposed = true;
      for (const off of offs) off();
    };
  }, [client]);

  if (!state) return null;
  return <FocusView state={state} variant="window" clock={clock} closeRequests={closeRequests} onAction={(action) => void client.send(action)} />;
}
