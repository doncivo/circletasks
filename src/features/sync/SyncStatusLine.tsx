import { useEffect, useState } from 'react';
import { t } from '../../i18n';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { useNavigationStore } from '../app/navigation';
import { SyncNowButton } from './SyncNowButton';
import { syncStore } from './syncStore';
import { folderLabel, isTroublePhase, statusLine } from './syncText';
import './SyncDetailsScreen.css';

/**
 * Ligne « iCloud Drive / CircleTasks » de Réglages (Reglages.html : sous-ligne « À jour · il y a 2 min » en 13 px vert, lien « Détails »),
 * avec le bouton « Synchroniser » (Y-03). Composant fourni au lot Y1 (`SyncSettingsSection`) et utilisé par l'écran de détails. La
 * sous-ligne n'est pas une région vivante (son âge change chaque minute) ; une erreur n'ouvre jamais de boîte bloquante.
 */
export function SyncStatusLine({ showDetailsLink = true }: { readonly showDetailsLink?: boolean }) {
  const container = useAppContainer();
  const status = useFeatureStore(syncStore, (s) => s.status);
  const navigate = useNavigationStore((s) => s.navigate);
  // L'âge affiché vieillit tout seul (« il y a 2 min ») : nouveau rendu chaque minute.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
  const now = container.clock.nowMs();
  return (
    <div className="ct-sync__line">
      <div className="ct-sync__lineText">
        <span className="ct-sync__folder">{status.folderLabel ? folderLabel({ label: status.folderLabel, kind: status.folderKind ?? 'unknown' }) : t('sync.status.folderFallback')}</span>
        <span className="ct-sync__sub" data-testid="sync-status-text" data-trouble={isTroublePhase(status) ? 'true' : undefined}>
          {statusLine(status, now)}
        </span>
        {/* Région vivante séparée, sans âge relatif : annonce seulement la fin d'une synchro réussie. Les états en cours et les problèmes
            sont annoncés par le bandeau (StatusBanner) : pas de double annonce. */}
        <span className="ct-visually-hidden" role="status" data-testid="sync-status-live">
          {(status.phase === 'idle' || status.phase === 'syncing') && status.lastSyncAt && !isTroublePhase(status) ? t('sync.status.upToDateAnnounce') : ''}
        </span>
      </div>
      <div className="ct-sync__lineActions">
        {showDetailsLink && (
          <button type="button" className="ct-sync__details" onClick={() => navigate({ tab: 'settings', screen: 'sync' })}>
            {t('sync.status.details')}
          </button>
        )}
        <SyncNowButton />
      </div>
    </div>
  );
}
