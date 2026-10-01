/**
 * Repositories : seul point d'accès à la base pour les features (CLAUDE.md).
 * Chaque repository reçoit un `SqlExecutor` (driver ou transaction), convertit les
 * lignes snake_case en entités du domaine et ne contient aucune règle métier.
 * Premiers repositories : agent data-model, ordre 1.
 */
export {};
