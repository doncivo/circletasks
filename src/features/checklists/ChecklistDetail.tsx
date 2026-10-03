import { Pencil } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { ChecklistProgress } from '../../domain/checklistRules';
import type { Checklist, ChecklistItem } from '../../domain/model';
import type { ChecklistId, ChecklistItemId } from '../../domain/types';
import { formatDayLabel } from '../../i18n/format';
import { t } from '../../i18n';
import { Button, CompactToggle, Fab, Icon, type Layout } from '../../ui';
import { AddItemField } from './AddItemField';
import { ChecklistIcon } from './ChecklistIcon';
import { ChecklistItems } from './ChecklistItems';
import { ChecklistProgressBar } from './ChecklistProgressBar';

export interface ChecklistDetailProps {
  readonly layout: Layout;
  readonly checklist: Checklist;
  readonly items: readonly ChecklistItem[];
  readonly progress: ChecklistProgress;
  readonly compact: boolean;
  readonly onCompactChange: (compact: boolean) => void;
  readonly onToggleItem: (id: ChecklistItemId) => void;
  readonly onRenameItem: (id: ChecklistItemId, text: string) => Promise<boolean>;
  /** Id de la checklist qui doit recevoir le focus dans « Ajouter un élément » (juste après sa création, C-01 critère 2). */
  readonly focusRequest: ChecklistId | null;
  readonly onFocused: () => void;
  readonly onEdit: () => void;
  readonly onAddItem: (text: string) => Promise<boolean>;
  /** PC : bouton « Planifier un jour » (C-03) ; sur iPhone la date se règle dans la feuille « Modifier la checklist ». */
  readonly onPlan: () => void;
  readonly onClearDate: () => void;
}

/**
 * Détail de la checklist affichée (Checklists.html, PC-Checklists.html) : icône, titre Fraunces, crayon « Modifier la checklist »,
 * filet, items en cartes grises, champ pointillé « Ajouter un élément ».
 */
export function ChecklistDetail({ layout, checklist, items, progress, compact, onCompactChange, onToggleItem, onRenameItem, focusRequest, onFocused, onEdit, onAddItem, onPlan, onClearDate }: ChecklistDetailProps) {
  const addRef = useRef<HTMLInputElement>(null);
  const pc = layout === 'pc';
  const Heading = pc ? 'h2' : 'h1';
  // Mentions sous la barre : jour prévu (C-03).
  const meta = [checklist.date ? t('checklists.date.planned', { date: formatDayLabel(checklist.date) }) : null].filter((part) => part !== null).join(' · ');

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
        <CompactToggle active={compact} onChange={onCompactChange} label={t('checklists.compactView')} />
        <button type="button" className="ct-checklist-detail__iconButton" aria-label={t('checklists.edit')} onClick={onEdit}>
          <Icon icon={Pencil} size={24} />
        </button>
      </div>
      <div className="ct-checklist-detail__rule" aria-hidden="true">
        <div className="ct-checklist-detail__ruleAccent" />
        <div className="ct-checklist-detail__ruleLine" />
      </div>

      <ChecklistProgressBar progress={progress} {...(pc && meta ? { trailing: meta } : {})} />
      {!pc && meta && <p className="ct-checklist-detail__meta">{meta}</p>}
      <ChecklistItems items={items} compact={compact} onToggle={onToggleItem} onRename={onRenameItem} />
      <AddItemField inputRef={addRef} placeholder={t(pc ? 'checklists.addItemPlaceholderPc' : 'checklists.addItemPlaceholder')} onAdd={onAddItem} />

      <div className="ct-checklist-detail__spacer" />
      {pc && (
        <div className="ct-checklist-detail__footer">
          <Button variant="secondary" onClick={onPlan}>
            {t('checklists.date.pick')}
          </Button>
          {checklist.date && (
            <Button variant="secondary" onClick={onClearDate}>
              {t('checklists.date.remove')}
            </Button>
          )}
          <span className="ct-checklist-detail__footerSpacer" />
          <Fab onClick={() => addRef.current?.focus()} label={t('common.add')} />
        </div>
      )}
    </section>
  );
}
