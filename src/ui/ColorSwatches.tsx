import type { HexColor } from '../domain/types';
import './ColorSwatches.css';

export interface ColorSwatchChoice {
  readonly id: string;
  readonly hex: HexColor;
  /** Nom de la couleur (clé i18n résolue par l'appelant), ex. « Bleu canard ». */
  readonly label: string;
}

export interface ColorSwatchesProps {
  /** Libellé du groupe (ex. « Couleur de l'espace Pro »). */
  label: string;
  choices: readonly ColorSwatchChoice[];
  value: string;
  onChange: (hex: HexColor) => void;
  disabled?: boolean;
}

/**
 * Palette de pastilles de couleur (Bienvenue.html : la couleur choisie porte un double anneau). Groupe de boutons radio, chaque
 * pastille nommée par sa couleur ; zone tactile de 44 pt autour du disque de 28 px.
 */
export function ColorSwatches({ label, choices, value, onChange, disabled }: ColorSwatchesProps) {
  return (
    <div role="radiogroup" aria-label={label} className="ct-swatches">
      {choices.map((choice) => {
        const checked = choice.hex === value;
        return (
          <button
            key={choice.id}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={choice.label}
            disabled={disabled}
            className="ct-swatches__item"
            onClick={() => onChange(choice.hex)}
          >
            <span className="ct-swatches__dot" data-checked={checked} style={{ background: choice.hex, ['--ct-swatch' as string]: choice.hex }} />
          </button>
        );
      })}
    </div>
  );
}
