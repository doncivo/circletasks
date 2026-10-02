import { forwardRef, useId } from 'react';
import './TextField.css';

export interface TextFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** Libellé du champ (clé i18n résolue par l'appelant) ; masqué visuellement par défaut. */
  label: string;
  /** Texte d'exemple (clé i18n résolue par l'appelant), ex. « Ajouter une tâche ». */
  placeholder?: string;
  /** Rend le libellé visible au-dessus du champ (sinon accessible uniquement, maquettes). */
  visibleLabel?: boolean;
  /** Zone de texte (Note) au lieu d'un champ simple ligne. */
  multiline?: boolean;
  /** Longueur maximale (ex. 200 pour le titre d'une tâche, T-01). */
  maxLength?: number;
  /** Enregistrement à la perte de focus, sans bouton supplémentaire (Note, T-03 critère 8). */
  onBlur?: () => void;
  disabled?: boolean;
  className?: string;
}

/**
 * Champ de texte des maquettes (fond `--ct-color-surface-input`, coins arrondis).
 * La référence transmise (`ref`) porte sur le contrôle natif (`input` ou
 * `textarea`) : focus programmatique (bouton +, Ctrl+N, ouverture d'une feuille).
 *
 * @example
 * <TextField label={t('tasks.newTask')} placeholder={t('tasks.addPlaceholder')} value={title} onChange={setTitle} />
 */
export const TextField = forwardRef<HTMLInputElement | HTMLTextAreaElement, TextFieldProps>(function TextField(
  { value, onChange, label, placeholder, visibleLabel, multiline, maxLength, onBlur, disabled, className },
  ref,
) {
  const id = useId();
  return (
    <label htmlFor={id} className={['ct-text-field', className].filter(Boolean).join(' ')}>
      <span className={visibleLabel ? 'ct-text-field__label' : 'ct-visually-hidden'}>{label}</span>
      {multiline ? (
        <textarea
          ref={ref as React.Ref<HTMLTextAreaElement>}
          id={id}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          maxLength={maxLength}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          className="ct-text-field__control ct-text-field__control--multiline"
        />
      ) : (
        <input
          ref={ref as React.Ref<HTMLInputElement>}
          id={id}
          type="text"
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          maxLength={maxLength}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          className="ct-text-field__control"
        />
      )}
    </label>
  );
});
