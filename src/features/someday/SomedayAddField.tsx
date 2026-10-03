import { useRef, useState, type FormEvent } from 'react';
import { TASK_TITLE_MAX_LENGTH } from '../../domain/taskRules';
import { t } from '../../i18n';
import { TextField } from '../../ui';

export interface SomedayAddFieldProps {
  /** Crée la tâche sans date ; rend true si elle l'est (le champ se vide et garde le focus, SD-01 critère 3). */
  readonly onAdd: (title: string) => Promise<boolean>;
  readonly className?: string;
  /** Panneau PC : le champ remplace le bouton « + Ajouter à « Un jour » » ; il le rend à Échap ou à la perte du focus quand il est vide. */
  readonly autoFocus?: boolean;
  readonly onCollapse?: () => void;
}

/** Champ « Ajouter à « Un jour » » (UnJour.html, nom accessible « Nouvelle tâche sans date ») : Entrée crée, titre vide : rien. */
export function SomedayAddField({ onAdd, className, autoFocus, onCollapse }: SomedayAddFieldProps) {
  const [title, setTitle] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (await onAdd(title)) {
      setTitle('');
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
      <TextField
        ref={inputRef}
        label={t('someday.addLabel')}
        placeholder={t('someday.addPlaceholder')}
        value={title}
        onChange={setTitle}
        maxLength={TASK_TITLE_MAX_LENGTH}
        {...(autoFocus ? { autoFocus } : {})}
        {...(onCollapse
          ? {
              onBlur: () => {
                if (title === '') onCollapse();
              },
            }
          : {})}
      />
      <button type="submit" className="ct-visually-hidden" tabIndex={-1} aria-hidden="true" />
    </form>
  );
}
