import { Check, Minus } from 'lucide-react';
import type { ReactNode } from 'react';
import { Icon } from './Icon';
import './EditControls.css';

/**
 * Commandes du mode édition des listes (A-05, Main-Edition.html), partagées avec « Un jour » (SD-04) :
 * interrupteur « − », rond de sélection, bouton de suppression d'une ligne, barre d'actions de sélection.
 */

export interface EditModeSwitchProps {
  /** Mode édition actif. */
  active: boolean;
  onChange: (active: boolean) => void;
  /** Libellé accessible (« Mode édition »). */
  label: string;
  className?: string;
}

/**
 * Interrupteur du mode édition (64 × 36, fond #2E2150, curseur blanc avec « − » à gauche ; actif : curseur
 * #F2A7A0 à droite), `aria-pressed`. Zone tactile de 44 px de haut.
 *
 * @example
 * <EditModeSwitch active={editMode} onChange={setEditMode} label={t('today.editMode')} />
 */
export function EditModeSwitch({ active, onChange, label, className }: EditModeSwitchProps) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={() => onChange(!active)}
      className={['ct-edit-switch', className].filter(Boolean).join(' ')}
      data-active={active}
    >
      <span className="ct-edit-switch__track">
        <span className="ct-edit-switch__knob">
          <Icon icon={Minus} size={16} strokeWidth={3} color="var(--ct-color-nav-bg)" />
        </span>
      </span>
    </button>
  );
}

export interface SelectCircleProps {
  selected: boolean;
  onToggle: () => void;
  /** Libellé accessible complet (« Sélectionner : <titre> » / « Désélectionner : <titre> »), composé par l'appelant. */
  label: string;
}

/** Rond de sélection d'une ligne (26 px ; sélectionné : fond d'accent avec coche), zone tactile ≥ 44 px. */
export function SelectCircle({ selected, onToggle, label }: SelectCircleProps) {
  return (
    <button type="button" aria-label={label} aria-pressed={selected} onClick={onToggle} className="ct-select-circle" data-selected={selected}>
      <span className="ct-select-circle__dot">{selected && <Icon icon={Check} size={14} strokeWidth={3.2} color="var(--ct-color-accent-on)" />}</span>
    </button>
  );
}

export interface RemoveButtonProps {
  onRemove: () => void;
  /** Libellé accessible complet (« Supprimer : <titre> »). */
  label: string;
}

/** Bouton rond « − » de suppression d'une ligne (36 px, fond d'alerte, trait rouge) avec zone tactile étendue à 44 px. */
export function RemoveButton({ onRemove, label }: RemoveButtonProps) {
  return (
    <button type="button" aria-label={label} onClick={onRemove} className="ct-remove-button">
      <span className="ct-remove-button__dot">
        <Icon icon={Minus} size={18} strokeWidth={2.6} color="var(--ct-color-danger)" />
      </span>
    </button>
  );
}

export interface SelectionBarProps {
  /** Texte du compteur déjà accordé (« 1 sélectionnée », « 2 sélectionnées »). */
  countLabel: string;
  /** Nom accessible de la barre. */
  label: string;
  /** Boutons d'action (`SelectionBarButton`). */
  children: ReactNode;
}

/** Barre d'actions de la sélection multiple (Main-Edition.html : fond #2E2150, compteur, actions), annoncée à chaque changement. */
export function SelectionBar({ countLabel, label, children }: SelectionBarProps) {
  return (
    <div role="toolbar" aria-label={label} className="ct-selection-bar">
      <span className="ct-selection-bar__count" aria-live="polite">
        {countLabel}
      </span>
      {children}
    </div>
  );
}

export interface SelectionBarButtonProps {
  children: ReactNode;
  onClick: () => void;
  /** Action destructive (fond #F2A7A0). */
  danger?: boolean;
  haspopup?: 'menu' | 'dialog';
  expanded?: boolean;
}

export function SelectionBarButton({ children, onClick, danger, haspopup, expanded }: SelectionBarButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup={haspopup}
      aria-expanded={expanded}
      className="ct-selection-bar__button"
      data-danger={danger ? 'true' : undefined}
    >
      {children}
    </button>
  );
}
