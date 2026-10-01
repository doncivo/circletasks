import { useRef } from 'react';
import { t, type PlainMessageKey } from '../i18n';
import { useLayout } from './useLayout';
import './TabRail.css';

/**
 * Forme structurelle de `TabDefinition` (src/features/app/navigation.ts) : la
 * feature passe `TABS` directement (sous-ensemble compatible), sans que
 * `src/ui` importe `src/features` (frontière de couches, ADR 0001).
 */
export interface TabRailItem {
  readonly id: string;
  readonly labelKey: PlainMessageKey;
  /** Variable CSS de la couleur de l'onglet (src/ui/theme/tokens.css). */
  readonly colorVar: string;
}

export interface TabRailProps {
  /** Onglets du haut, dans l'ordre d'affichage. */
  items: readonly TabRailItem[];
  /** Onglet épinglé en bas (Réglages), séparé par un espace extensible. */
  settingsItem: TabRailItem;
  activeId: string;
  onSelect: (id: string) => void;
  className?: string;
}

const SIZES = {
  pc: { width: 72, tabHeight: 118 },
  mobile: { width: 64, tabHeight: 112 },
};

/**
 * Colonne d'onglets verticaux colorés (PRD section 5, A-04), fond `--ct-color-nav-bg`.
 * L'onglet actif passe en fond clair/sombre selon le thème ; les autres gardent
 * leur teinte pastel, texte toujours foncé (`--ct-color-tab-text`).
 *
 * @example
 * <TabRail
 *   items={TABS.filter((tab) => tab.id !== 'settings')}
 *   settingsItem={TABS.find((tab) => tab.id === 'settings')!}
 *   activeId={route.tab}
 *   onSelect={goToTab}
 * />
 */
export function TabRail({ items, settingsItem, activeId, onSelect, className }: TabRailProps) {
  const layout = useLayout();
  const size = SIZES[layout];
  const allItems = [...items, settingsItem];
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowDown') nextIndex = (index + 1) % allItems.length;
    else if (event.key === 'ArrowUp') nextIndex = (index - 1 + allItems.length) % allItems.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = allItems.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const target = allItems[nextIndex];
    if (target) refs.current[target.id]?.focus();
  };

  const renderTab = (item: TabRailItem, index: number) => {
    const active = item.id === activeId;
    return (
      <button
        key={item.id}
        type="button"
        ref={(el) => {
          refs.current[item.id] = el;
        }}
        aria-current={active ? 'page' : undefined}
        onClick={() => onSelect(item.id)}
        onKeyDown={(event) => handleKeyDown(event, index)}
        className="ct-tab-rail__tab"
        style={{
          height: size.tabHeight,
          marginRight: active ? 0 : layout === 'pc' ? 8 : 6,
          background: active ? 'var(--ct-color-tab-active-bg)' : `var(${item.colorVar})`,
          color: active ? 'var(--ct-color-text)' : 'var(--ct-color-tab-text)',
        }}
      >
        <span className="ct-tab-rail__label">{t(item.labelKey)}</span>
      </button>
    );
  };

  return (
    <nav
      aria-label={t('nav.primaryLabel')}
      data-layout={layout}
      className={['ct-tab-rail', className].filter(Boolean).join(' ')}
      style={{ width: size.width }}
    >
      {items.map((item, index) => renderTab(item, index))}
      <div className="ct-tab-rail__spacer" />
      {renderTab(settingsItem, allItems.length - 1)}
    </nav>
  );
}
