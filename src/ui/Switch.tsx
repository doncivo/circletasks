import './Switch.css';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Libellé accessible (le même que le texte de la ligne, comme dans Reglages.html). */
  label: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Interrupteur des Réglages (Reglages.html .sw : 48 x 28, pastille blanche 22 px,
 * fond #2E2150 actif / #DDD9E4 inactif). Bouton `role="switch"` (`aria-checked`), zone
 * tactile ≥ 44 px autour du dessin.
 *
 * @example
 * <Switch checked={on} onChange={setOn} label={t('settings.carryOverUndone')} />
 */
export function Switch({ checked, onChange, label, disabled, className }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={['ct-switch', className].filter(Boolean).join(' ')}
      data-checked={checked}
    >
      <span className="ct-switch__track">
        <span className="ct-switch__thumb" />
      </span>
    </button>
  );
}
