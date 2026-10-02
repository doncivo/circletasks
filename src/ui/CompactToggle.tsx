import { FoldVertical } from 'lucide-react';
import { Icon } from './Icon';
import './CompactToggle.css';

export interface CompactToggleProps {
  /** Vue compacte active. */
  active: boolean;
  onChange: (active: boolean) => void;
  /** Libellé accessible (« Vue compacte »). */
  label: string;
}

/**
 * Bouton « Vue compacte » (deux flèches entre deux traits, Main.html), à droite de la date ; actif : fond #F3F1F6
 * (Main-Compact.html), `aria-pressed`. Réutilisé par Routines, Checklists et « Un jour » (A-06 critère 7).
 *
 * @example
 * <CompactToggle active={compact} onChange={setCompact} label={t('today.compactView')} />
 */
export function CompactToggle({ active, onChange, label }: CompactToggleProps) {
  return (
    <button type="button" aria-label={label} aria-pressed={active} onClick={() => onChange(!active)} className="ct-compact-toggle">
      <Icon icon={FoldVertical} size={26} />
    </button>
  );
}
