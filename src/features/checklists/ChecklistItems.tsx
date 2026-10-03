import type { ChecklistItem } from '../../domain/model';
import { t } from '../../i18n';

export interface ChecklistItemsProps {
  readonly items: readonly ChecklistItem[];
}

/** Items de la checklist affichée, en cartes grises (#F3F1F6) dans l'ordre manuel. */
export function ChecklistItems({ items }: ChecklistItemsProps) {
  if (items.length === 0) return null;
  return (
    <ul className="ct-checklist-items" aria-label={t('checklists.itemsLabel')}>
      {items.map((item) => (
        <li key={item.id} className="ct-checklist-item">
          <span className="ct-checklist-item__text">{item.text}</span>
        </li>
      ))}
    </ul>
  );
}
