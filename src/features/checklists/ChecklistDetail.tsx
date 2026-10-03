import { Pencil } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ChecklistProgress } from '../../domain/checklistRules';
import type { Checklist, ChecklistItem } from '../../domain/model';
import type { ChecklistId, ChecklistItemId } from '../../domain/types';
import { formatDayLabel } from '../../i18n/format';
import { t } from '../../i18n';
import { CompactToggle, ConfirmDialog, Fab, Icon, type Layout } from '../../ui';
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
  /** Mode « Réorganiser » (C-05) : l'iPhone le bascule par le bouton de sa rangée du haut, le PC par celui de l'en-tête. */
  readonly reordering: boolean;
  readonly onReorderingChange: (reordering: boolean) => void;
  readonly onToggleItem: (id: ChecklistItemId) => void;
  readonly onRenameItem: (id: ChecklistItemId, text: string) => Promise<boolean>;
  readonly onMoveItem: (id: ChecklistItemId, toIndex: number) => Promise<{ readonly position: number; readonly total: number } | null>;
  readonly onRemoveItem: (id: ChecklistItemId) => void;
  /** C-05 : après confirmation, efface les items cochés (annulable 5 s). */
  readonly onClearChecked: () => void;
  /** C-05 : décoche tous les items d'un coup (annulable 5 s). */
  readonly onUncheckAll: () => void;
  /** Id de la checklist qui doit recevoir le focus dans « Ajouter un élément » (juste après sa création, C-01 critère 2). */
  readonly focusRequest: ChecklistId | null;
  readonly onFocused: () => void;
  readonly onEdit: () => void;
  readonly onAddItem: (text: string) => Promise<boolean>;
  /** PC : bouton « Planifier un jour » (C-03) ; sur iPhone la date se règle dans la feuille « Modifier la checklist ». */
  readonly onPlan: () => void;
  readonly onClearDate: () => void;
  /** C-04 : « Dupliquer et réinitialiser » (PC : pied du détail ; iPhone : feuille Modifier). */
  readonly onDuplicate: () => void;
  /** Nom de l'espace, pour la mention « Perso · modèle réutilisable ». */
  readonly spaceName: string | null;
}

/**
 * Détail de la checklist affichée (Checklists.html, PC-Checklists.html) : icône, titre Fraunces, « Réorganiser » (PC), vue compacte,
 * crayon « Modifier la checklist », filet, progression, items en cartes grises, champ pointillé « Ajouter un élément », puis
 * « Effacer les cochés » (avec confirmation) et « Tout décocher » ; sur PC, ces boutons et ceux du jour et de la duplication sont en pied.
 */
export function ChecklistDetail({
  layout,
  checklist,
  items,
  progress,
  compact,
  onCompactChange,
  reordering,
  onReorderingChange,
  onToggleItem,
  onRenameItem,
  onMoveItem,
  onRemoveItem,
  onClearChecked,
  onUncheckAll,
  focusRequest,
  onFocused,
  onEdit,
  onAddItem,
  onPlan,
  onClearDate,
  onDuplicate,
  spaceName,
}: ChecklistDetailProps) {
  const addRef = useRef<HTMLInputElement>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const clearRef = useRef<HTMLButtonElement>(null);
  const restoreClearFocus = useRef(false);
  const pc = layout === 'pc';
  const Heading = pc ? 'h2' : 'h1';
  const hasChecked = progress.checked > 0;
  // Mentions sous la barre : « Perso · modèle réutilisable » (C-04) et jour prévu (C-03).
  const meta = [
    checklist.isTemplate ? [spaceName, t('checklists.template.mention')].filter((part) => part).join(' · ') : null,
    checklist.date ? t('checklists.date.planned', { date: formatDayLabel(checklist.date) }) : null,
  ]
    .filter((part) => part !== null)
    .join(' · ');

  useEffect(() => {
    if (focusRequest !== checklist.id) return;
    addRef.current?.focus();
    onFocused();
  }, [focusRequest, checklist.id, onFocused]);

  // Boîte de confirmation fermée : le focus revient sur « Effacer les cochés » (même si le navigateur ne focalise pas au clic).
  useEffect(() => {
    if (confirmClear || !restoreClearFocus.current) return;
    restoreClearFocus.current = false;
    clearRef.current?.focus();
  }, [confirmClear]);

  const closeConfirm = (): void => {
    restoreClearFocus.current = true;
    setConfirmClear(false);
  };

  const batchButtons = (
    <>
      <button
        ref={clearRef}
        type="button"
        className="ct-checklist-action"
        data-variant="danger"
        aria-disabled={hasChecked ? undefined : true}
        onClick={() => {
          if (hasChecked) setConfirmClear(true);
        }}
      >
        {t('checklists.actions.clearChecked')}
      </button>
      <button
        type="button"
        className="ct-checklist-action"
        aria-disabled={hasChecked ? undefined : true}
        onClick={() => {
          if (hasChecked) onUncheckAll();
        }}
      >
        {t('checklists.actions.uncheckAll')}
      </button>
    </>
  );

  return (
    <section className="ct-checklist-detail" data-layout={layout} aria-label={checklist.title}>
      <div className="ct-checklist-detail__head">
        <ChecklistIcon icon={checklist.icon} size={pc ? 44 : 40} />
        <Heading className="ct-checklist-detail__title">{checklist.title}</Heading>
        {pc && (
          <button type="button" className="ct-checklist-action" aria-pressed={reordering} onClick={() => onReorderingChange(!reordering)}>
            {t(reordering ? 'checklists.actions.reorderDone' : 'checklists.actions.reorder')}
          </button>
        )}
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
      <ChecklistItems
        items={items}
        layout={layout}
        compact={compact}
        reordering={reordering}
        onToggle={onToggleItem}
        onRename={onRenameItem}
        onMove={onMoveItem}
        onRemove={onRemoveItem}
      />
      <AddItemField inputRef={addRef} placeholder={t(pc ? 'checklists.addItemPlaceholderPc' : 'checklists.addItemPlaceholder')} onAdd={onAddItem} />
      {!pc && <div className="ct-checklist-detail__batch">{batchButtons}</div>}

      <div className="ct-checklist-detail__spacer" />
      {pc && (
        <div className="ct-checklist-detail__footer">
          {batchButtons}
          <button type="button" className="ct-checklist-action" onClick={onPlan}>
            {t('checklists.date.pick')}
          </button>
          {checklist.date && (
            <button type="button" className="ct-checklist-action" onClick={onClearDate}>
              {t('checklists.date.remove')}
            </button>
          )}
          {/* Un modèle met la duplication en avant (C-04 critère 4). */}
          <button type="button" className="ct-checklist-action" data-variant={checklist.isTemplate ? 'primary' : undefined} onClick={onDuplicate}>
            {t('checklists.template.duplicate')}
          </button>
          <span className="ct-checklist-detail__footerSpacer" />
          <Fab onClick={() => addRef.current?.focus()} label={t('common.add')} />
        </div>
      )}

      {confirmClear && (
        <ConfirmDialog
          title={progress.checked === 1 ? t('checklists.clearConfirm.titleOne') : t('checklists.clearConfirm.titleMany', { count: progress.checked })}
          description={t('checklists.clearConfirm.body')}
          confirmLabel={t('checklists.clearConfirm.confirm')}
          onCancel={closeConfirm}
          onConfirm={() => {
            closeConfirm();
            onClearChecked();
          }}
        />
      )}
    </section>
  );
}
