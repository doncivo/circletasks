import './StatusBanner.css';

export interface StatusBannerProps {
  /** Texte du bandeau, déjà résolu par l'appelant (« Hors ligne »). */
  message: string;
  /** Bouton d'action facultatif (« Reconnecter »). */
  actionLabel?: string;
  /** Nom accessible du bouton quand le libellé visible est court (« Voir » → « Voir le problème de synchronisation »). */
  actionAriaLabel?: string;
  onAction?: () => void;
}

/**
 * Bandeau d'état discret sous l'en-tête (A-09) : texte secondaire sur fond #F3F1F6, hauteur réduite, `role="status"`
 * (annoncé poliment), marges de sécurité iOS comprises. Il ne masque ni le champ d'ajout ni le bouton « + » (placé dans le flux).
 *
 * @example
 * <StatusBanner message={t('status.offline')} />
 */
export function StatusBanner({ message, actionLabel, actionAriaLabel, onAction }: StatusBannerProps) {
  return (
    <div role="status" className="ct-status-banner">
      <span>{message}</span>
      {actionLabel && onAction && (
        <button type="button" className="ct-status-banner__action" onClick={onAction} {...(actionAriaLabel ? { 'aria-label': actionAriaLabel } : {})}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}
