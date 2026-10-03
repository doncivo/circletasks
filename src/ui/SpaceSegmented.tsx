import type { CSSProperties } from 'react';
import type { SpaceId } from '../domain/types';
import type { SpacePillItem } from './SpacePills';
import './SpaceSegmented.css';

export interface SpaceSegmentedProps {
  /** Espaces proposés, dans l'ordre d'affichage. */
  items: readonly SpacePillItem[];
  value: SpaceId | null;
  onChange: (id: SpaceId) => void;
  /** Libellé du groupe (clé i18n résolue par l'appelant). */
  label: string;
  /** `fill` : les boutons se partagent la largeur (fenêtre d'ajout) ; `compact` : largeur du texte (ligne de formulaire). */
  layout?: 'fill' | 'compact';
}

/**
 * Sélecteur segmenté d'espace (Ajout.html, ModifierRoutine.html) : composant commun de toutes les fenêtres d'ajout et de
 * modification (ES-02). Choisir un espace ne change jamais le filtre actif.
 */
export function SpaceSegmented({ items, value, onChange, label, layout = 'fill' }: SpaceSegmentedProps) {
  return (
    <div className="ct-space-segmented" data-layout={layout} role="group" aria-label={label}>
      {items.map((space) => (
        <button
          key={space.id}
          type="button"
          aria-pressed={value === space.id}
          className="ct-space-segmented__button"
          style={{ '--ct-space-color': space.color } as CSSProperties}
          onClick={() => onChange(space.id)}
        >
          {space.name}
        </button>
      ))}
    </div>
  );
}
