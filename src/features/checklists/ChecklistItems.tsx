import { Check } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { validateChecklistText, CHECKLIST_TEXT_MAX } from '../../domain/checklistRules';
import type { ChecklistItem } from '../../domain/model';
import type { ChecklistItemId } from '../../domain/types';
import { t } from '../../i18n';
import { DragHandle, Icon, RemoveButton, useSortable, type Layout, type Sortable } from '../../ui';
import { useAppContainer } from '../app/AppContainerContext';

export interface ChecklistItemsProps {
  readonly items: readonly ChecklistItem[];
  readonly layout: Layout;
  readonly compact: boolean;
  /** Mode « Réorganiser » : poignées (iPhone) et « − » sur chaque item (C-05 critère 5). */
  readonly reordering: boolean;
  readonly onToggle: (id: ChecklistItemId) => void;
  /** Enregistre le texte modifié ; renvoie vrai si c'est fait (le champ se referme alors). */
  readonly onRename: (id: ChecklistItemId, text: string) => Promise<boolean>;
  /** Place l'item à la position `toIndex` ; renvoie la position finale et le total, null si rien ne change. */
  readonly onMove: (id: ChecklistItemId, toIndex: number) => Promise<{ readonly position: number; readonly total: number } | null>;
  readonly onRemove: (id: ChecklistItemId) => void;
}

/**
 * Items de la checklist affichée, en cartes grises (#F3F1F6) dans l'ordre manuel ; les cochés restent à leur place, barrés.
 * Réordonner (C-05) réutilise la primitive `useSortable` (A-02) : glisser la poignée, ↑ / ↓ sur la poignée focalisée, ou Alt+↑ / Alt+↓ sur
 * la ligne sélectionnée. Poignées toujours visibles sur PC (PC-Checklists.html) ; sur iPhone, seulement en mode « Réorganiser ».
 */
export function ChecklistItems({ items, layout, compact, reordering, onToggle, onRename, onMove, onRemove }: ChecklistItemsProps) {
  const container = useAppContainer();
  const [announcement, setAnnouncement] = useState<{ readonly text: string; readonly n: number } | null>(null);
  const [focusedId, setFocusedId] = useState<ChecklistItemId | null>(null);
  // Item déplacé et ordre avant le déplacement : le focus le suit dès que la liste affiche le nouvel ordre.
  const focusAfterMove = useRef<{ readonly id: ChecklistItemId; readonly orderKey: string } | null>(null);
  const orderKey = items.map((item) => item.id).join('|');
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  });

  const applyMove = useCallback(
    async (id: ChecklistItemId, toIndex: number): Promise<void> => {
      const moved = await onMove(id, toIndex);
      if (!moved) return;
      focusAfterMove.current = { id, orderKey: itemsRef.current.map((item) => item.id).join('|') };
      setAnnouncement((previous) => ({ text: t('checklists.moved', moved), n: (previous?.n ?? 0) + 1 }));
    },
    [onMove],
  );

  const sortable = useSortable({
    ids: items.map((item) => item.id),
    onMove: (id, toIndex) => void applyMove(id as ChecklistItemId, toIndex),
    disabled: layout === 'mobile' && !reordering,
  });

  // Le focus suit la ligne déplacée : l'insertion dans le DOM le lui fait perdre.
  useEffect(() => {
    const pending = focusAfterMove.current;
    if (!pending || pending.orderKey === orderKey) return;
    focusAfterMove.current = null;
    const row = document.querySelector<HTMLElement>(`[data-sortable-id="${pending.id}"]`);
    (row?.querySelector<HTMLElement>('.ct-drag-handle') ?? row?.querySelector<HTMLElement>('.ct-checklist-item__check'))?.focus();
  }, [orderKey, announcement]);

  // Alt+↑ / Alt+↓ : déplace la ligne sélectionnée (registre de raccourcis, comme A-02).
  useEffect(() => {
    if (!focusedId) return undefined;
    const move = (delta: number) => () => {
      const index = itemsRef.current.findIndex((item) => item.id === focusedId);
      if (index >= 0) void applyMove(focusedId, index + delta);
    };
    const offUp = container.shortcuts.register('list.moveUp', move(-1));
    const offDown = container.shortcuts.register('list.moveDown', move(1));
    return () => {
      offUp();
      offDown();
    };
  }, [container, focusedId, applyMove]);

  if (items.length === 0) return null;
  const handles = layout === 'pc' || reordering;
  return (
    <div {...sortable.containerProps} className={`${sortable.containerProps.className} ct-checklist-items-host`}>
      <ul className="ct-checklist-items" aria-label={t('checklists.itemsLabel')} data-compact={compact || undefined}>
        {items.map((item, index) => (
          <ChecklistItemRow
            key={item.id}
            item={item}
            layout={layout}
            handle={handles}
            removable={reordering}
            sortable={sortable}
            onFocus={() => setFocusedId(item.id as ChecklistItemId)}
            onMoveBy={(delta) => void applyMove(item.id as ChecklistItemId, index + delta)}
            onToggle={onToggle}
            onRename={onRename}
            onRemove={onRemove}
          />
        ))}
      </ul>
      <div key={announcement?.n ?? 0} className="ct-visually-hidden" aria-live="polite" aria-atomic="true">
        {announcement?.text}
      </div>
    </div>
  );
}

interface RowProps {
  readonly item: ChecklistItem;
  readonly layout: Layout;
  readonly handle: boolean;
  readonly removable: boolean;
  readonly sortable: Sortable;
  readonly onFocus: () => void;
  readonly onMoveBy: (delta: number) => void;
  readonly onToggle: (id: ChecklistItemId) => void;
  readonly onRename: (id: ChecklistItemId, text: string) => Promise<boolean>;
  readonly onRemove: (id: ChecklistItemId) => void;
}

function ChecklistItemRow({ item, layout, handle, removable, sortable, onFocus, onMoveBy, onToggle, onRename, onRemove }: RowProps) {
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

  const grip = handle ? (
    <DragHandle
      label={t('checklists.moveHandle', { text: item.text })}
      {...sortable.dragProps(item.id, 'handle')}
      onMoveUp={() => onMoveBy(-1)}
      onMoveDown={() => onMoveBy(1)}
    />
  ) : null;

  return (
    <li className="ct-checklist-item" data-checked={item.checked} {...sortable.itemProps(item.id)} onFocus={onFocus}>
      {layout === 'pc' && grip}
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
      {removable && <RemoveButton label={t('checklists.removeItem', { text: item.text })} onRemove={() => onRemove(id)} />}
      {layout === 'mobile' && grip}
    </li>
  );
}
