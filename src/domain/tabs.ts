/**
 * Onglets de la colonne (P-01) : ordre, masquage et onglet actif forcé. Les identifiants sont des chaînes (le domaine ne dépend pas
 * de la navigation) ; la disposition est un réglage local de l'appareil (`ui.tabs`).
 */
export interface TabsConfig {
  /** Identifiants dans l'ordre voulu ; un identifiant inconnu est ignoré, un onglet absent s'ajoute à la fin. */
  readonly order: readonly string[];
  /** Identifiants masqués ; un identifiant inconnu est ignoré. */
  readonly hidden: readonly string[];
}

export const DEFAULT_TABS_CONFIG: TabsConfig = { order: [], hidden: [] };

/** Onglets que la disposition ne touche jamais : Tâches (accès à Aujourd'hui) en tête, Réglages en bas (P-01 D1). */
export const FIXED_FIRST_TAB = 'tasks';
export const FIXED_LAST_TAB = 'settings';

/** Onglets modifiables : tous sauf les deux fixes, dans leur ordre par défaut. */
export function customizableTabs(allTabs: readonly string[]): string[] {
  return allTabs.filter((id) => id !== FIXED_FIRST_TAB && id !== FIXED_LAST_TAB);
}

/** Ordre complet des onglets modifiables : l'ordre enregistré (inconnus et doublons retirés), puis les onglets nouveaux à la fin. */
export function orderedCustomizableTabs(config: TabsConfig, allTabs: readonly string[]): string[] {
  const known = customizableTabs(allTabs);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of config.order) {
    if (known.includes(id) && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  for (const id of known) if (!seen.has(id)) result.push(id);
  return result;
}

/** Identifiants masqués valides (Tâches et Réglages ne se masquent jamais). */
export function hiddenTabs(config: TabsConfig, allTabs: readonly string[]): string[] {
  const known = customizableTabs(allTabs);
  return [...new Set(config.hidden)].filter((id) => known.includes(id));
}

export interface ResolvedTabs {
  /** Onglets du haut de la colonne dans l'ordre d'affichage (Tâches toujours en tête), Réglages exclu. */
  readonly rail: string[];
  /** Onglet épinglé en bas. */
  readonly last: string;
}

/**
 * Onglets affichés : Tâches en tête, puis les onglets modifiables visibles dans l'ordre voulu, Réglages en bas. Un onglet masqué
 * reste affiché tant qu'il est actif (lien depuis la recherche, « Voir la tâche », rapport) et disparaît à sa sortie (critère 7).
 */
export function resolveTabs(config: TabsConfig, allTabs: readonly string[], activeTab: string | null): ResolvedTabs {
  const hidden = new Set(hiddenTabs(config, allTabs));
  const middle = orderedCustomizableTabs(config, allTabs).filter((id) => !hidden.has(id) || id === activeTab);
  return { rail: [FIXED_FIRST_TAB, ...middle], last: FIXED_LAST_TAB };
}

/** Un onglet répond-il à son raccourci et à un appui sur la colonne ? Un onglet masqué non actif ne répond pas (critère 6). */
export function isTabAvailable(config: TabsConfig, allTabs: readonly string[], tab: string, activeTab: string | null): boolean {
  return tab === activeTab || !hiddenTabs(config, allTabs).includes(tab);
}

/** Déplace un onglet modifiable à la position `toIndex` (dans la liste des onglets modifiables). Onglet fixe ou inconnu : inchangé. */
export function moveTab(config: TabsConfig, allTabs: readonly string[], id: string, toIndex: number): TabsConfig {
  const order = orderedCustomizableTabs(config, allTabs);
  const from = order.indexOf(id);
  if (from < 0) return config;
  const target = Math.min(Math.max(toIndex, 0), order.length - 1);
  if (target === from) return config;
  order.splice(from, 1);
  order.splice(target, 0, id);
  return { order, hidden: hiddenTabs(config, allTabs) };
}

/** Masque ou rétablit un onglet modifiable. Onglet fixe ou inconnu : inchangé. */
export function setTabHidden(config: TabsConfig, allTabs: readonly string[], id: string, hidden: boolean): TabsConfig {
  if (!customizableTabs(allTabs).includes(id)) return config;
  const current = hiddenTabs(config, allTabs).filter((other) => other !== id);
  return { order: orderedCustomizableTabs(config, allTabs), hidden: hidden ? [...current, id] : current };
}

/** Nombre d’onglets listés visibles (« 5 visibles ») : Tâches et les onglets modifiables affichés ; Réglages, toujours en bas, n’est pas compté. */
export function visibleTabCount(config: TabsConfig, allTabs: readonly string[]): number {
  return 1 + customizableTabs(allTabs).length - hiddenTabs(config, allTabs).length;
}
