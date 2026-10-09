import { t } from '../../i18n';
import { Button } from '../../ui';
import './FileSaveFailure.css';

export interface FileSaveFailureProps {
  /** Message de l'écran (« L'export a échoué… », « L'enregistrement n'a pas abouti »). */
  readonly message: string;
  readonly code: string;
  readonly tooLarge?: boolean;
  readonly onRetry: () => void;
  readonly disabled?: boolean;
}

/**
 * Échec d'enregistrement d'un fichier (FILES-IOS-01 critère 9) : message persistant près du bouton, code et « Réessayer » ; jamais un
 * bouton sans effet. « Fichier trop volumineux » remplace le message quand le code est `too-large` (critère 8) : refaire le même
 * enregistrement ne peut pas réussir, donc pas de « Réessayer » mais l'action utile (réduire le contenu exporté).
 */
export function FileSaveFailure({ message, code, tooLarge = false, onRetry, disabled = false }: FileSaveFailureProps) {
  return (
    <div className="ct-file-failure" role="alert">
      <p className="ct-file-failure__text">
        {tooLarge ? `${t('files.tooLarge')} ${t('files.tooLargeHint')}` : message} <span className="ct-file-failure__code">{t('files.errorCode', { code })}</span>
      </p>
      {!tooLarge && (
        <Button variant="secondary" onClick={onRetry} disabled={disabled}>
          {t('files.retry')}
        </Button>
      )}
    </div>
  );
}
