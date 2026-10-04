import { Undo2 } from 'lucide-react';
import { useState } from 'react';
import { FIXED_FIRST_TAB, hiddenTabs, moveTab, orderedCustomizableTabs, setTabHidden, visibleTabCount } from '../../domain/tabs';
import { t } from '../../i18n';
import { Button, DragHandle, Icon, Switch, useLayout, useSortable } from '../../ui';
import { useFeatureStore } from '../app/AppContainerContext';
import { TABS, TAB_IDS, useNavigationStore, type TabDefinition } from '../app/navigation';
import { useTabsConfigStore } from '../app/tabsConfig';
import { settingsStore } from './settingsStore';
import './TabsScreen.css';

const ALL_TABS: readonly string[] = TAB_IDS;
const TAB_BY_ID = new Map<string, TabDefinition>(TABS.map((tab) => [tab.id, tab]));

/** Valeur de la ligne Réglages › GÉNÉRAL « Onglets » : « 5 visibles ». */
export function formatTabsSummary(visible: number): string {
  return visible === 1 ? t('appearance.tabsVisibleOne', { count: visible }) : t('appearance.tabsVisible', { count: visible });
}

/** Nombre d'onglets visibles de la disposition courante, pour la ligne de Réglages. */
export function useVisibleTabCount(): number {
  const config = useTabsConfigStore((s) => s.config);
  return visibleTabCount(config, ALL_TABS);
}

/**
 * Écran « Onglets » (M12, P-01), ouvert depuis Réglages › GÉNÉRAL. Non dessiné : liste dans le style de la liste des projets
 * d'ES-04 (poignée, pastille de couleur, interrupteur « Afficher »). Tâches (Aujourd'hui) est fixe et toujours affiché ; Réglages
 * reste en bas et ne figure pas dans la liste. Réordonner : glisser la poignée (`useSortable`) ou ↑ / ↓ sur la poignée focalisée.
 */
export function TabsScreen() {
  const layout = useLayout();
  const navigate = useNavigationStore((s) => s.navigate);
  const config = useTabsConfigStore((s) => s.config);
  const errorKey = useFeatureStore(settingsStore, (s) => s.errorKey);
  const saveTabs = useFeatureStore(settingsStore, (s) => s.saveTabs);
  const resetTabs = useFeatureStore(settingsStore, (s) => s.resetTabs);
  const [announcement, setAnnouncement] = useState<{ text: string; n: number } | null>(null);

  const movable = orderedCustomizableTabs(config, ALL_TABS);
  const rows = [FIXED_FIRST_TAB, ...movable];
  const hidden = new Set(hiddenTabs(config, ALL_TABS));
  const nameOf = (id: string): string => {
    const tab = TAB_BY_ID.get(id);
    return tab ? t(tab.labelKey) : id;
  };
  const announce = (text: string): void => setAnnouncement((previous) => ({ text, n: (previous?.n ?? 0) + 1 }));

  /** `toIndex` : position dans la liste affichée (Tâches comprise, en tête) ; ramenée aux onglets modifiables. */
  function move(id: string, toIndex: number): void {
    const target = Math.min(Math.max(toIndex - 1, 0), movable.length - 1);
    const next = moveTab(config, ALL_TABS, id, target);
    if (next === config) return;
    void saveTabs(next);
    announce(t('appearance.tabsMoved', { name: nameOf(id), position: target + 2, total: rows.length }));
  }

  function step(id: string, direction: -1 | 1): void {
    const index = movable.indexOf(id);
    if (index < 0) return;
    move(id, index + 1 + direction);
  }

  const sortable = useSortable({
    ids: rows,
    isMovable: (id) => id !== FIXED_FIRST_TAB,
    onMove: move,
  });

  return (
    <div className="ct-tabs-shell" data-layout={layout}>
      <div className="ct-tabs">
        <div className="ct-tabs__topRow">
          <button type="button" className="ct-tabs__back" aria-label={t('appearance.tabsBack')} onClick={() => navigate({ tab: 'settings', screen: 'home' })}>
            <Icon icon={Undo2} size={26} />
          </button>
        </div>
        <h1 className="ct-tabs__title">{t('appearance.tabsTitle')}</h1>
        <p className="ct-tabs__hint">{t('appearance.tabsIntro')}</p>
        {errorKey && (
          <p className="ct-tabs__error" role="alert">
            {t(errorKey)}
          </p>
        )}
        <div {...sortable.containerProps} className={`ct-tabs__list ${sortable.containerProps.className}`} role="list" aria-label={t('appearance.tabsList')}>
          {rows.map((id) => {
            const tab = TAB_BY_ID.get(id);
            if (!tab) return null;
            const fixed = id === FIXED_FIRST_TAB;
            const name = nameOf(id);
            return (
              <div key={id} role="listitem" className="ct-tabs__item" {...sortable.itemProps(id)}>
                <div className="ct-tabs__row">
                  {fixed ? (
                    <span className="ct-tabs__handleSpace" aria-hidden="true" />
                  ) : (
                    <DragHandle
                      label={t('appearance.tabsHandle', { name })}
                      {...sortable.dragProps(id, 'handle')}
                      onMoveUp={() => step(id, -1)}
                      onMoveDown={() => step(id, 1)}
                    />
                  )}
                  <span className="ct-tabs__dot" style={{ background: `var(${tab.colorVar})` }} aria-hidden="true" />
                  <span className="ct-tabs__name">
                    {name}
                    {fixed && <span className="ct-tabs__always">{t('appearance.tabsAlways')}</span>}
                  </span>
                  <Switch
                    checked={fixed || !hidden.has(id)}
                    disabled={fixed}
                    label={t('appearance.tabsShow', { name })}
                    onChange={(visible) => {
                      void saveTabs(setTabHidden(config, ALL_TABS, id, !visible));
                      announce(t(visible ? 'appearance.tabsShownAnnounce' : 'appearance.tabsHiddenAnnounce', { name }));
                    }}
                  />
                </div>
              </div>
            );
          })}
        </div>
        <p className="ct-tabs__hint">{t('appearance.tabsSettingsNote')}</p>
        <Button
          variant="secondary"
          onClick={() => {
            void resetTabs();
            announce(t('appearance.tabsResetDone'));
          }}
        >
          {t('appearance.tabsReset')}
        </Button>
        <div key={announcement?.n ?? 0} className="ct-visually-hidden" aria-live="polite" aria-atomic="true">
          {announcement?.text}
        </div>
      </div>
    </div>
  );
}
