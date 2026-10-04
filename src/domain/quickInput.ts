import { foldKeepLength, naturalDate, removeHits, type Hit, type NaturalDate, type NaturalNow } from './naturalDate';
import type { Project, Space } from './model';
import type { LocalDate, LocalTime, ProjectId, SpaceId } from './types';
import type { FirstWeekday } from './week';

/**
 * Saisie rapide (Q-06, Q-02) : un seul passage sur le texte tapé. « Relancer client demain 9h #pro @mission » donne le titre
 * « Relancer client », la date de demain à 09:00, l'espace Pro et le projet Mission. Fonctions pures.
 *
 * Marques : « #espace » et « @projet » ne comptent qu'entre espaces ou en début / fin de saisie (« a#b » et « mail@site.fr » restent du
 * texte) ; le nom comparé est le nom réel de l'espace ou du projet, sans accents ni casse (un nom de plusieurs mots est reconnu :
 * « @mon projet »). Un mot inconnu reste dans le titre, sans erreur. Plusieurs « # » (ou « @ ») : le dernier reconnu gagne.
 * Projet : actif seulement, dans l'espace des « # » s'il y en a (sinon « Projet inconnu dans <espace> », le texte reste) ; sans espace
 * écrit, l'espace du projet ; plusieurs projets du même nom : celui de l'espace par défaut, sinon le premier par ordre d'espace.
 * Un titre qui deviendrait vide donne un titre vide (la création est refusée comme en T-01) ; si seule la date viderait le titre
 * (« demain 10h »), le texte entier reste le titre et aucune date n'est posée.
 */

export type QuickSpace = Pick<Space, 'id' | 'name' | 'sortOrder'> & Partial<Pick<Space, 'color'>>;
export type QuickProject = Pick<Project, 'id' | 'spaceId' | 'name' | 'archived' | 'sortOrder'> & Partial<Pick<Project, 'deletedAt' | 'color'>>;

export interface QuickContext {
  readonly spaces: readonly QuickSpace[];
  readonly projects: readonly QuickProject[];
  /** Espace par défaut (ES-02) : départage les projets de même nom. */
  readonly defaultSpaceId: SpaceId | null;
  /** « Maintenant » en heure locale de l'appareil ; absent : aucune date n'est cherchée. */
  readonly now?: NaturalNow;
  readonly firstWeekday?: FirstWeekday;
  /** Faux : seules les marques sont lues (écran « Un jour », date réglée à la main dans la feuille). Défaut : vrai. */
  readonly dates?: boolean;
}

export type QuickTokenKind = 'space' | 'project' | 'date';

/** Ce qui a été reconnu, pour la pastille d'aperçu. `key` identifie la marque pour la retirer (`ignored`). */
export interface QuickToken {
  readonly kind: QuickTokenKind;
  readonly raw: string;
  readonly key: string;
  readonly spaceId?: SpaceId;
  readonly projectId?: ProjectId;
}

export interface QuickParse {
  /** Titre sans les marques ni la date ; vide si rien ne reste. */
  readonly title: string;
  /** Espace écrit (« #pro ») ou celui du projet écrit ; null : aucun, l'appelant applique `defaultSpaceFor`. */
  readonly spaceId: SpaceId | null;
  readonly projectId: ProjectId | null;
  /** Une marque « # » est écrite (l'espace ne vient pas du seul projet). */
  readonly spaceWritten: boolean;
  /** « @xxx » écrit sans projet de ce nom dans l'espace écrit (critère 5) ; le mot reste dans le titre. */
  readonly unknownProject: { readonly name: string; readonly spaceId: SpaceId } | null;
  readonly date: LocalDate | null;
  readonly time: LocalTime | null;
  readonly dateRange: NaturalDate['dateRange'];
  /** Un mot de date est écrit ; faux : la date vient d'une heure seule (aujourd'hui ou demain) et un écran qui a son propre jour le garde. */
  readonly dateWritten: boolean;
  readonly tokens: readonly QuickToken[];
  readonly natural: NaturalDate | null;
}

export const tokenKey = (kind: QuickTokenKind, raw: string): string => `${kind}:${raw.toLowerCase()}`;

/** Nom comparable : sans accents ni casse, tirets et soulignés comme espaces. */
export function foldName(name: string): string {
  return foldKeepLength(name).replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const MAX_NAME_WORDS = 4;
const TRAILING_PUNCTUATION = /[,;:!?.)\]]+$/;

interface Mark {
  readonly char: '#' | '@';
  readonly start: number;
  readonly end: number;
  readonly name: string;
  readonly spaceId?: SpaceId;
  readonly projects?: readonly QuickProject[];
}

function isActive(project: QuickProject): boolean {
  return !project.archived && (project.deletedAt ?? null) === null;
}

/** Marques « # » et « @ » du texte reconnues contre les noms réels, dans l'ordre d'écriture. */
function findMarks(text: string, context: QuickContext): { marks: Mark[]; unknown: Mark[] } {
  const marks: Mark[] = [];
  const unknown: Mark[] = [];
  const active = context.projects.filter(isActive);
  const re = /(?<!\S)([#@])(?=\S)/g;
  let cursor = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index < cursor) continue;
    const char = m[1] as '#' | '@';
    const from = m.index + 1;
    const words = [...text.slice(from).matchAll(/\S+/g)].slice(0, MAX_NAME_WORDS);
    // Mot suivant une autre marque : n'appartient pas au nom.
    const usable: { text: string; end: number }[] = [];
    for (const word of words) {
      if (word[0].startsWith('#') || word[0].startsWith('@')) break;
      usable.push({ text: word[0], end: from + (word.index ?? 0) + word[0].length });
    }
    let found: Mark | null = null;
    for (let k = usable.length; k >= 1 && !found; k -= 1) {
      const slice = usable.slice(0, k);
      const last = slice[k - 1];
      if (!last) continue;
      const raw = text.slice(from, last.end);
      const stripped = raw.replace(TRAILING_PUNCTUATION, '');
      for (const candidate of stripped === raw ? [raw] : [raw, stripped]) {
        if (candidate === '') continue;
        const folded = foldName(candidate);
        const end = from + candidate.length;
        if (char === '#') {
          const space = context.spaces.find((s) => foldName(s.name) === folded);
          if (space) found = { char, start: m.index, end, name: candidate, spaceId: space.id };
        } else {
          const matching = active.filter((p) => foldName(p.name) === folded);
          if (matching.length > 0) found = { char, start: m.index, end, name: candidate, projects: matching };
        }
        if (found) break;
      }
    }
    if (found) {
      marks.push(found);
      cursor = found.end;
    } else {
      // Inconnu : reste du texte ; un « @mot » sert au signalement du critère 5.
      const word = words[0];
      if (word && char === '@') unknown.push({ char, start: m.index, end: from + (word.index ?? 0) + word[0].length, name: word[0].replace(TRAILING_PUNCTUATION, '') });
    }
  }
  return { marks, unknown };
}

function spaceOrder(context: QuickContext): Map<SpaceId, number> {
  return new Map(context.spaces.map((space) => [space.id, space.sortOrder]));
}

/** Choisit un projet parmi des projets de même nom (critère 4). */
function pickProject(candidates: readonly QuickProject[], context: QuickContext): QuickProject | null {
  const order = spaceOrder(context);
  const sorted = [...candidates].sort((a, b) => (order.get(a.spaceId) ?? 0) - (order.get(b.spaceId) ?? 0) || a.sortOrder - b.sortOrder);
  return sorted.find((project) => project.spaceId === context.defaultSpaceId) ?? sorted[0] ?? null;
}

export interface ParseQuickOptions {
  /** Marques retirées par l'utilisateur (clés `tokenKey`) : elles redeviennent du texte. */
  readonly ignored?: ReadonlySet<string>;
}

/** Analyse la saisie : titre, espace, projet, date et heure (Q-06, Q-02). Texte vide : tout est vide. */
export function parseQuickInput(text: string, context: QuickContext, options: ParseQuickOptions = {}): QuickParse {
  const ignored = options.ignored ?? new Set<string>();
  const found = findMarks(text, context);
  const marks = found.marks.filter((mark) => !ignored.has(tokenKey(mark.char === '#' ? 'space' : 'project', text.slice(mark.start, mark.end))));
  const tokens: QuickToken[] = [];
  const hits: Hit[] = [];

  // Espace : le dernier « # » reconnu gagne.
  const spaceMarks = marks.filter((mark) => mark.char === '#');
  const lastSpace = spaceMarks[spaceMarks.length - 1];
  const spaceId: SpaceId | null = lastSpace?.spaceId ?? null;
  for (const mark of spaceMarks) hits.push({ start: mark.start, end: mark.end, plain: true });
  if (lastSpace?.spaceId) tokens.push({ kind: 'space', raw: text.slice(lastSpace.start, lastSpace.end), key: tokenKey('space', text.slice(lastSpace.start, lastSpace.end)), spaceId: lastSpace.spaceId });

  // Projet : le dernier « @ » reconnu dans l'espace écrit gagne ; sans espace écrit, il donne l'espace.
  let projectId: ProjectId | null = null;
  let resolvedSpace: SpaceId | null = spaceId;
  let unknownProject: QuickParse['unknownProject'] = null;
  let projectMark: Mark | null = null;
  let project: QuickProject | null = null;
  for (const mark of marks.filter((m) => m.char === '@')) {
    const candidates = (mark.projects ?? []).filter((p) => spaceId === null || p.spaceId === spaceId);
    const picked = pickProject(candidates, context);
    if (picked) {
      projectMark = mark;
      project = picked;
      hits.push({ start: mark.start, end: mark.end, plain: true });
    } else if (spaceId !== null) {
      unknownProject = { name: text.slice(mark.start + 1, mark.end), spaceId };
    }
  }
  if (spaceId !== null && unknownProject === null && projectMark === null) {
    const stray = found.unknown[found.unknown.length - 1];
    if (stray) unknownProject = { name: stray.name.replace(/^@/, ''), spaceId };
  }
  if (projectMark && project) {
    projectId = project.id;
    resolvedSpace = project.spaceId;
    const raw = text.slice(projectMark.start, projectMark.end);
    tokens.push({ kind: 'project', raw, key: tokenKey('project', raw), projectId: project.id, spaceId: project.spaceId });
  }

  const withoutMarks = removeHits(text, hits);
  if (withoutMarks === '') {
    return { title: '', spaceId: resolvedSpace, projectId, spaceWritten: spaceId !== null, unknownProject, date: null, time: null, dateRange: null, dateWritten: false, tokens, natural: null };
  }

  let natural = context.dates === false || !context.now ? null : naturalDate(text, context.now, context.firstWeekday ? { firstWeekday: context.firstWeekday } : {}, hits);
  let dateToken: QuickToken | null = null;
  if (natural) {
    const raw = natural.spans.map((span) => text.slice(span.start, span.end).trim()).join(' ');
    const key = tokenKey('date', raw);
    if (ignored.has(key)) natural = null;
    else dateToken = { kind: 'date', raw, key };
  }
  let title = natural ? removeHits(text, [...hits, ...natural.spans]) : withoutMarks;
  if (title === '') {
    // Seule la date viderait le titre : le texte entier reste le titre, sans date (Q-02 critère 8).
    title = withoutMarks;
    natural = null;
    dateToken = null;
  }
  if (dateToken) tokens.push(dateToken);
  return {
    title,
    spaceId: resolvedSpace,
    projectId,
    spaceWritten: spaceId !== null,
    unknownProject,
    date: natural?.date ?? null,
    time: natural?.time ?? null,
    dateRange: natural?.dateRange ?? null,
    dateWritten: natural?.dateWritten ?? false,
    tokens,
    natural,
  };
}

// --- Suggestions à la frappe ---

export interface QuickSuggestionItem {
  /** Identifiant d'option (stable pour `aria-activedescendant`). */
  readonly id: string;
  readonly label: string;
  readonly color: string | null;
  /** Projet : espace du projet (affiché en petit quand plusieurs espaces sont possibles). */
  readonly spaceName: string | null;
  readonly spaceId: SpaceId;
}

export interface QuickSuggestions {
  readonly kind: 'space' | 'project';
  /** Indice de la marque, et fin du mot en cours de frappe (la position du curseur). */
  readonly start: number;
  readonly end: number;
  readonly query: string;
  readonly items: readonly QuickSuggestionItem[];
}

const MAX_SUGGESTIONS = 8;

/**
 * Suggestions pour la marque en cours de frappe juste avant `caret` : espaces après « # », projets actifs après « @ » (ceux de
 * l'espace déjà écrit, sinon de tous les espaces). `null` : pas de marque en cours ou rien à proposer.
 */
export function quickSuggestions(text: string, caret: number, context: QuickContext): QuickSuggestions | null {
  const before = text.slice(0, caret);
  const m = /(?<!\S)([#@])([^#@\n]{0,40})$/.exec(before);
  if (!m) return null;
  const kind = m[1] === '#' ? 'space' : 'project';
  const query = m[2] ?? '';
  if (/\s$/.test(query)) return null; // le mot est fini
  const folded = foldName(query);
  const start = m.index;
  let items: QuickSuggestionItem[];
  if (kind === 'space') {
    items = [...context.spaces]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .filter((space) => foldName(space.name).startsWith(folded))
      .map((space) => ({ id: `space-${space.id}`, label: space.name, color: space.color ?? null, spaceName: null, spaceId: space.id }));
  } else {
    // Espace déjà écrit ailleurs dans la saisie (la marque en cours est mise de côté).
    const other = text.slice(0, start) + ' ' + text.slice(caret);
    const written = parseQuickInput(other, { spaces: context.spaces, projects: context.projects, defaultSpaceId: context.defaultSpaceId, dates: false }).spaceId;
    const spaceNames = new Map(context.spaces.map((space) => [space.id, space]));
    const order = spaceOrder(context);
    items = context.projects
      .filter(isActive)
      .filter((project) => (written === null || project.spaceId === written) && foldName(project.name).startsWith(folded))
      .sort((a, b) => (order.get(a.spaceId) ?? 0) - (order.get(b.spaceId) ?? 0) || a.sortOrder - b.sortOrder)
      .map((project) => ({
        id: `project-${project.id}`,
        label: project.name,
        color: project.color ?? spaceNames.get(project.spaceId)?.color ?? null,
        spaceName: written === null ? (spaceNames.get(project.spaceId)?.name ?? null) : null,
        spaceId: project.spaceId,
      }));
  }
  if (items.length === 0) return null;
  return { kind, start, end: caret, query, items: items.slice(0, MAX_SUGGESTIONS) };
}

/** Complète la marque en cours avec la suggestion choisie ; rend le nouveau texte et la position du curseur. */
export function applySuggestion(text: string, suggestions: QuickSuggestions, item: QuickSuggestionItem): { text: string; caret: number } {
  const mark = suggestions.kind === 'space' ? '#' : '@';
  const rest = text.slice(suggestions.end);
  const insert = `${mark}${item.label}${/^\s/.test(rest) ? '' : ' '}`;
  const next = text.slice(0, suggestions.start) + insert + rest;
  return { text: next, caret: suggestions.start + insert.length + (/^\s/.test(rest) ? 1 : 0) };
}
