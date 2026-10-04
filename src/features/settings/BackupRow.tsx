import { useEffect, useState } from 'react';
import { summarizeBackups } from '../../domain/backupSchedule';
import { t } from '../../i18n';
import { formatBackupSummary } from '../../i18n/formatBackup';
import { Button } from '../../ui';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { BackupSheet } from './BackupSheet';
import { backupStore } from './backupStore';

/**
 * Ligne « Sauvegarde automatique » de Réglages › DONNÉES ET SÉCURITÉ (Reglages.html, P-04 critères 3 et 4) : sous-ligne « Aujourd'hui 03:12 ·
 * 14 versions » (heure réelle de la dernière sauvegarde quotidienne), « Aucune sauvegarde », ou « Dernière sauvegarde échouée » en rouge ;
 * le lien « Restaurer » ouvre la liste des versions. Absente quand la plateforme ne sauvegarde pas (iPhone à l'ordre 3).
 */
export function BackupRow() {
  const container = useAppContainer();
  const versions = useFeatureStore(backupStore, (s) => s.versions);
  const failed = useFeatureStore(backupStore, (s) => s.failed);
  const load = useFeatureStore(backupStore, (s) => s.load);
  const [open, setOpen] = useState(false);
  const available = container.backups.available();

  useEffect(() => {
    if (available) void load();
  }, [available, load]);

  if (!available) return null;

  const summary = formatBackupSummary(summarizeBackups(versions, container.clock), failed);
  return (
    <>
      <div className="ct-settings__row">
        <span className="ct-settings__stack">
          {t('backup.row')}
          <span className={failed ? 'ct-settings__hint ct-settings__hint--danger' : 'ct-settings__hint'} role={failed ? 'alert' : undefined} data-testid="backup-summary">
            {summary}
          </span>
        </span>
        <Button variant="secondary" ariaLabel={t('backup.restoreOpenLabel')} onClick={() => setOpen(true)} className="ct-settings__link">
          {t('backup.restore')}
        </Button>
      </div>
      {open && <BackupSheet onClose={() => setOpen(false)} />}
    </>
  );
}
