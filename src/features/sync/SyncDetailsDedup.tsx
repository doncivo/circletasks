import { useEffect, useState } from 'react';
import { DEDUP_FAILURE_LIMIT, DEDUP_FAILURES_META } from '../../domain/occurrenceDedup';
import { tCarry } from '../../i18n/syncCarryReportText';
import { useAppContainer } from '../app/AppContainerContext';

/**
 * T-TECH-01 I4 (aucun échec silencieux) : le nettoyage des occurrences dédoublées a échoué `DEDUP_FAILURE_LIMIT` fois de suite (compteur local
 * `sync_meta`, remis à zéro par un passage réussi) : une ligne dans les Détails de la synchro, texte du catalogue à la demande. Rien en dessous
 * du seuil (nouvel essai au cycle suivant) ; l'échec reste dans le journal technique.
 */
export function SyncDetailsDedup() {
  const container = useAppContainer();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    container.data.repos.sync.getMeta(DEDUP_FAILURES_META).then(
      (raw) => live && setFailed(Number(raw ?? 0) >= DEDUP_FAILURE_LIMIT),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [container]);
  return failed ? (
    <p className="ct-settings__row" role="status" data-warning="recurrence-dedup">
      {tCarry('dedupFailed')}
    </p>
  ) : null;
}
