import { Plus } from 'lucide-react';
import { t } from '../i18n';
import { Icon } from './Icon';
import { useLayout } from './useLayout';
import './Fab.css';

export interface FabProps {
  onClick: () => void;
  /** Libellé accessible (clé i18n résolue par l'appelant) ; « Ajouter » par défaut. */
  label?: string;
  disabled?: boolean;
  className?: string;
}

const SIZES = { pc: 60, mobile: 64 };

/**
 * Bouton rond violet (`--ct-color-accent`) d'ajout (PRD section 5, Ajout.html).
 * 64 px sur iPhone, 60 px sur PC ; dépasse largement la zone tactile minimale.
 *
 * @example
 * <Fab onClick={openTaskEditor} label={t('common.add')} />
 */
export function Fab({ onClick, label, disabled, className }: FabProps) {
  const layout = useLayout();
  const size = SIZES[layout];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label ?? t('common.add')}
      className={['ct-fab', className].filter(Boolean).join(' ')}
      style={{ width: size, height: size, borderRadius: size / 2 }}
    >
      <Icon icon={Plus} size={layout === 'pc' ? 26 : 28} color="var(--ct-color-accent-on)" strokeWidth={2.2} />
    </button>
  );
}
