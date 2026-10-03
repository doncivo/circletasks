import { Trash2, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { CHECKLIST_TEXT_MAX, isValidChecklistTitle } from '../../domain/checklistRules';
import type { Checklist, IconRef, Space } from '../../domain/model';
import type { SpaceId } from '../../domain/types';
import { t } from '../../i18n';
import { Button, Icon, IconChooser, SpaceSegmented, TextField } from '../../ui';
import type { NewChecklistInput } from './checklistUseCases';

export interface ChecklistFormProps {
  /** Checklist modifiée ; null : création. */
  readonly checklist: Checklist | null;
  readonly spaces: readonly Space[];
  /** Espace proposé à la création (ES-02 : filtre actif, sinon Pro). */
  readonly initialSpaceId: SpaceId;
  /** Enregistre ; renvoie vrai si c'est fait (la feuille se ferme alors), faux sinon (elle reste ouverte). */
  readonly onSubmit: (input: NewChecklistInput) => Promise<boolean>;
  readonly onClose: () => void;
  /** Bouton corbeille de la feuille « Modifier la checklist » (C-01 critère 6). */
  readonly onDelete?: () => void;
  readonly errorMessage: string | null;
  /** Blocs propres à la modification (date, modèle, duplication), insérés avant les boutons. */
  readonly extras?: ReactNode;
}

/**
 * Feuille « Nouvelle checklist » / « Modifier la checklist » (C-01) : titre (1 à 200 caractères), icône (`IconChooser`), espace
 * (`SpaceSegmented`, défaut ES-02). « Créer » reste inactif tant que le titre est vide.
 */
export function ChecklistForm({ checklist, spaces, initialSpaceId, onSubmit, onClose, onDelete, errorMessage, extras }: ChecklistFormProps) {
  const headingId = useId();
  const titleRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(checklist?.title ?? '');
  const [icon, setIcon] = useState<IconRef | null>(checklist?.icon ?? null);
  const [spaceId, setSpaceId] = useState<SpaceId>(checklist?.spaceId ?? initialSpaceId);
  const [saving, setSaving] = useState(false);
  const valid = isValidChecklistTitle(title);

  // Focus dans le titre à l'ouverture : après le piège de focus de la feuille ou du panneau, qui prend le premier élément.
  useEffect(() => {
    if (checklist) return undefined;
    const timer = window.setTimeout(() => titleRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [checklist]);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!valid || saving) return;
    setSaving(true);
    try {
      await onSubmit({ title, icon, spaceId });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="ct-checklist-form" noValidate onSubmit={(event) => void submit(event)} aria-labelledby={headingId}>
      <div className="ct-checklist-form__header">
        <h2 id={headingId} className="ct-checklist-form__heading">
          {checklist ? t('checklists.sheet.editTitle') : t('checklists.sheet.newTitle')}
        </h2>
        <button type="button" className="ct-checklist-form__close" aria-label={t('checklists.sheet.close')} onClick={onClose}>
          <Icon icon={X} />
        </button>
      </div>

      <TextField
        ref={titleRef}
        label={t('checklists.sheet.titleLabel')}
        placeholder={t('checklists.sheet.titlePlaceholder')}
        value={title}
        onChange={setTitle}
        maxLength={CHECKLIST_TEXT_MAX}
        className="ct-checklist-form__title"
      />
      <IconChooser value={icon} onChange={setIcon} />

      <div className="ct-checklist-form__spaceRow">
        <SpaceSegmented layout="compact" items={spaces} value={spaceId} onChange={setSpaceId} label={t('checklists.sheet.spaceLabel')} />
      </div>

      {extras}

      {errorMessage && (
        <p className="ct-checklist-form__error" role="alert">
          {errorMessage}
        </p>
      )}

      <div className="ct-checklist-form__spacer" />
      <div className="ct-checklist-form__actions">
        {onDelete && (
          <button type="button" className="ct-checklist-form__delete" onClick={onDelete}>
            <Icon icon={Trash2} size={20} />
            {t('checklists.sheet.delete')}
          </button>
        )}
        <Button type="submit" fullWidth disabled={!valid || saving}>
          {checklist ? t('checklists.sheet.save') : t('checklists.sheet.create')}
        </Button>
      </div>
    </form>
  );
}
