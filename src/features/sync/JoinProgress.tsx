import { useEffect, useState } from 'react';
import { t } from '../../i18n';
import { Button } from '../../ui';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { onPairingChange, readJoinView, type JoinView } from './pairingStatus';
import { syncStore } from './syncStore';

const count = new Intl.NumberFormat('fr-FR');

/**
 * Arrivée du nouvel appareil (Y-06 critère 13 ; sans maquette, composée avec les lignes de Réglages) : « Réception de vos données…
 * 1 200 / 5 000 » pendant la reprise depuis l'instantané (`SyncStatus.progress`), puis rien. Exigence d'Ali : une arrivée arrêtée par
 * un échec (`sync_meta.join.failure`, gardé par le moteur jusqu'à la réussite) reste affichée, en rouge, avec « Réessayer », y compris
 * après un redémarrage ; une arrivée en attente (iCloud) est affichée sans alarme. Rien n'est affiché sans arrivée en cours.
 */
export function JoinProgress() {
  const container = useAppContainer();
  const status = useFeatureStore(syncStore, (s) => s.status);
  const busy = useFeatureStore(syncStore, (s) => s.busy);
  const syncNow = useFeatureStore(syncStore, (s) => s.syncNow);
  const [join, setJoin] = useState<JoinView | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => onPairingChange(container, () => setVersion((n) => n + 1)), [container]);

  // Relu à chaque changement d'état de la synchro (fin de cycle) et d'association.
  useEffect(() => {
    let cancelled = false;
    void readJoinView(container).then((view) => {
      if (!cancelled) setJoin(view);
    });
    return () => {
      cancelled = true;
    };
  }, [container, status, version]);

  if (!container.sync) return null;
  if (status.progress) {
    const { done, total } = status.progress;
    return (
      <div className="ct-settings__row ct-sync__join">
        <span className="ct-settings__stack">
          <span role="status">{t('sync.pairing.joinProgress', { done: count.format(done), total: count.format(total) })}</span>
          <progress className="ct-sync__joinBar" aria-label={t('sync.pairing.joinProgressLabel')} max={Math.max(1, total)} value={Math.min(done, total)} />
        </span>
      </div>
    );
  }
  if (!join) return null;
  const params = { done: count.format(join.done), total: count.format(join.total) };
  if (join.failure) {
    return (
      <div className="ct-settings__row ct-sync__join" data-testid="sync-join-failure">
        <span className="ct-settings__hint ct-settings__hint--danger" data-testid="sync-join-failure-text">
          {join.failure === 'clock-ahead' ? t('sync.pairing.joinFailedClock') : join.failure === 'state-mismatch' ? t('sync.pairing.joinFailedSnapshot') : t('sync.pairing.joinFailed', params)}
        </span>
        <Button variant="secondary" className="ct-settings__link" ariaLabel={t('sync.pairing.retryLabel')} disabled={busy} onClick={() => void syncNow('manual')}>
          {t('sync.pairing.retry')}
        </Button>
      </div>
    );
  }
  if (join.total === 0) return null;
  return (
    <div className="ct-settings__row ct-sync__join" data-testid="sync-join-waiting">
      <span className="ct-settings__hint" role="status">
        {t('sync.pairing.joinWaiting', params)}
      </span>
    </div>
  );
}
