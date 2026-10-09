import { useState } from 'react';
import { t } from '../../i18n';
import { tBackupRestore } from '../../i18n/backupRestoreText';
import { setAsideRecoveryConflicts, type RecoveryRetryOutcome } from '../../platform/backup/startupRecovery';
import { appReload } from '../security/lockLayer';

/** Code de la récupération impossible (`startup-recovery: <code>`). */
export function recoveryCodeOf(message: string): string {
  return message.startsWith('startup-recovery: ') ? message.slice('startup-recovery: '.length) : 'unknown';
}

const CONFLICTS = new Set(['recovery-conflict', 'unsafe-restore-file']);

/**
 * Écran « Restauration interrompue » (P-04-iOS, revue I1) : texte et action propres à chaque cause, jamais un « Réessayer » qui ne peut pas
 * réussir. Conflit ou fichier anormal : « Mettre les fichiers en conflit de côté » (déplacés dans le dossier des sauvegardes, rien n'est
 * supprimé), puis rechargement si la récupération aboutit ; sinon, consigne de rouvrir l'app.
 */
export function RecoveryFailure({ message, setAside = setAsideRecoveryConflicts, reload = () => appReload.run() }: { message: string; setAside?: () => Promise<RecoveryRetryOutcome>; reload?: () => void }) {
  const code = recoveryCodeOf(message);
  const [phase, setPhase] = useState<'idle' | 'busy' | 'failed' | 'fresh-base'>('idle');
  const [failedCode, setFailedCode] = useState<string | null>(null);
  if (code === 'no-data-dir') return <p>{tBackupRestore('recoveryNoDataDir')}</p>;
  if (code === 'sql-plugin') return <p>{tBackupRestore('recoverySqlPlugin')}</p>;
  if (!CONFLICTS.has(code)) return <p>{t('backup.recoveryFailedIosHelp')}</p>;
  if (phase === 'fresh-base') {
    return (
      <>
        <p role="status">{tBackupRestore('recoveryFreshBase')}</p>
        <button type="button" className="ct-recovery__action" onClick={() => reload()}>
          {tBackupRestore('recoveryContinue')}
        </button>
      </>
    );
  }
  return (
    <>
      <p>{tBackupRestore('recoveryConflict')}</p>
      {phase === 'failed' ? (
        <p role="alert">
          {tBackupRestore('recoveryStillFailed')} {t('backup.errorCode', { code: failedCode ?? 'unknown' })}
        </p>
      ) : (
        <button
          type="button"
          className="ct-recovery__action"
          disabled={phase === 'busy'}
          onClick={() => {
            setPhase('busy');
            void setAside().then((outcome) => {
              if (outcome.state === 'ready') {
                // Revue du lot F : base neuve -> le message vers « Avant restauration » d'abord ; rechargement sur « Continuer ».
                if (outcome.notice === 'fresh-base') {
                  setPhase('fresh-base');
                  return;
                }
                reload();
                return;
              }
              setFailedCode(outcome.code);
              setPhase('failed');
            });
          }}
        >
          {phase === 'busy' ? tBackupRestore('recoverySetAsideBusy') : tBackupRestore('recoverySetAside')}
        </button>
      )}
    </>
  );
}

export default RecoveryFailure;
