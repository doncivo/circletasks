export interface SomedayIconProps {
  readonly size?: number;
  /** Couleur du trait ; `currentColor` par défaut. */
  readonly color?: string;
}

/**
 * Icône « Un jour » des maquettes (Main.html, UnJour.html) : horloge au cercle en pointillés. Aucune icône Lucide équivalente
 * (comme `CompactToggle`, le tracé est celui de la maquette).
 */
export function SomedayIcon({ size = 26, color = 'currentColor' }: SomedayIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" strokeDasharray="3 2.6" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
