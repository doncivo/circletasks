import { t } from '../../i18n';
import { useFeatureStore } from '../app/AppContainerContext';
import { syncStore } from './syncStore';

/**
 * Bouton « Synchroniser » (Y-03 critères 1 à 3 et 8) : affiché seulement quand la synchro est configurée ; pendant le cycle, désactivé,
 * libellé « Synchronisation… » et `aria-busy` ; atteignable au clavier (bouton natif). Le résultat se lit dans la sous-ligne d'état.
 * Mêmes classes que le bouton du système de conception (`ct-button`) : `Button` ne porte pas `aria-busy`.
 */
export function SyncNowButton() {
  const phase = useFeatureStore(syncStore, (s) => s.status.phase);
  const busy = useFeatureStore(syncStore, (s) => s.busy);
  const syncNow = useFeatureStore(syncStore, (s) => s.syncNow);
  const available = useFeatureStore(syncStore, (s) => s.available);
  // Y-IOS-02 (point de contrôle d'Ali) : sans clé, un cycle ne peut rien faire ; seule l'association (« Associer au PC », clé de secours)
  // est proposée.
  if (!available || phase === 'not-configured' || phase === 'needs-pairing') return null;
  const running = busy || phase === 'syncing';
  return (
    <button type="button" className="ct-button ct-button--primary ct-sync__now" disabled={running} aria-busy={running} onClick={() => void syncNow('manual')}>
      {running ? t('sync.status.syncing') : t('sync.status.syncNow')}
    </button>
  );
}
