import './CompactToggle.css';

export interface CompactToggleProps {
  /** Vue compacte active. */
  active: boolean;
  onChange: (active: boolean) => void;
  /** Libellé accessible (« Vue compacte »). */
  label: string;
}

/**
 * Bouton « Vue compacte » : deux flèches vers le centre entre deux traits (tracé de Main.html et PC-Aujourdhui.html), à
 * droite de la date ; actif : fond #F3F1F6 (Main-Compact.html), `aria-pressed`. Réutilisé par Routines, Checklists et
 * « Un jour » (A-06 critère 7).
 *
 * @example
 * <CompactToggle active={compact} onChange={setCompact} label={t('today.compactView')} />
 */
export function CompactToggle({ active, onChange, label }: CompactToggleProps) {
  return (
    <button type="button" aria-label={label} aria-pressed={active} onClick={() => onChange(!active)} className="ct-compact-toggle">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 4h16M4 20h16M12 6.5v4.5M9.5 8.5l2.5 2.5 2.5-2.5M12 17.5V13M9.5 15.5l2.5-2.5 2.5 2.5" />
      </svg>
    </button>
  );
}
