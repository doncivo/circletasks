import type { Migration } from '../migrator';

/**
 * Y-TECH-05 (ADR 0011 §24 point 6, §26, §28) : compte rendu du report d'époque, **local** (jamais publié : hors du catalogue de synchro
 * `SYNC_TABLES`, aucun déclencheur de capture, absent des instantanés et des journaux ; inclus dans les sauvegardes locales de la base).
 *
 * Une ligne par report établi par cet appareil : époque cible, cause, appareil qui a reporté et ouvreur, mode ; compteurs par auteur et
 * listes nommées en JSON (`src/domain/sync/epochCarryReport.ts`, libellés locaux seulement), lignes au-delà de la borne (`overflow`),
 * attribut « bandeau », `acknowledged_at` nul tant que « J'ai vu » n'a pas été appuyé. Aucune donnée existante n'est touchée.
 *
 * Numéro : 0019 (T-TECH-01, qui la réservait, n'a pas commencé ; elle prend la 0020). Texte court : le registre des migrations est dans
 * le JavaScript de départ (`docs/stories/Y-TECH-05.md`, mesure du bundle).
 */
export const migration0019EpochCarryReport: Migration = {
  version: 19,
  name: 'epoch_carry_report',
  statements: [
    "CREATE TABLE epoch_carry_report (id INTEGER PRIMARY KEY, epoch TEXT NOT NULL, cause TEXT NOT NULL CHECK (cause IN ('restore', 'concurrent', 'reset')), reporter TEXT NOT NULL, opener TEXT NOT NULL, mode TEXT NOT NULL CHECK (mode IN ('replace', 'merge')), authors TEXT NOT NULL, restored TEXT NOT NULL, recreated TEXT NOT NULL, parent_replaced TEXT NOT NULL, overflow INTEGER NOT NULL, overflow_by TEXT NOT NULL, banner INTEGER NOT NULL CHECK (banner IN (0, 1)), created_at TEXT NOT NULL, acknowledged_at TEXT)",
  ],
};
