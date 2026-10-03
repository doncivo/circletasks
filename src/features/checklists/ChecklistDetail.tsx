import { Pencil } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { Checklist, ChecklistItem } from '../../domain/model';
import type { ChecklistId } from '../../domain/types';
import { t } from '../../i18n';
import { Fab, Icon, type Layout } from '../../ui';
import { AddItemField } from './AddItemField';
import { ChecklistIcon } from './ChecklistIcon';
import { ChecklistItems } from './ChecklistItems';

export interface ChecklistDetailProps {
  readonly layout: Layout;
  readonly checklist: Checklist;
  readonly items: readonly ChecklistItem[];
  /** Id de la checklist qui doit recevoir le focus dans « Ajouter un élément » (juste après sa création, C-01 critère 2). */
  readonly focusRequest: ChecklistId | null;
  readonly onFocused: () => void;
  readonly onEdit: () => void;
  readonly onAddItem: (text: string) => Promise<boolean>;
}

/**
 * Détail de la checklist affichée (Checklists.html, PC-Checklists.html) : icône, titre Fraunces, crayon « Modifier la checklist »,
 * filet, items en cartes grises, champ pointillé « Ajouter un élément ».
 */
export function ChecklistDetail({ layout, checklist, items, focusRequest, onFocused, onEdit, onAddItem }: ChecklistDetailProps) {
  const addRef = useRef<HTMLInputElement>(null);
  const pc = layout === 'pc';
  const Heading = pc ? 'h2' : 'h1';

  useEffect(() => {
    if (focusRequest !== checklist.id) return;
    addRef.current?.focus();
    onFocused();
  }, [focusRequest, checklist.id, onFocused]);

  return (
    <section className="ct-checklist-detail" data-layout={layout} aria-label={checklist.title}>
      <div className="ct-checklist-detail__head">
        <ChecklistIcon icon={checklist.icon} size={pc ? 44 : 40} />
        <Heading className="ct-checklist-detail__title">{checklist.title}</Heading>
        <button type="button" className="ct-checklist-detail__iconButton" aria-label={t('checklists.edit')} onClick={onEdit}>
          <Icon icon={Pencil} size={24} />
        </button>
      </div>
      <div className="ct-checklist-detail__rule" aria-hidden="true">
        <div className="ct-checklist-detail__ruleAccent" />
        <div className="ct-checklist-detail__ruleLine" />
      </div>

      <ChecklistItems items={items} />
      <AddItemField inputRef={addRef} placeholder={t(pc ? 'checklists.addItemPlaceholderPc' : 'checklists.addItemPlaceholder')} onAdd={onAddItem} />

      <div className="ct-checklist-detail__spacer" />
      {pc && (
        <div className="ct-checklist-detail__footer">
          <Fab onClick={() => addRef.current?.focus()} label={t('common.add')} />
        </div>
      )}
    </section>
  );
}
