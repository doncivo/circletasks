import './SegmentedControl.css';

export interface SegmentedOption<V extends string> {
  readonly value: V;
  readonly label: string;
}

export interface SegmentedControlProps<V extends string> {
  readonly options: readonly SegmentedOption<V>[];
  readonly value: V;
  readonly onChange: (value: V) => void;
  /** Nom accessible du groupe (clé i18n résolue par l'appelant). */
  readonly label: string;
  readonly disabled?: boolean;
}

/**
 * Contrôle segmenté à choix unique (P-02, P-03 : thème, premier jour, format d'heure), aspect de `SpaceSegmented`, boutons de 44 pt.
 * Accessibilité : `radiogroup` ; flèches gauche / droite déplacent le choix, une seule tabulation pour le groupe.
 */
export function SegmentedControl<V extends string>({ options, value, onChange, label, disabled = false }: SegmentedControlProps<V>) {
  function onKeyDown(event: React.KeyboardEvent<HTMLButtonElement>, index: number): void {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = options[(index + step + options.length) % options.length];
    if (!next) return;
    onChange(next.value);
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    buttons?.[(index + step + options.length) % options.length]?.focus();
  }
  return (
    <div className="ct-segmented" role="radiogroup" aria-label={label}>
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          tabIndex={value === option.value ? 0 : -1}
          disabled={disabled}
          className="ct-segmented__button"
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => onKeyDown(event, index)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
