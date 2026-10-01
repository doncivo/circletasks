import type { LucideIcon } from 'lucide-react';

export interface IconProps {
  /** Composant d'icône Lucide importé nommément par l'appelant (tree-shaking, ADR 0001). */
  icon: LucideIcon;
  /** Côté du carré en pixels (largeur = hauteur). Les maquettes utilisent 18 à 30 px. */
  size?: number;
  /** Couleur du trait ; `currentColor` par défaut pour suivre la couleur du texte ambiant. */
  color?: string;
  /** Épaisseur du trait ; 1.8 par défaut, comme dans toutes les maquettes CircleTasks. */
  strokeWidth?: number;
  className?: string;
  /**
   * Texte accessible (clé i18n déjà résolue par l'appelant, jamais en dur ici).
   * Fourni : l'icône devient porteuse de sens (`role="img"`, `aria-label`).
   * Omis (par défaut) : l'icône est décorative et masquée aux lecteurs d'écran
   * (`aria-hidden="true"`), le libellé étant porté par un élément voisin.
   */
  label?: string;
}

/** Enveloppe fine autour des icônes Lucide au trait, au style des maquettes CircleTasks. */
export function Icon({ icon: LucideIconComponent, size = 24, color = 'currentColor', strokeWidth = 1.8, className, label }: IconProps) {
  return (
    <LucideIconComponent
      width={size}
      height={size}
      color={color}
      strokeWidth={strokeWidth}
      className={className}
      aria-hidden={label === undefined ? true : undefined}
      aria-label={label}
      role={label === undefined ? undefined : 'img'}
    />
  );
}
