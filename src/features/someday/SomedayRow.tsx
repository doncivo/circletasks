import type { ReactNode } from 'react';
import type { Task } from '../../domain/model';
import { t } from '../../i18n';
import { Checkbox, IconView, ListRow, RemoveButton, SelectCircle, resolveIconRefColor } from '../../ui';

export interface SomedayRowProps {
  readonly task: Task;
  /** Sous-ligne « espace · projet » (déjà composée). */
  readonly subtitle: ReactNode;
  readonly iconSize: number;
  /** Vue compacte (A-06) : une ligne, espace et projet masqués. */
  readonly compact: boolean;
  /** Mode édition (A-05) : rond de sélection à la place de la case, bouton « − » et poignée. */
  readonly editMode: boolean;
  readonly selected: boolean;
  /** Ligne déployée (SD-02) ou fiche ouverte : fond #F3F1F6. */
  readonly highlighted: boolean;
  /** Poignée de déplacement ; absente si la ligne n'est pas déplaçable. */
  readonly handle: ReactNode;
  /** Ligne déployée (SD-02) : le titre annonce `aria-expanded`. */
  readonly expanded?: boolean;
  /** iPhone : poignée à droite, en mode édition (Main-Edition.html) ; PC : à gauche de la carte, toujours visible (PC-Semaine-UnJour.html). */
  readonly handlePlacement?: 'leading' | 'trailing';
  readonly onToggleDone: () => void;
  readonly onToggleSelect: () => void;
  readonly onRemove: () => void;
  readonly onActivate: () => void;
}

/**
 * Ligne de la liste « Un jour » (UnJour.html) : case, titre, sous-ligne « espace · projet » colorée. Même `ListRow`, mêmes commandes
 * d'édition que les lignes d'Aujourd'hui (A-05 : rond de sélection, « − », poignée ; A-06 : vue compacte).
 */
export function SomedayRow({ task, subtitle, iconSize, compact, editMode, selected, highlighted, handle, handlePlacement = 'trailing', expanded, onToggleDone, onToggleSelect, onRemove, onActivate }: SomedayRowProps) {
  const color = task.icon ? resolveIconRefColor(task.icon) : undefined;
  return (
    <ListRow
      title={task.title}
      selected={(editMode && selected) || highlighted}
      compact={compact}
      {...(compact ? { time: null, dotColor: color ?? 'var(--ct-color-text-secondary)' } : { subtitle })}
      leading={
        <>
          {handlePlacement === 'leading' && handle}
          {editMode ? (
            <SelectCircle selected={selected} onToggle={onToggleSelect} label={t(selected ? 'today.deselect' : 'today.select', { title: task.title })} />
          ) : (
            <Checkbox compact={compact} checked={false} onChange={onToggleDone} label={t('tasks.complete', { title: task.title })} />
          )}
        </>
      }
      icon={!compact && !editMode && task.icon ? <IconView icon={task.icon} color={color ?? 'currentColor'} size={iconSize} /> : undefined}
      trailing={
        editMode ? (
          <>
            <RemoveButton label={t('today.remove', { title: task.title })} onRemove={onRemove} />
            {handlePlacement === 'trailing' && handle}
          </>
        ) : undefined
      }
      onActivate={onActivate}
      {...(expanded !== undefined ? { expanded } : {})}
    />
  );
}
