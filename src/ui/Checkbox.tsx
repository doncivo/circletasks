import { Check } from 'lucide-react';
import { Icon } from './Icon';
import { useLayout } from './useLayout';
import './Checkbox.css';

export interface CheckboxProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** Libellé accessible complet (ex. « Terminer : Boire de l'eau »), composé par l'appelant via t(). */
  label: string;
  /** Vue compacte (Main-Compact.html) : case de 22 px. */
  compact?: boolean;
  className?: string;
}

const SIZE = { pc: 26, mobile: 28 };
const COMPACT_SIZE = 22;

/**
 * Case à cocher arrondie des maquettes (Main.html) : 28 px sur iPhone, 26 px sur
 * PC, zone tactile ≥ 44 px (le bouton occupe toute la cellule tactile).
 *
 * @example
 * <Checkbox checked={task.done} onChange={toggle} label={t('tasks.complete', { title })} />
 */
export function Checkbox({ checked, onChange, label, compact, className }: CheckboxProps) {
  const layout = useLayout();
  const size = compact ? COMPACT_SIZE : SIZE[layout];
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={['ct-checkbox', className].filter(Boolean).join(' ')}
      data-checked={checked}
      style={{ minWidth: 'var(--ct-hit-target-min)', minHeight: 'var(--ct-hit-target-min)' }}
    >
      <span className="ct-checkbox__box" style={{ width: size, height: size, borderRadius: size * (8 / 28) }}>
        {checked && <Icon icon={Check} size={size * (16 / 28)} color="var(--ct-color-accent-on)" strokeWidth={3} />}
      </span>
    </button>
  );
}
