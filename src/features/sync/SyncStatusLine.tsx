import { useEffect, useState } from 'react';
import { t } from '../../i18n';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { useNavigationStore } from '../app/navigation';
import { SyncNowButton } from './SyncNowButton';
import { syncStore } from './syncStore';
import { folderLabel, isTroublePhase, statusLine, syncStatusTone } from './syncText';
import './SyncDetailsScreen.css';

export interface SyncStatusLineProps {
  readonly showDetailsLink?: boolean;
  /**
   * `line` (Réglages, Reglages.html) : dossier puis sous-ligne d'état. `card` (UI-REFONTE-04, Synchro-v4.html) : carte d'état en une
   * phrase, rond et bordure au ton de l'état (vert seulement quand tout est parti), dossier en sous-ligne, « Synchroniser » à droite.
   */
  readonly variant?: 'line' | 'card';
}

/**
 * Ligne « iCloud Drive / CircleTasks » de Réglages (Reglages.html : sous-ligne « À jour · il y a 2 min » en 13 px vert, lien « Détails »),
 * avec le bouton « Synchroniser » (Y-03). Composant fourni au lot Y1 (`SyncSettingsSection`) et utilisé par l'écran de détails (variante
 * `card`). La sous-ligne n'est pas une région vivante (son âge change chaque minute) ; une erreur n'ouvre jamais de boîte bloquante.
 */
export function SyncStatusLine({ showDetailsLink = true, variant = 'line' }: SyncStatusLineProps) {
  const container = useAppContainer();
  const status = useFeatureStore(syncStore, (s) => s.status);
  const navigate = useNavigationStore((s) => s.navigate);
  // L'âge affiché vieillit tout seul (« il y a 2 min ») : nouveau rendu chaque minute.
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
  // Texte annoncé : celui du dernier état stable, jamais recalculé pendant un cycle (« syncing » garde la valeur d'avant). Ajusté pendant
  // le rendu, sans effet.
  const [announced, setAnnounced] = useState('');
  const tone = syncStatusTone(status);
  const next = status.phase === 'syncing' ? announced : tone === 'success' ? t('sync.status.upToDateAnnounce') : '';
  if (next !== announced) setAnnounced(next);
  const now = container.clock.nowMs();
  const folder = <span className="ct-sync__folder">{status.folderLabel ? folderLabel({ label: status.folderLabel, kind: status.folderKind ?? 'unknown' }) : t('sync.status.folderFallback')}</span>;
  const state = (
    <span className="ct-sync__sub" data-testid="sync-status-text" data-tone={tone} data-trouble={isTroublePhase(status) ? 'true' : undefined}>
      {statusLine(status, now)}
    </span>
  );
  // Région vivante séparée, sans âge relatif : annonce seulement la fin d'une synchro réussie. Les états en cours et les problèmes sont
  // annoncés par le bandeau (StatusBanner) : pas de double annonce.
  const live = (
    <span className="ct-visually-hidden" role="status" data-testid="sync-status-live">
      {announced}
    </span>
  );
  if (variant === 'card') {
    return (
      <div className="ct-sync__stateCard" data-tone={tone}>
        <span className="ct-sync__stateMark" aria-hidden="true" />
        <div className="ct-sync__lineText">
          {state}
          {folder}
          {live}
        </div>
        <div className="ct-sync__lineActions">
          <SyncNowButton />
        </div>
      </div>
    );
  }
  return (
    <div className="ct-sync__line">
      <div className="ct-sync__lineText">
        {folder}
        {state}
        {live}
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
