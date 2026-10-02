import type { ReactNode } from 'react';
import './Button.css';

export type ButtonVariant = 'primary' | 'secondary';

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
  className?: string;
}

/**
 * Bouton primaire (rempli, accent) ou secondaire (contour), désactivable.
 * Styles des maquettes Ajout.html (« Enregistrer ») et Detail.html (« Reporter »).
 *
 * @example
 * <Button onClick={onSave}>{t('tasks.save')}</Button>
 * <Button variant="secondary" onClick={onPostpone}>{t('tasks.postpone')}</Button>
 */
export function Button({ children, onClick, variant = 'primary', disabled, fullWidth, type = 'button', pressed, className }: ButtonProps) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={pressed}
      className={['ct-button', `ct-button--${variant}`, fullWidth && 'ct-button--full', className].filter(Boolean).join(' ')}
    >
      {children}
    </button>
  );
}
