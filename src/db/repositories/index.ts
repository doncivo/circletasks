/**
 * Repositories : seul point d'accès à la base pour les features (CLAUDE.md).
 * Contrats : ADR 0004 et src/db/repositories/common.ts (règles communes).
 * Implémentations SQL : agent data-model, dans src/db/repositories/sql/, exposées par
 * une `RepositoryFactory` nommée `createSqlRepositories`.
 */
export * from './common';
export * from './dataAccess';
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
export * from './sql';
