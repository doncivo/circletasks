import type { ChecklistSummary, Space } from '../../domain/model';
import type { ChecklistId } from '../../domain/types';
import { t } from '../../i18n';
import { spaceTextColor } from '../../ui';
import { ChecklistIcon } from './ChecklistIcon';

export interface ChecklistListProps {
  readonly summaries: readonly ChecklistSummary[];
  readonly selectedId: ChecklistId | null;
  readonly spaces: readonly Space[];
  /** Filtre « Tout » : l'espace de chaque checklist est indiqué (C-01 critère 5). */
  readonly showSpace: boolean;
  readonly onSelect: (id: ChecklistId) => void;
}

/**
 * Liste du volet gauche PC (PC-Checklists.html) : icône, nom et « cochés / total », la checklist affichée en carte blanche.
 * Une liste (et non un `nav`) : la coquille garde ainsi le seul repère « Navigation principale ».
 */
export function ChecklistList({ summaries, selectedId, spaces, showSpace, onSelect }: ChecklistListProps) {
  return (
    <ul className="ct-checklist-list" aria-label={t('checklists.listLabel')}>
      {summaries.map(({ checklist, checked, total }) => {
        const space = showSpace ? spaces.find((candidate) => candidate.id === checklist.spaceId) : undefined;
        const selected = checklist.id === selectedId;
        return (
          <li key={checklist.id} className="ct-checklist-list__row">
            <button
              type="button"
              className="ct-checklist-list__item"
              aria-current={selected ? 'true' : undefined}
              data-selected={selected || undefined}
              onClick={() => onSelect(checklist.id as ChecklistId)}
            >
              <ChecklistIcon icon={checklist.icon} size={28} />
              <span className="ct-checklist-list__name">{checklist.title}</span>
              {space && (
                <span className="ct-checklist-list__space" style={{ color: spaceTextColor(space.color) }}>
                  {space.name}
                </span>
              )}
              <span className="ct-checklist-list__progress">{`${String(checked)} / ${String(total)}`}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
