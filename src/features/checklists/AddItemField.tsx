import { useState, type FormEvent, type RefObject } from 'react';
import { CHECKLIST_TEXT_MAX, validateChecklistText } from '../../domain/checklistRules';
import { t } from '../../i18n';

export interface AddItemFieldProps {
  readonly inputRef: RefObject<HTMLInputElement>;
  readonly placeholder: string;
  /** Ajoute l'item ; renvoie vrai si c'est fait. Un échec rend le texte saisi au champ (s'il est resté vide). */
  readonly onAdd: (text: string) => Promise<boolean>;
}

/**
 * Champ pointillé « Ajouter un élément » (Checklists.html) : Entrée ajoute l'item en fin de liste, vide le champ et lui garde le
 * focus, pour enchaîner les ajouts (C-01 critère 3). Entrée sur un champ vide ou blanc n'ajoute rien. Le champ est vidé aussitôt :
 * on peut taper l'élément suivant sans attendre l'écriture (les ajouts sont mis en file par le cas d'usage, l'ordre est conservé).
 */
export function AddItemField({ inputRef, placeholder, onAdd }: AddItemFieldProps) {
  const [value, setValue] = useState('');
  const [tooLong, setTooLong] = useState(false);

  function submit(event: FormEvent): void {
    event.preventDefault();
    const checked = validateChecklistText(value);
    if (!checked.ok) {
      setTooLong(checked.error === 'tooLong');
      return;
    }
    setTooLong(false);
    setValue('');
    void onAdd(checked.value).then((added) => {
      if (!added) setValue((current) => (current === '' ? checked.value : current));
    });
  }

  return (
    <form className="ct-checklist-add" onSubmit={submit} noValidate>
      <label className="ct-checklist-add__label">
        <span className="ct-visually-hidden">{t('checklists.addItemLabel')}</span>
        <input
          ref={inputRef}
          type="text"
          value={value}
          placeholder={placeholder}
          maxLength={CHECKLIST_TEXT_MAX}
          autoComplete="off"
          onChange={(event) => {
            setValue(event.target.value);
            setTooLong(false);
          }}
          className="ct-checklist-add__input"
        />
      </label>
      {tooLong && (
        <p className="ct-checklist-add__error" role="alert">
          {t('checklists.itemTooLong')}
        </p>
      )}
    </form>
  );
}
