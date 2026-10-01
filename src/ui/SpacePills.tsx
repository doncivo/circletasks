import type { HexColor, SpaceFilter, SpaceId } from '../domain/types';
import { t } from '../i18n';

import './SpacePills.css';

export interface SpacePillItem {
  readonly id: SpaceId;
  /** Nom de l'espace, donnée utilisateur (ex. « Pro », « Perso »). */
  readonly name: string;
  readonly color: HexColor;
}

export interface SpacePillsProps {
  /** Espaces de l'utilisateur, dans l'ordre d'affichage (M13). */
  items: readonly SpacePillItem[];
  value: SpaceFilter;
  onChange: (value: SpaceFilter) => void;
  className?: string;
}

/**
 * Pastilles de filtre Pro / Perso / Tout (CLAUDE.md : filtre présent partout).
 *
 * @example
 * <SpacePills items={spaces} value={spaceFilter} onChange={setSpaceFilter} />
 */
export function SpacePills({ items, value, onChange, className }: SpacePillsProps) {
  return (
    <div role="group" aria-label={t('spaces.filterLabel')} className={['ct-space-pills', className].filter(Boolean).join(' ')}>
      {items.map((item) => {
        const active = value === item.id;
        return (
          <button
            key={item.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(item.id)}
            className="ct-space-pills__pill"
            style={
              active
                ? { background: item.color, borderColor: item.color, color: 'var(--ct-color-accent-on)' }
                : { borderColor: item.color, color: item.color }
            }
          >
            {item.name}
          </button>
        );
      })}
      <button
        type="button"
        aria-pressed={value === 'all'}
        onClick={() => onChange('all')}
        className="ct-space-pills__pill"
        style={
          value === 'all'
            ? { background: 'var(--ct-color-text)', borderColor: 'var(--ct-color-text)', color: 'var(--ct-color-tab-active-bg)' }
            : { borderColor: 'var(--ct-color-text)', color: 'var(--ct-color-text)' }
        }
      >
        {t('spaces.all')}
      </button>
    </div>
  );
}
