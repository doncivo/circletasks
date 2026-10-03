import { ChevronDown } from 'lucide-react';
import { Icon } from './Icon';
import './DropdownSelect.css';

export interface DropdownOption {
  readonly value: string;
  readonly label: string;
}

export interface DropdownSelectProps {
  readonly options: readonly DropdownOption[];
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Nom accessible de la liste (ex. « Projet »). */
  readonly label: string;
  /** Texte visible du bouton (ex. « Projet : aucun ») ; par défaut, le libellé de l'option choisie. */
  readonly display?: string;
  /** `field` : bouton pleine largeur de la feuille d'ajout (Ajout.html) ; `pill` : menu compact à côté des pastilles d'espace. */
  readonly variant?: 'field' | 'pill';
  readonly disabled?: boolean;
  readonly className?: string;
}

/**
 * Liste déroulante en forme de bouton (Ajout.html « Projet : aucun ▾ »). Un `<select>` natif recouvre le bouton : clavier, lecteurs
 * d'écran et roue de choix de l'iPhone sont ceux du système, sans menu à réinventer.
 *
 * @example
 * <DropdownSelect label={t('spaces.projectLabel')} options={options} value={projectId ?? ''} onChange={choose} display={t('spaces.projectFieldNone')} />
 */
export function DropdownSelect({ options, value, onChange, label, display, variant = 'field', disabled, className }: DropdownSelectProps) {
  const shown = display ?? options.find((option) => option.value === value)?.label ?? '';
  return (
    <span className={['ct-dropdown', className].filter(Boolean).join(' ')} data-variant={variant} data-disabled={disabled ? 'true' : undefined}>
      <span className="ct-dropdown__text">{shown}</span>
      <Icon icon={ChevronDown} size={18} />
      <select aria-label={label} className="ct-dropdown__native" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </span>
  );
}
