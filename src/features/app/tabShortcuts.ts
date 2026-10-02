import { TABS, useNavigationStore, type TabId } from './navigation';
import type { ShortcutRegistry } from './shortcuts';

/**
 * Une feuille ou une fenêtre modale est-elle ouverte ? (feuille « Nouvelle tâche », fiche iPhone, confirmations)
 * Les panneaux non modaux (fiche détail PC) ne comptent pas.
 */
export function isModalOpen(root: ParentNode = document): boolean {
  return root.querySelector('[aria-modal="true"]') !== null;
}

/**
 * A-04 : Alt+1 à Alt+6 activent les onglets (registre de raccourcis, ADR 0004). Portée Application : le
 * raccourci fonctionne même dans un champ de saisie, sans y insérer de caractère (le registre compare
 * \`event.code\`, donc aussi sur un clavier AZERTY où Alt+1 produit « & »). « Tâches » ramène toujours à
 * Aujourd'hui du jour courant (`goToTab`, Q10), fiche détail comprise.
 *
 * Tant qu'une feuille ou une fenêtre modale est ouverte, le raccourci est ignoré : elle peut contenir une
 * saisie en cours, qu'un changement d'onglet perdrait en silence (A-04 critère 5).
 *
 * Renvoie la fonction qui retire les six raccourcis.
 */
export function registerTabShortcuts(registry: ShortcutRegistry, modalOpen: () => boolean = isModalOpen): () => void {
  const offs = TABS.map((tab) =>
    registry.register(tab.shortcut, () => {
      if (modalOpen()) return;
      useNavigationStore.getState().goToTab(tab.id as TabId);
    }),
  );
  return () => {
    for (const off of offs) off();
  };
}
