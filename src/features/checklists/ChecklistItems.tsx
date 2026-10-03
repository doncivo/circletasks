import { Check } from 'lucide-react';
import { useRef, useState, type KeyboardEvent } from 'react';
import { validateChecklistText, CHECKLIST_TEXT_MAX } from '../../domain/checklistRules';
import type { ChecklistItem } from '../../domain/model';
import type { ChecklistItemId } from '../../domain/types';
import { t } from '../../i18n';
import { Icon } from '../../ui';

export interface ChecklistItemsProps {
  readonly items: readonly ChecklistItem[];
  readonly compact: boolean;
  readonly onToggle: (id: ChecklistItemId) => void;
  /** Enregistre le texte modifié ; renvoie vrai si c'est fait (le champ se referme alors). */
  readonly onRename: (id: ChecklistItemId, text: string) => Promise<boolean>;
}

/** Items de la checklist affichée, en cartes grises (#F3F1F6) dans l'ordre manuel ; les cochés restent à leur place, barrés. */
export function ChecklistItems({ items, compact, onToggle, onRename }: ChecklistItemsProps) {
  if (items.length === 0) return null;
  return (
    <ul className="ct-checklist-items" aria-label={t('checklists.itemsLabel')} data-compact={compact || undefined}>
      {items.map((item) => (
        <ChecklistItemRow key={item.id} item={item} onToggle={onToggle} onRename={onRename} />
      ))}
    </ul>
  );
}

interface RowProps {
  readonly item: ChecklistItem;
  readonly onToggle: (id: ChecklistItemId) => void;
  readonly onRename: (id: ChecklistItemId, text: string) => Promise<boolean>;
}

function ChecklistItemRow({ item, onToggle, onRename }: RowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  const [invalid, setInvalid] = useState(false);
  // Évite qu'un blur provoqué par la fermeture du champ (Échap, Entrée) ne rejoue l'enregistrement.
  const closing = useRef(false);
  const id = item.id as ChecklistItemId;

  function open(): void {
    closing.current = false;
    setDraft(item.text);
    setInvalid(false);
    setEditing(true);
  }

  function cancel(): void {
    closing.current = true;
    setEditing(false);
    setInvalid(false);
  }

  async function commit(fromBlur: boolean): Promise<void> {
    if (closing.current) return;
    const checked = validateChecklistText(draft);
    if (!checked.ok) {
      // Vide refusé : Entrée garde le champ ouvert, la perte de focus rend l'ancien texte.
      if (fromBlur) cancel();
      else setInvalid(true);
      return;
    }
    closing.current = true;
    if (checked.value === item.text) {
      setEditing(false);
      return;
    }
    if (await onRename(id, checked.value)) setEditing(false);
    else closing.current = false;
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      void commit(false);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
  }

  return (
    <li className="ct-checklist-item" data-checked={item.checked} data-sortable-id={item.id}>
      <button
        type="button"
        className="ct-checklist-item__check"
        aria-pressed={item.checked}
        aria-label={t(item.checked ? 'checklists.uncheck' : 'checklists.check', { text: item.text })}
        onClick={() => onToggle(id)}
      >
        <span className="ct-checklist-item__box" data-checked={item.checked}>
          {item.checked && <Icon icon={Check} size={16} color="var(--ct-color-accent-on)" strokeWidth={3} />}
        </span>
      </button>
      {editing ? (
        <input
          type="text"
          autoFocus
          className="ct-checklist-item__edit"
          aria-label={t('checklists.itemTextLabel')}
          aria-invalid={invalid || undefined}
          value={draft}
          maxLength={CHECKLIST_TEXT_MAX}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => {
            setDraft(event.target.value);
            setInvalid(false);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => void commit(true)}
        />
      ) : (
        <button type="button" className="ct-checklist-item__text" data-checked={item.checked} aria-label={t('checklists.editItem', { text: item.text })} onClick={open}>
          {item.text}
        </button>
      )}
      {invalid && (
        <span className="ct-visually-hidden" role="alert">
          {t('checklists.itemEmpty')}
        </span>
      )}
    </li>
  );
}
