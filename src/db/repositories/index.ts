/**
 * Repositories : seul point d'accès à la base pour les features (CLAUDE.md).
 * Contrats : ADR 0004 et src/db/repositories/common.ts (règles communes).
 * Implémentations SQL : agent data-model, dans src/db/repositories/sql/, exposées par
 * une `RepositoryFactory` nommée `createSqlRepositories`.
 */
export * from './common';
export * from './dataAccess';
export * from './observeWrites';
export type * from './spaceRepository';
export type * from './taskRepository';
export type * from './routineRepository';
export type * from './reminderRepository';
export type * from './goalRepository';
export type * from './settingsRepository';
export type * from './agendaRepository';
export type * from './checklistRepository';
export type * from './holidayRepository';
export type * from './focusSessionRepository';
export type * from './searchRepository';
export type * from './statsRepository';
export type * from './syncRepository';
// Y-04 (début)
export type * from './syncConflictRepository';
// Y-04 (fin)
export * from './sql';
// Y-07 (début)
export type * from './syncUnknownRepository';
// Y-07 (fin)
