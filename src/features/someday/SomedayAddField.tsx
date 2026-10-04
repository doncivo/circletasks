import { useRef, type FormEvent } from 'react';
import { TASK_TITLE_MAX_LENGTH } from '../../domain/taskRules';
import { t } from '../../i18n';
import { QuickInputField, QuickPreview } from '../../ui';
import { captureInputFrom, useQuickInput, type CaptureInput } from '../capture';
import { useEffectiveProjectFilter } from '../spaces';

export interface SomedayAddFieldProps {
  /** Crée la tâche sans date ; rend true si elle l'est (le champ se vide et garde le focus, SD-01 critère 3). */
  readonly onAdd: (capture: CaptureInput) => Promise<boolean>;
  readonly className?: string;
  /** Panneau PC : le champ remplace le bouton « + Ajouter à « Un jour » » ; il le rend à Échap ou à la perte du focus quand il est vide. */
  readonly autoFocus?: boolean;
  readonly onCollapse?: () => void;
}

/**
 * Champ « Ajouter à « Un jour » » (UnJour.html, nom accessible « Nouvelle tâche sans date ») : Entrée crée, titre vide : rien.
 * Les marques « #espace » et « @projet » sont lues (Q-06) ; aucune date n'est cherchée dans le titre : la tâche reste sans date.
 */
export function SomedayAddField({ onAdd, className, autoFocus, onCollapse }: SomedayAddFieldProps) {
  const quick = useQuickInput({ dates: false });
  const projectFilter = useEffectiveProjectFilter();
  const inputRef = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (await onAdd(captureInputFrom(quick.parseNow(), quick.defaultSpaceId, projectFilter))) {
      quick.reset();
      inputRef.current?.focus();
    }
  }

  return (
    <form
      className={['ct-someday__addForm', className].filter(Boolean).join(' ')}
      onSubmit={submit}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && onCollapse) {
          event.stopPropagation();
          onCollapse();
        }
      }}
    >
      <div className="ct-someday__addBlock">
        <QuickInputField
          ref={inputRef}
          label={t('someday.addLabel')}
          placeholder={t('someday.addPlaceholder')}
          value={quick.text}
          onChange={quick.setText}
          maxLength={TASK_TITLE_MAX_LENGTH}
          context={quick.suggestionContext}
          {...(autoFocus ? { autoFocus } : {})}
          {...(onCollapse
            ? {
                onBlur: () => {
                  if (quick.text === '') onCollapse();
                },
              }
            : {})}
        />
        <QuickPreview parse={quick.parse} spaces={quick.spaces} projects={quick.projects} today={quick.today} onDismiss={quick.dismiss} />
      </div>
      <button type="submit" className="ct-visually-hidden" tabIndex={-1} aria-hidden="true" />
    </form>
  );
}
