import type { ReactNode } from 'react';
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
 * Bandeau d'état discret sous l'en-tête (A-09) : texte secondaire sur fond #F3F1F6, hauteur réduite, marges de sécurité iOS
 * comprises. Il ne masque ni le champ d'ajout ni le bouton « + » (placé dans le flux). Il n'est pas une région vivante par lui-même :
 * un élément `role="status"` inséré avec son contenu est annoncé de façon peu fiable ; l'appelant le place dans une région déjà montée
 * (`StatusBannerRegion`).
 *
 * @example
 * <StatusBannerRegion><StatusBanner message={t('status.offline')} /></StatusBannerRegion>
 */
export function StatusBanner({ message, actionLabel, actionAriaLabel, onAction }: StatusBannerProps) {
  return (
    <div className="ct-status-banner">
      <span>{message}</span>
      {actionLabel && onAction && (
        <button type="button" className="ct-status-banner__action" onClick={onAction} {...(actionAriaLabel ? { 'aria-label': actionAriaLabel } : {})}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}

/**
 * Région vivante toujours montée (`aria-live="polite"`, l'équivalent de `role="status"` sans en prendre le rôle : les sélecteurs de rôle `status` restent réservés aux messages éphémères, comme « Annuler ») qui reçoit le bandeau : le contenu change dans une région déjà présente
 * dans le DOM, ce que les lecteurs d'écran annoncent de façon fiable. Div ordinaire, sans marge ni remplissage.
 */
export function StatusBannerRegion({ children }: { children?: ReactNode }) {
  return (
    <div aria-live="polite" aria-atomic="true" className="ct-status-region" data-testid="status-banner-region">
      {children}
    </div>
  );
}
