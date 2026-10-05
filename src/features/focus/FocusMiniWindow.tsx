import { useEffect, useMemo, useRef, useState } from 'react';
import type { Clock } from '../../domain/clock';
import { ensureLocale, getLocale, setLocale } from '../../i18n';
import { createHtmlAudioPlayer, type FocusWindowClient, type FocusWindowState, type SoundPlayer } from '../../platform/focus';
import { FocusView } from './FocusView';
import { focusChimeUrl } from './sounds';

/**
 * Contenu de la mini-fenêtre PC (F-01 critère 3, D4) : une vue pilotée par événements, sans accès à la base. Elle reçoit la
 * photographie de la session de la fenêtre principale, recalcule le temps affiché depuis les horodatages avec sa propre horloge, et
 * renvoie ses ordres (pause, durée, arrêt, terminer la tâche) à la fenêtre principale, qui écrit.
 */
export function FocusMiniWindow({ client, clock, player: injected }: { readonly client: FocusWindowClient; readonly clock: Clock; readonly player?: SoundPlayer }) {
  // F-04 critère 2 : le son de fin est joué par la mini-fenêtre (élément Audio, volume du système) ; aucune notification Windows.
  const player = useMemo(() => injected ?? createHtmlAudioPlayer(focusChimeUrl), [injected]);
  const [state, setState] = useState<FocusWindowState | null>(null);
  const [closeRequests, setCloseRequests] = useState(0);
  /** Numéro du dernier état reçu : un changement de langue en retard ne s'applique pas par-dessus un état plus récent. */
  const sequence = useRef(0);

  useEffect(() => {
    let disposed = false;
    const offs: (() => void)[] = [];
    void (async () => {
      const subscriptions = await Promise.all([
        client.onState((next) => {
          const seq = ++sequence.current;
          // L'état s'affiche tout de suite (pas d'écran vide pendant le chargement du catalogue) ; seul le changement de langue attend.
          setState(next);
          if (next.locale === getLocale()) return;
          // Langue chargée à la demande (ADR 0003, avenant) : catalogue d'abord, puis langue, puis nouveau rendu.
          void ensureLocale(next.locale).then(() => {
            if (seq !== sequence.current) return;
            setLocale(next.locale);
            setState((current) => (current === next ? { ...next } : current));
          });
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
  return <FocusView state={state} variant="window" clock={clock} closeRequests={closeRequests} player={player} onAction={(action) => void client.send(action)} />;
}
