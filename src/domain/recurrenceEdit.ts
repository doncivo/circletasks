import { encodeIcon, parseIcon, type RecurrenceFields, type SeriesTemplate, type Task, type TaskPatch } from './model';
import { isId, isLocalDate, isLocalTime, type Result } from './types';

/**
 * Modification d'une occurrence récurrente (T-10). Fonctions pures.
 *
 * Modèle (PRD 6 : une récurrence ne stocke que l'occurrence en cours) :
 * - les valeurs de la série (titre, note, icône, heure, espace, projet) sont celles de l'occurrence
 *   courante : l'occurrence suivante les reprend (`buildNextOccurrence`) ;
 * - « Toutes les suivantes » : l'occurrence courante change et redevient la référence de la série
 *   (`seriesTemplate` effacé) ; les occurrences passées ou terminées ne sont pas touchées ;
 * - « Cette occurrence » : l'occurrence change et garde dans `seriesTemplate` les valeurs de la série
 *   d'avant, y compris sa date prévue (déplacer une occurrence ne décale pas la série) ; la suivante
 *   est générée avec ces valeurs (`seriesSourceOf`).
 */
export type SeriesScope = 'occurrence' | 'following';

/** Champs d'une occurrence qui appartiennent aux valeurs de la série. */
export const SERIES_VALUE_FIELDS = ['title', 'note', 'icon', 'time', 'spaceId', 'projectId'] as const;
export type SeriesValueField = (typeof SERIES_VALUE_FIELDS)[number];
export type SeriesField = SeriesValueField | 'date';

const sameIcon = (a: Task['icon'], b: Task['icon']): boolean => (a === null || b === null ? a === b : encodeIcon(a) === encodeIcon(b));

/** Champs de la série réellement modifiés par `patch` (valeur différente de celle de la tâche). */
export function changedSeriesFields(task: Task, patch: TaskPatch): readonly SeriesField[] {
  const changed: SeriesField[] = [];
  if (patch.title !== undefined && patch.title !== task.title) changed.push('title');
  if (patch.note !== undefined && patch.note !== task.note) changed.push('note');
  if (patch.icon !== undefined && !sameIcon(patch.icon, task.icon)) changed.push('icon');
  if (patch.time !== undefined && patch.time !== task.time) changed.push('time');
  if (patch.spaceId !== undefined && patch.spaceId !== task.spaceId) changed.push('spaceId');
  if (patch.projectId !== undefined && patch.projectId !== task.projectId) changed.push('projectId');
  if (patch.date !== undefined && patch.date !== task.date) changed.push('date');
  return changed;
}

/**
 * Choix à proposer pour modifier une occurrence (critères 1 et 4) : « Cette occurrence » et
 * « Toutes les suivantes » si `patch` change une valeur de la série ou la date ; aucun choix
 * (liste vide) sinon : la modification s'applique sans question.
 */
export function scopeChoicesForEdit(task: Task, patch: TaskPatch): readonly SeriesScope[] {
  if (task.recurrenceId === null || changedSeriesFields(task, patch).length === 0) return [];
  return ['occurrence', 'following'];
}

/** Choix proposés pour modifier la RÈGLE (fréquence, jours, fin) : « Toutes les suivantes » seulement (critère 4). */
export const RULE_EDIT_SCOPES: readonly SeriesScope[] = ['following'];

/** Choix proposés pour supprimer une occurrence (critère 7). */
export const DELETE_SCOPES: readonly SeriesScope[] = ['occurrence', 'following'];

function snapshotOf(task: Task): SeriesTemplate {
  return { title: task.title, note: task.note, icon: task.icon, time: task.time, spaceId: task.spaceId, projectId: task.projectId, date: task.date };
}

/**
 * `seriesTemplate` à écrire sur l'occurrence modifiée « cette occurrence » : les valeurs de la série
 * d'avant la modification, date prévue comprise. Une occurrence déjà détachée garde ses valeurs
 * d'origine (une seconde modification ne les écrase pas).
 */
export function divergedTemplate(task: Task): SeriesTemplate {
  return task.seriesTemplate ?? snapshotOf(task);
}

/** Parties du patch qui sont des valeurs de la série (hors date, propre à chaque occurrence). */
export function seriesValuesPatch(patch: TaskPatch): TaskPatch {
  const out: { -readonly [K in keyof TaskPatch]: TaskPatch[K] } = {};
  if (patch.title !== undefined) out.title = patch.title;
  if (patch.note !== undefined) out.note = patch.note;
  if (patch.icon !== undefined) out.icon = patch.icon;
  if (patch.time !== undefined) out.time = patch.time;
  if (patch.spaceId !== undefined) out.spaceId = patch.spaceId;
  if (patch.projectId !== undefined) out.projectId = patch.projectId;
  return out;
}

/**
 * Occurrence « de référence » dont l'occurrence suivante est construite : les valeurs de
 * `seriesTemplate` si l'occurrence s'en écarte, sinon l'occurrence elle-même. La `date` n'est
 * pas remplacée (la suivante est calculée depuis `seriesAnchorDate`).
 */
export function seriesSourceOf(task: Task): Task {
  const t = task.seriesTemplate;
  if (t === null) return task;
  return { ...task, title: t.title, note: t.note, icon: t.icon, time: t.time, spaceId: t.spaceId, projectId: t.projectId };
}

/** Date prévue d'origine d'où la suivante est calculée : celle de la série si l'occurrence a été déplacée. */
export function seriesAnchorDate(task: Pick<Task, 'date' | 'seriesTemplate'>): Task['date'] {
  return task.seriesTemplate?.date ?? task.date;
}

/** Colonnes qui font d'une occurrence une tâche simple (arrêt de la répétition, critère 6). */
export const DETACH_FROM_SERIES: TaskPatch = { recurrenceId: null, seriesIndex: null, seriesTemplate: null };

/** La règle a-t-elle changé (fréquence, jours, fin…) ? */
export function ruleChanged(a: RecurrenceFields, b: RecurrenceFields): boolean {
  return (
    a.freq !== b.freq ||
    a.interval !== b.interval ||
    a.monthDay !== b.monthDay ||
    a.until !== b.until ||
    a.count !== b.count ||
    a.weekdays.join(',') !== b.weekdays.join(',') ||
    a.nthWeekday?.nth !== b.nthWeekday?.nth ||
    a.nthWeekday?.weekday !== b.nthWeekday?.weekday
  );
}

/** Pourquoi un `series_template` lu en base est refusé (données futures, synchro, corruption). */
export type SeriesTemplateError = 'invalid_json' | 'invalid_shape' | 'invalid_field';

/**
 * Décode et valide le JSON de `task.series_template`. Le contenu peut venir d'une autre version ou
 * d'un autre appareil (synchro, ordre 4) : chaque champ est vérifié (titre non vide, identifiants,
 * date et heure valides, icône du catalogue). Refus : l'appelant retombe sur « pas d'écart » (null).
 */
export function decodeSeriesTemplate(json: string): Result<SeriesTemplate, SeriesTemplateError> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'invalid_shape' };
  const r = raw as Record<string, unknown>;
  const str = (v: unknown): v is string => typeof v === 'string';
  const { title, note, icon, time, spaceId, projectId, date } = r;
  if (!str(title) || title.trim() === '' || !str(note) || !str(spaceId) || !isId(spaceId)) return { ok: false, error: 'invalid_field' };
  if (projectId !== null && !(str(projectId) && isId(projectId))) return { ok: false, error: 'invalid_field' };
  if (time !== null && !(str(time) && isLocalTime(time))) return { ok: false, error: 'invalid_field' };
  if (date !== null && !(str(date) && isLocalDate(date))) return { ok: false, error: 'invalid_field' };
  if (icon !== null && (!str(icon) || parseIcon(icon) === null)) return { ok: false, error: 'invalid_field' };
  return {
    ok: true,
    value: {
      title,
      note,
      icon: icon === null ? null : parseIcon(icon as string),
      time: time as SeriesTemplate['time'],
      spaceId: spaceId as SeriesTemplate['spaceId'],
      projectId: projectId as SeriesTemplate['projectId'],
      date: date as SeriesTemplate['date'],
    },
  };
}
