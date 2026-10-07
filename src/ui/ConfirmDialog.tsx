import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { t } from '../i18n';
import { Button } from './Button';
import { useFocusTrap } from './useFocusTrap';
import './ConfirmDialog.css';

export interface ConfirmDialogProps {
  /** Question, déjà résolue par l'appelant (ex. « Supprimer « Courses » ? »). */
  title: string;
  /** Précision facultative sous la question. */
  description?: string;
  /** Libellé de l'action destructive (ex. « Supprimer »). */
  confirmLabel: string;
  /** Libellé de l'annulation ; « Annuler » par défaut. */
  cancelLabel?: string;
  onConfirm: () => void;
  /** Bouton « Annuler » ou Échap : rien n'est fait. */
  onCancel: () => void;
}

/**
 * Confirmation d'une action destructive (T-08), fenêtre centrée sur PC comme sur iPhone
 * (`role="alertdialog"`, pas de boîte native). Focus piégé, posé sur « Annuler » à
 * l'ouverture (l'action destructive n'est jamais celle par défaut), Échap annule.
 * Rendue dans `document.body` : elle passe au-dessus d'une fiche détail ou d'une feuille.
 *
 * @example
 * <ConfirmDialog title={t('tasks.deleteConfirmTitle', { title })} confirmLabel={t('tasks.deleteConfirm')} onConfirm={remove} onCancel={close} />
 */
export function ConfirmDialog({ title, description, confirmLabel, cancelLabel, onConfirm, onCancel }: ConfirmDialogProps) {
  const descriptionId = useId();
  const ref = useFocusTrap<HTMLDivElement>({ active: true, onEscape: onCancel });
  const cancelRef = useRef<HTMLDivElement>(null);

  // Le piège de focus pose le focus sur le premier élément focusable ; on le replace sur
  // « Annuler » juste après (effet du composant, exécuté après celui du hook).
  useEffect(() => {
    cancelRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, []);

  return createPortal(
    <div className="ct-confirm__backdrop">
      <div ref={ref} role="alertdialog" aria-modal="true" aria-label={title} aria-describedby={description ? descriptionId : undefined} tabIndex={-1} className="ct-confirm">
        <h2 className="ct-confirm__title">{title}</h2>
        {description && <p id={descriptionId} className="ct-confirm__description">{description}</p>}
        <div className="ct-confirm__actions">
          <div ref={cancelRef} className="ct-confirm__cancel">
            <Button variant="secondary" fullWidth onClick={onCancel}>
              {cancelLabel ?? t('common.cancel')}
            </Button>
          </div>
          <Button variant="danger" onClick={onConfirm} className="ct-confirm__confirm">
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
