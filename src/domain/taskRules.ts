import type { Result, SpaceFilter, SpaceId } from './types';

/**
 * Longueur maximale d'un titre de tâche (T-01, décision 2026-10-02) : contrainte
 * technique, pas une règle fonctionnelle du PRD.
 */
export const TASK_TITLE_MAX_LENGTH = 200;

export type TaskTitleError = 'empty-title' | 'title-too-long';

/**
 * Nettoie et valide le titre d'une tâche (T-01, critères 12 à 15) : les espaces en
 * début et en fin sont retirés ; le résultat doit contenir entre 1 et
 * `TASK_TITLE_MAX_LENGTH` caractères (bornes incluses), avec un code d'erreur
 * distinct pour chaque cas (`empty-title`, `title-too-long`). Un titre identique à
 * une tâche existante est accepté (pas de dédoublonnage, critère 15) ; les accents,
 * emoji et caractères spéciaux sont conservés tels quels (critère 14).
 */
export function validateTaskTitle(raw: string): Result<string, TaskTitleError> {
  const title = raw.trim();
  if (title.length === 0) return { ok: false, error: 'empty-title' };
  if (title.length > TASK_TITLE_MAX_LENGTH) return { ok: false, error: 'title-too-long' };
  return { ok: true, value: title };
}

/**
 * Espace d'une tâche créée (ES-02, décision de la session du 2026-10-02) : l'espace
 * du filtre actif quand il vaut Pro ou Perso ; `fallbackSpaceId` (Pro, choisi par
 * l'appelant) quand le filtre vaut « Tout ». Le réglage `spaces.defaultSpaceId`
 * (ES-02 complet, mémorisation du dernier espace choisi) n'est pas encore branché :
 * cette fonction sera étendue quand ES-02 sera livrée, sans changer sa signature
 * pour les appelants qui ignorent déjà le cas « Tout ».
 */
export function resolveDefaultSpaceId(filter: SpaceFilter, fallbackSpaceId: SpaceId): SpaceId {
  return filter === 'all' ? fallbackSpaceId : filter;
}
