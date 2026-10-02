import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { t } from '../../i18n';
import { Toast } from '../../ui';
import { useAppContainer } from './AppContainerContext';
import { undoMessage } from './undo';
import './UndoToast.css';

interface Notice {
  readonly id: number;
  readonly text: string;
}

/**
 * Bandeau « Annuler » global (T-13, Gestes.html) : monté une fois dans la coquille de l'app (App.tsx),
 * au-dessus des écrans, feuilles et panneaux. Il affiche 5 s la dernière commande de la pile
 * (`UndoStack`, ADR 0005) ; un nouveau `push` relance le délai. Il porte aussi le raccourci
 * Ctrl+Z (`app.undo`, hors champ de saisie, registre de raccourcis) : annule la dernière commande
 * de la pile, même après la disparition du message, quel que soit l'écran affiché.
 *
 * Résultat 'stale' (l'élément a changé depuis) : rien n'est écrit, message « Action impossible à annuler ».
 * Échec d'écriture : message dédié. Jamais de rejet non géré.
 */
export function UndoToast() {
  const container = useAppContainer();
  const snapshot = useSyncExternalStore(container.undo.subscribe, container.undo.getSnapshot);
  // `closedAt` mémorise le `pushCount` déjà fermé (bouton « Annuler », Ctrl+Z ou délai écoulé) :
  // le message reste masqué tant qu'aucune nouvelle commande n'arrive.
  const [closedAt, setClosedAt] = useState(-1);
  const [notice, setNotice] = useState<Notice | null>(null);

  const runUndo = useCallback(async (): Promise<void> => {
    setClosedAt(container.undo.getSnapshot().pushCount);
    try {
      const result = await container.undo.undoLast();
      if (result.status === 'stale') setNotice({ id: Date.now(), text: t('undo.stale') });
    } catch {
      setNotice({ id: Date.now(), text: t('undo.failed') });
    }
  }, [container]);

  useEffect(() => container.shortcuts.register('app.undo', () => void runUndo()), [container, runUndo]);

  if (notice) {
    return (
      <div className="ct-undo-host">
        <Toast message={notice.text} resetKey={notice.id} onTimeout={() => setNotice(null)} />
      </div>
    );
  }
  if (snapshot.top === null || snapshot.pushCount === closedAt) return null;

  return (
    <div className="ct-undo-host">
      <Toast
        message={undoMessage(snapshot.top)}
        onAction={() => void runUndo()}
        onTimeout={() => setClosedAt(snapshot.pushCount)}
        resetKey={snapshot.pushCount}
      />
    </div>
  );
}
