import type { ReactNode } from 'react';
import './Button.css';

export type ButtonVariant = 'primary' | 'secondary' | 'danger';

export interface ButtonProps {
  /** Libellé visible : texte déjà résolu par l'appelant via t(), jamais en dur ici. */
  children: ReactNode;
  onClick?: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  fullWidth?: boolean;
  type?: 'button' | 'submit';
  /** Bouton à deux états (ex. « Marquer comme terminée » / « Rouvrir », T-04) : `aria-pressed`. */
  pressed?: boolean;
  /** Bouton qui ouvre un menu (T-05) : `aria-haspopup`. */
  haspopup?: 'menu';
  /** État ouvert / fermé du menu associé : `aria-expanded`. */
  expanded?: boolean;
  /** Nom accessible quand le libellé visible ne suffit pas (ex. « Restaurer : <titre> ») : `aria-label`. */
  ariaLabel?: string;
  className?: string;
}

/**
 * Bouton primaire (rempli, accent), secondaire (contour) ou destructif (rempli, couleur de danger : suppression, T-08), désactivable.
 * Styles des maquettes Ajout.html (« Enregistrer ») et Detail.html (« Reporter »).
 *
 * @example
 * <Button onClick={onSave}>{t('tasks.save')}</Button>
 * <Button variant="secondary" onClick={onPostpone}>{t('tasks.postpone')}</Button>
 */
export function Button({ children, onClick, variant = 'primary', disabled, fullWidth, type = 'button', pressed, haspopup, expanded, ariaLabel, className }: ButtonProps) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      aria-haspopup={haspopup}
      aria-expanded={expanded}
      aria-label={ariaLabel}
      className={['ct-button', `ct-button--${variant}`, fullWidth && 'ct-button--full', className].filter(Boolean).join(' ')}
    >
      {children}
    </button>
  );
}
