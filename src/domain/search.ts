import type { IconRef } from './model';
import type { LocalDate, LocalTime, ProjectId, Result, SpaceId } from './types';

/**
 * Recherche plein texte (M14, RC-01) : règles pures, sans accès à la base. L'index FTS5 (`search_index`, tokeniseur
 * `unicode61 remove_diacritics 2`) est interrogé par `SearchRepository` ; ce module prépare la requête, groupe les lignes
 * renvoyées et fabrique les extraits surlignés.
 */

/** Types d'éléments cherchés, dans l'ordre des groupes de résultats (maquette Recherche.html : tâches, checklists, événements…). */
export const SEARCH_KINDS = ['task', 'checklist', 'event', 'routine', 'goal'] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

/** RC-01 critère 6 : deux caractères au moins ; critère 8 : cent résultats au plus. */
export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_LIMIT = 100;

/** État d'un résultat (sous-ligne) : tâche à faire / faite, objectif ouvert / atteint / clos, routine en pause ou archivée. */
export type SearchStatus = 'todo' | 'done' | 'open' | 'achieved' | 'closed' | 'paused' | 'archived';

/** Ligne renvoyée par `SearchRepository.query` (un élément trouvé, avant mise en forme). */
export interface SearchHit {
  readonly kind: SearchKind;
  readonly id: string;
  readonly title: string;
  /** Note d'une tâche (vide pour les autres types). */
  readonly note: string;
  /** Date de l'élément : tâche, début d'événement, date d'une checklist, lundi de la semaine d'un objectif (RC-02 : période). */
  readonly date: LocalDate | null;
  readonly time: LocalTime | null;
  readonly status: SearchStatus | null;
  readonly spaceId: SpaceId;
  readonly projectId: ProjectId | null;
  /** Tâche de la liste « Un jour » (sans date). */
  readonly someday: boolean;
  readonly icon: IconRef | null;
  /** Checklist : textes de ses items vivants ; vide sinon. */
  readonly items: readonly string[];
  readonly itemsChecked: number;
  /** Événement : 'once' | 'monthly' | 'yearly' ; null sinon. */
  readonly repeat: string | null;
}

export type SearchQueryError = 'too-short';

export interface ValidSearchQuery {
  /** Texte nettoyé (espaces de bord retirés, espaces multiples réduits), tel que tapé. */
  readonly text: string;
  /** Mots normalisés (sans accents ni majuscules). */
  readonly tokens: readonly string[];
}

/** Sans accents, en minuscules, espaces réduits : comparaison de requêtes et de mots (« Factüre » = « facture »). */
export function normalizeSearchText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase('fr')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Mots d'un texte : suites de lettres et de chiffres, normalisés (la ponctuation sépare). */
export function searchTokens(text: string): string[] {
  return normalizeSearchText(text).match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Valide la saisie : deux caractères au moins (critère 6), et au moins un mot exploitable. */
export function validateSearchQuery(raw: string): Result<ValidSearchQuery, SearchQueryError> {
  const text = raw.replace(/\s+/g, ' ').trim();
  const tokens = searchTokens(text);
  if (text.length < SEARCH_MIN_LENGTH || tokens.length === 0) return { ok: false, error: 'too-short' };
  return { ok: true, value: { text, tokens } };
}

/**
 * Expression FTS5 des mots : chaque mot entre guillemets (aucun opérateur FTS5 n'est interprété), tous requis, le dernier en préfixe
 * (critère 3 : « fact » trouve « facture »).
 */
export function buildMatchExpression(tokens: readonly string[]): string {
  return tokens.map((token, index) => `"${token}"${index === tokens.length - 1 ? '*' : ''}`).join(' ');
}

/** Un morceau de texte, surligné ou non. */
export interface TextSegment {
  readonly text: string;
  readonly match: boolean;
}

/**
 * Découpe `text` en segments : les mots qui correspondent à la requête (mot égal à un mot de la requête, ou commençant par le dernier,
 * comme la recherche) sont marqués. Le mot entier est surligné (« Factures » pour « facture »).
 */
export function highlightSegments(text: string, tokens: readonly string[]): TextSegment[] {
  const last = tokens.at(-1);
  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const found of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const word = normalizeSearchText(found[0]);
    const matches = tokens.includes(word) || (last !== undefined && word.startsWith(last));
    if (!matches) continue;
    const start = found.index ?? 0;
    if (start > cursor) segments.push({ text: text.slice(cursor, start), match: false });
    segments.push({ text: found[0], match: true });
    cursor = start + found[0].length;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false });
  return segments.length > 0 ? segments : [{ text, match: false }];
}

const hasMatch = (segments: readonly TextSegment[]): boolean => segments.some((segment) => segment.match);

/** Largeur maximale (caractères) d'un extrait de note ou d'item. */
export const EXCERPT_LENGTH = 70;

/**
 * Extrait d'un texte long autour du premier mot trouvé : ligne du mot, coupée à ~70 caractères avec « … » ; null si aucun mot de la
 * requête n'y figure (le titre seul a été trouvé).
 */
export function matchExcerpt(text: string, tokens: readonly string[], maxLength = EXCERPT_LENGTH): TextSegment[] | null {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || !hasMatch(highlightSegments(line, tokens))) continue;
    if (line.length <= maxLength) return highlightSegments(line, tokens);
    const first = highlightSegments(line, tokens).find((segment) => segment.match);
    const position = first ? line.indexOf(first.text) : 0;
    const start = Math.max(0, Math.min(position - Math.floor(maxLength / 3), line.length - maxLength));
    const cut = line.slice(start, start + maxLength).trim();
    const body = `${start > 0 ? '…' : ''}${cut}${start + maxLength < line.length ? '…' : ''}`;
    return highlightSegments(body, tokens);
  }
  return null;
}

/** Ce qui a été trouvé en dehors du titre : la note d'une tâche, ou un item de checklist. */
export interface SearchCitation {
  readonly source: 'note' | 'item';
  readonly segments: readonly TextSegment[];
}

/** Résultat mis en forme : titre surligné, citation éventuelle, données de la sous-ligne. */
export interface SearchResult {
  /** Clé stable de la ligne : « type:identifiant ». */
  readonly key: string;
  readonly hit: SearchHit;
  readonly titleSegments: readonly TextSegment[];
  readonly citation: SearchCitation | null;
}

export interface SearchGroup {
  readonly kind: SearchKind;
  readonly results: readonly SearchResult[];
}

/** Met en forme une ligne trouvée : titre surligné ; note citée si le mot y est, sinon premier item de checklist où il est. */
export function toSearchResult(hit: SearchHit, tokens: readonly string[]): SearchResult {
  const titleSegments = highlightSegments(hit.title, tokens);
  let citation: SearchCitation | null = null;
  if (hit.kind === 'task' && hit.note !== '') {
    const segments = matchExcerpt(hit.note, tokens);
    if (segments) citation = { source: 'note', segments };
  } else if (hit.kind === 'checklist') {
    for (const item of hit.items) {
      const segments = matchExcerpt(item, tokens);
      if (segments) {
        citation = { source: 'item', segments };
        break;
      }
    }
  }
  return { key: `${hit.kind}:${hit.id}`, hit, titleSegments, citation };
}

/** Groupe les résultats par type dans l'ordre de `SEARCH_KINDS` (l'ordre de pertinence est gardé dans chaque groupe) ; groupes vides omis. */
export function groupSearchResults(results: readonly SearchResult[]): SearchGroup[] {
  return SEARCH_KINDS.map((kind) => ({ kind, results: results.filter((result) => result.hit.kind === kind) })).filter((group) => group.results.length > 0);
}

/** Texte des mots surlignés recollés : titre ou extrait en clair (noms accessibles, tests). */
export const segmentsText = (segments: readonly TextSegment[]): string => segments.map((segment) => segment.text).join('');
