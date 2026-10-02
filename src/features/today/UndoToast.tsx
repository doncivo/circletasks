import { useState, useSyncExternalStore } from 'react';
import { Toast } from '../../ui';
import { useAppContainer } from '../app/AppContainerContext';
import { undoMessage } from '../app/undo';

/**
 * Bandeau « Annuler » (T-04, branché sur le contrat générique `UndoStack` /
 * `Toast` de T-13, ADR 0005) : affiche la commande du dessus de la pile tant
 * qu'elle n'a pas été rejouée ou que son délai n'est pas écoulé. Pour l'instant
 * seule `taskUseCases.complete` (T-04) pousse une commande ; les autres actions
 * (reporter, déplacer, dupliquer, supprimer) et Ctrl+Z arrivent avec T-13, qui
 * généralisera aussi l'emplacement de montage (ici : écran Aujourd'hui, seul
 * écran qui pousse une commande à ce jour).
 */
export function UndoToast() {
  const container = useAppContainer();
  const snapshot = useSyncExternalStore(container.undo.subscribe, container.undo.getSnapshot);
  // `closedAt` mémorise le `pushCount` déjà fermé (bouton « Annuler » ou délai
  // écoulé) : le message reste masqué tant qu'aucune nouvelle commande n'arrive
  // (nouveau `pushCount`, qui relance aussi le compte à rebours du `Toast` via
  // `resetKey`).
  const [closedAt, setClosedAt] = useState(-1);
  if (snapshot.top === null || snapshot.pushCount === closedAt) return null;

  const command = snapshot.top;
  const message = undoMessage(command);

  async function handleAction(): Promise<void> {
    setClosedAt(snapshot.pushCount);
    try {
      // La commande publie la tâche rouverte dans `taskEntities` : liste et fiche suivent.
      await container.undo.undoLast();
      // 'stale' / 'empty' : message générique (critère 7 de T-13) hors périmètre
      // de T-04, pas de rejet non géré ici en attendant.
    } catch {
      // ADR 0005 : l'échec d'une commande est remonté à l'appelant, qui doit le
      // gérer ; T-13 affichera un message d'erreur dédié. Ici, on évite seulement
      // le rejet non géré.
    }
  }

  return (
    <Toast
      message={message}
      onAction={() => void handleAction()}
      onTimeout={() => setClosedAt(snapshot.pushCount)}
      resetKey={snapshot.pushCount}
      className="ct-today__undoToast"
    />
  );
}
