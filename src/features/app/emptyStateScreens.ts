/**
 * Registre unique des écrans à liste qui affichent un `EmptyState` (P-06 D2). Un nouvel écran à liste s'ajoute ici : le test
 * `emptyStateScreens.test.ts` échoue si un `<EmptyState screen="...">` du code n'est pas listé (ou l'inverse), et le balayage
 * `tests/e2e/P-06.spec.ts` ouvre chaque écran sur base vide.
 */
export interface EmptyStateScreen {
  /** Valeur de la propriété `screen` de l'`EmptyState` (attribut `data-empty-screen`). */
  readonly id: string;
  /** Texte de l'action principale (clé i18n résolue par le test de balayage). */
  readonly actionKey: 'empty.addTask' | 'empty.createRoutine' | 'empty.addEvent' | 'empty.createChecklist' | 'empty.addSomeday' | 'empty.goToToday' | 'empty.openRoutines';
}

export const emptyStateScreens: readonly EmptyStateScreen[] = [
  { id: 'today', actionKey: 'empty.addTask' },
  { id: 'week', actionKey: 'empty.addTask' },
  { id: 'routines', actionKey: 'empty.createRoutine' },
  { id: 'routinesMonth', actionKey: 'empty.openRoutines' },
  { id: 'events', actionKey: 'empty.addEvent' },
  { id: 'checklists', actionKey: 'empty.createChecklist' },
  { id: 'someday', actionKey: 'empty.addSomeday' },
  { id: 'done', actionKey: 'empty.goToToday' },
  { id: 'trash', actionKey: 'empty.goToToday' },
];

/**
 * Écrans à liste dont l'état vide reste celui de leur story, déjà conforme à sa maquette (P-06 critère 1) : objectif (OB-01, brouillon
 * d'objectif avec son aide), recherche (RC-01, « Aucun résultat pour … »), agendas (K-01, boutons de connexion juste dessous),
 * projets d'un espace (ES-04, bouton « + Ajouter un projet » sous la phrase). Rapport du mois : H-01 pas encore construit.
 */
export const emptyStateExemptions: readonly string[] = ['goals', 'search', 'calendars', 'projects', 'report'];
