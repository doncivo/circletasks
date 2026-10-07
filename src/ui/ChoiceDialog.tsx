import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../i18n';
import { Button, type ButtonVariant } from './Button';
import { useFocusTrap } from './useFocusTrap';
import './ChoiceDialog.css';

export interface ChoiceOption<Id extends string> {
  readonly id: Id;
  /** Libellé déjà résolu par l'appelant (ex. « Cette occurrence »). */
  readonly label: string;
}

export interface ChoiceDialogProps<Id extends string> {
  /** Question, déjà résolue par l'appelant (ex. « Modifier « Loyer » ? »). */
  title: string;
  description?: string;
  /** Une ou plusieurs options, empilées ; chacune choisit et ferme la boîte. */
  options: readonly ChoiceOption<Id>[];
  /** `danger` pour une suppression ; `primary` par défaut. */
  optionVariant?: Extract<ButtonVariant, 'primary' | 'danger'>;
  cancelLabel?: string;
  onChoose: (id: Id) => void;
  /** « Annuler » ou Échap : rien n'est fait. */
  onCancel: () => void;
}

/**
 * Question à plusieurs réponses (T-10 : « Cette occurrence » / « Toutes les suivantes » / « Annuler »),
 * fenêtre centrée sur PC comme sur iPhone (`role="alertdialog"`, pas de boîte native). Même comportement que
 * `ConfirmDialog` : focus piégé et posé sur « Annuler » à l'ouverture, Échap annule, rendue dans `document.body`.
 *
 * @example
 * <ChoiceDialog title={t('tasks.seriesEditTitle', { title })} options={[{ id: 'occurrence', label: t('tasks.seriesScopeOccurrence') }]} onChoose={apply} onCancel={close} />
 */
export function ChoiceDialog<Id extends string>({ title, description, options, optionVariant = 'primary', cancelLabel, onChoose, onCancel }: ChoiceDialogProps<Id>) {
  const descriptionId = useId();
  const ref = useFocusTrap<HTMLDivElement>({ active: true, onEscape: onCancel });
  const cancelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    cancelRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, []);

  return createPortal(
    <div className="ct-choice__backdrop">
      <div ref={ref} role="alertdialog" aria-modal="true" aria-label={title} aria-describedby={description ? descriptionId : undefined} tabIndex={-1} className="ct-choice">
        <h2 className="ct-choice__title">{title}</h2>
        {description && <p id={descriptionId} className="ct-choice__description">{description}</p>}
        <div className="ct-choice__options">
          {options.map((option) => (
            <Button key={option.id} variant={optionVariant} fullWidth onClick={() => onChoose(option.id)}>
              {option.label}
            </Button>
          ))}
          <div ref={cancelRef}>
            <Button variant="secondary" fullWidth onClick={onCancel}>
              {cancelLabel ?? t('common.cancel')}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
