import { rowIsDone, rowTime, type TodayRow } from './todayList';

/**
 * Réordonnancement manuel de la liste du jour (A-02, Q11).
 *
 * Règle : l'heure est prioritaire. Les éléments à heure sont triés par heure ; l'ordre manuel
 * (`sortOrder`) ne départage que les tâches de même heure, et les tâches sans heure se suivent dans
 * leur ordre manuel. Une tâche ne peut donc se déplacer qu'à l'intérieur de son groupe (même heure, ou
 * « sans heure ») ; toute destination hors du groupe est ramenée à son bord le plus proche, c'est-à-dire
 * à la place que lui impose son heure. Les routines (placées par leur heure, sans `sortOrder`) et les
 * éléments terminés ne se déplacent pas.
 */
export interface SortChange {
  readonly id: string;
  readonly sortOrder: number;
}

export interface MoveOutcome {
  /** Nouveaux `sortOrder` à écrire ; vide si la tâche reste à sa place. */
  readonly changes: readonly SortChange[];
  readonly fromIndex: number;
  /** Position finale dans la liste fournie (après avoir ramené la destination dans le groupe). */
  readonly toIndex: number;
  /** Nombre d'éléments de la liste (« position 3 sur 6 »). */
  readonly total: number;
  /** La destination demandée a été ramenée par la règle de l'heure (ou par les bornes de la liste). */
  readonly clamped: boolean;
}

/** Écart minimal toléré entre deux `sortOrder` voisins avant de renuméroter le groupe. */
const MIN_GAP = 1e-6;

/**
 * Déplace la tâche `id` à la position `requestedIndex` de `rows` (éléments à faire, dans l'ordre affiché).
 * Renvoie null si l'élément n'est pas déplaçable (routine, terminé, absent de la liste).
 */
export function moveTaskRow(rows: readonly TodayRow[], id: string, requestedIndex: number): MoveOutcome | null {
  const fromIndex = rows.findIndex((row) => row.id === id);
  const row = rows[fromIndex];
  if (!row || row.kind !== 'task' || rowIsDone(row)) return null;

  const sameGroup = (other: TodayRow | undefined): other is Extract<TodayRow, { kind: 'task' }> =>
    other !== undefined && other.kind === 'task' && !rowIsDone(other) && rowTime(other) === rowTime(row);
  let start = fromIndex;
  while (sameGroup(rows[start - 1])) start -= 1;
  let end = fromIndex;
  while (sameGroup(rows[end + 1])) end += 1;

  const requested = Math.trunc(requestedIndex);
  const toIndex = Math.min(Math.max(requested, start), end);
  const base = { fromIndex, toIndex, total: rows.length, clamped: toIndex !== requested };
  if (toIndex === fromIndex) return { ...base, changes: [] };

  const group = rows.slice(start, end + 1) as Extract<TodayRow, { kind: 'task' }>[];
  const arranged = group.filter((member) => member.id !== id);
  arranged.splice(toIndex - start, 0, row);

  const position = toIndex - start;
  const before = arranged[position - 1]?.task.sortOrder;
  const after = arranged[position + 1]?.task.sortOrder;
  let value: number | null = null;
  if (before !== undefined && after !== undefined) value = (before + after) / 2;
  else if (before !== undefined) value = before + 1;
  else if (after !== undefined) value = after - 1;

  const fits =
    value !== null && (before === undefined || value - before >= MIN_GAP) && (after === undefined || after - value >= MIN_GAP);
  if (fits && value !== null) return { ...base, changes: [{ id, sortOrder: value }] };

  // Voisins confondus ou trop proches : le groupe est renuméroté dans le nouvel ordre.
  const first = Math.min(...group.map((member) => member.task.sortOrder));
  const changes: SortChange[] = [];
  arranged.forEach((member, index) => {
    const sortOrder = first + index;
    if (member.task.sortOrder !== sortOrder) changes.push({ id: member.id, sortOrder });
  });
  return { ...base, changes };
}
