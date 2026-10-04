import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { t, type PlainMessageKey } from '../../i18n';
import { formatBackupSize, formatBackupWhen } from '../../i18n/formatBackup';
import type { BackupFailureReason, BackupVersion } from '../../platform/backup';
import { Button, ConfirmDialog, Sheet, useFocusTrap, useLayout } from '../../ui';
import { useAppContainer, useFeatureStore } from '../app/AppContainerContext';
import { backupStore } from './backupStore';
import './BackupSheet.css';

const ERROR_KEYS: Record<BackupFailureReason, PlainMessageKey> = {
  corrupt: 'backup.errorCorrupt',
  'newer-schema': 'backup.errorNewer',
  'not-found': 'backup.errorNotFound',
  io: 'backup.errorIo',
  'rollback-failed': 'backup.errorRollback',
  unavailable: 'backup.errorIo',
};

function BackupWindow({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const ref = useFocusTrap<HTMLDivElement>({ active: true, onEscape: onClose });
  return createPortal(
    <div className="ct-backup__backdrop">
      <div ref={ref} role="dialog" aria-modal="true" aria-label={t('backup.sheetTitle')} tabIndex={-1} className="ct-backup">
        {children}
      </div>
    </div>,
    document.body,
  );
}

function VersionRow({ version, disabled, onChoose }: { version: BackupVersion; disabled: boolean; onChoose: () => void }) {
  const when = formatBackupWhen(version.modifiedMs);
  const size = formatBackupSize(version.size);
  const details =
    version.tasks === null ? t('backup.versionDetailsUnknown', { size }) : version.tasks === 1 ? t('backup.versionDetailsOne', { size }) : t('backup.versionDetails', { size, tasks: version.tasks });
  const tag = version.kind === 'pre-migration' ? t('backup.kindPreMigration') : version.kind === 'pre-restore' ? t('backup.kindPreRestore') : null;
  return (
    <li>
      <button type="button" className="ct-backup__version" disabled={disabled} onClick={onChoose}>
        <span className="ct-backup__versionMain">
          <span className="ct-backup__versionTitle">{t('backup.versionLabel', { date: when.date, time: when.time })}</span>
          <span className="ct-backup__versionDetails">{details}</span>
        </span>
        {tag && <span className="ct-backup__tag">{tag}</span>}
      </button>
    </li>
  );
}

/**
 * Feuille « Restaurer une sauvegarde » (P-04 critères 4, 5, 9 et 12) : fenêtre centrée sur PC, feuille sur iPhone. Liste des versions
 * (date, heure, taille, nombre de tâches ; « Avant mise à jour » pour celles d'une migration), « Sauvegarder maintenant », emplacement du
 * dossier, puis une confirmation (focus sur « Annuler ») avant la restauration. La restauration ferme la base, remplace le fichier et
 * relance l'app ; le redémarrage est annoncé.
 */
export function BackupSheet({ onClose }: { onClose: () => void }) {
  const container = useAppContainer();
  const layout = useLayout();
  const status = useFeatureStore(backupStore, (s) => s.status);
  const versions = useFeatureStore(backupStore, (s) => s.versions);
  const directory = useFeatureStore(backupStore, (s) => s.directory);
  const backingUp = useFeatureStore(backupStore, (s) => s.backingUp);
  const justBackedUp = useFeatureStore(backupStore, (s) => s.justBackedUp);
  const failed = useFeatureStore(backupStore, (s) => s.failed);
  const phase = useFeatureStore(backupStore, (s) => s.restorePhase);
  const restoreError = useFeatureStore(backupStore, (s) => s.restoreError);
  const restartNeeded = useFeatureStore(backupStore, (s) => s.restartNeeded);
  const load = useFeatureStore(backupStore, (s) => s.load);
  const backupNow = useFeatureStore(backupStore, (s) => s.backupNow);
  const restore = useFeatureStore(backupStore, (s) => s.restore);
  const restart = useFeatureStore(backupStore, (s) => s.restart);
  const resetRestore = useFeatureStore(backupStore, (s) => s.resetRestore);
  const [chosen, setChosen] = useState<BackupVersion | null>(null);
  const reveal = container.backups.reveal?.bind(container.backups);
  const locked = phase === 'running' || phase === 'done';

  useEffect(() => {
    void load();
    return () => resetRestore();
  }, [load, resetRestore]);

  const close = (): void => {
    if (!locked) onClose();
  };

  const when = chosen ? formatBackupWhen(chosen.modifiedMs) : null;

  const body = (
    <div className="ct-backup__content">
      <h2 className="ct-backup__title">{t('backup.sheetTitle')}</h2>
      <p className="ct-backup__note">{t('backup.sheetIntro')}</p>
      <div className="ct-backup__tools">
        <Button variant="secondary" onClick={() => void backupNow()} disabled={backingUp || locked}>
          {backingUp ? t('backup.backupNowBusy') : t('backup.backupNow')}
        </Button>
        {reveal && (
          <Button variant="secondary" onClick={() => void reveal()} disabled={locked}>
            {t('backup.reveal')}
          </Button>
        )}
      </div>
      {justBackedUp && !failed && (
        <p className="ct-backup__note" role="status">
          {t('backup.backupNowDone')}
        </p>
      )}
      {failed && (
        <p className="ct-backup__error" role="alert">
          {t('backup.backupFailed')}
        </p>
      )}
      {status === 'loading' && versions.length === 0 && (
        <p className="ct-backup__note" role="status">
          {t('backup.loading')}
        </p>
      )}
      {status === 'error' && (
        <p className="ct-backup__error" role="alert">
          {t('backup.loadError')}
        </p>
      )}
      {status === 'ready' && versions.length === 0 && (
        <div className="ct-backup__empty">
          <p className="ct-backup__emptyTitle">{t('backup.emptyTitle')}</p>
          <p className="ct-backup__note">{t('backup.emptyText')}</p>
        </div>
      )}
      {versions.length > 0 && (
        <ul className="ct-backup__list" aria-label={t('backup.listLabel')}>
          {versions.map((version) => (
            <VersionRow key={version.name} version={version} disabled={locked} onChoose={() => setChosen(version)} />
          ))}
        </ul>
      )}
      {phase === 'running' && (
        <p className="ct-backup__note" role="status">
          {t('backup.busy')}
        </p>
      )}
      {phase === 'done' && (
        <p className="ct-backup__done" role="status">
          {t('backup.done')}
        </p>
      )}
      {phase === 'failed' && restoreError && (
        <div className="ct-backup__error" role="alert">
          <p>{t(restartNeeded && restoreError === 'io' ? 'backup.errorClosed' : ERROR_KEYS[restoreError])}</p>
          {restartNeeded && (
            <Button onClick={() => void restart()} className="ct-backup__restart">
              {t('backup.restart')}
            </Button>
          )}
        </div>
      )}
      {directory && <p className="ct-backup__note">{t('backup.location', { path: directory })}</p>}
      <p className="ct-backup__note">{t('backup.help')}</p>
      <div className="ct-backup__actions">
        <Button variant="secondary" onClick={close} disabled={locked}>
          {t('backup.close')}
        </Button>
      </div>
      {chosen && when && (
        <ConfirmDialog
          title={t('backup.confirmTitle')}
          description={t('backup.confirmText', { date: when.date, time: when.time })}
          confirmLabel={t('backup.confirm')}
          onCancel={() => setChosen(null)}
          onConfirm={() => {
            const version = chosen;
            setChosen(null);
            void restore(version);
          }}
        />
      )}
    </div>
  );

  return layout === 'pc' ? (
    <BackupWindow onClose={close}>{body}</BackupWindow>
  ) : (
    <Sheet open onClose={close} label={t('backup.sheetTitle')}>
      {body}
    </Sheet>
  );
}
