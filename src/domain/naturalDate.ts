import * as chrono from 'chrono-node/fr';
import { WEEKDAYS } from './dateInput';
import { addDays, makeLocalDate, parseLocalDate, weekdayOf } from './localDate';
import type { LocalDate, LocalTime, Weekday } from './types';
import { DEFAULT_FIRST_WEEKDAY, daysSinceWeekStart, firstWeekdayIso, type FirstWeekday } from './week';

/**
 * Date et heure dans une phrase française (Q-02). Enveloppe de chrono-node (locale fr, MIT) : si la bibliothèque change, seul ce
 * fichier bouge. Un seul analyseur de dates en langage libre : les tables de jours de `dateInput.ts` (T-14) sont partagées, et
 * `parseQuickInput` (Q-06) appelle cette fonction.
 *
 * Répartition : la grammaire relative et les heures (demain, après-demain, jours de semaine, « 10h », « 14 h 30 », midi, ce soir,
 * semaine prochaine) sont lues ici, parce que chrono-node les rate (« après-demain » devient « demain », « 14 h » et « midi » ne
 * sont pas compris) ou ne connaît pas le premier jour de semaine (P-03) ; chrono-node lit le reste : dates absolues (« le 5
 * octobre », « 12/10 », « 15 octobre 2026 »), « dans 3 jours », « dans 2 semaines », plages.
 *
 * Décisions : une date n'est retenue que si elle est certaine au niveau du jour ou accompagnée d'une heure (« mai », « mardi gras »,
 * « Sam 10h » n'en sont pas) ; matin 09:00, midi 12:00, après-midi 14:00, soir 19:00 ; une heure seule passe à demain si elle est
 * passée ; « aujourd'hui » explicite reste aujourd'hui ; un jour de semaine seul est la prochaine occurrence
 * STRICTEMENT après aujourd'hui (comme le champ Date de T-14, décision du 2026-10-04) ; « lundi prochain » est le lundi de la semaine suivante (comme T-14) ; les
 * abréviations (« lun. ») exigent le point ; « chaque lundi » (récurrence) n'est pas une date.
 * Pur : « maintenant » est fourni (horloge injectable, heure locale de l'appareil).
 */

/** Instant courant en heure locale de l'appareil (date civile et heure 24 h). */
export interface NaturalNow {
  readonly date: LocalDate;
  readonly time: LocalTime;
}

export interface NaturalDateOptions {
  /** Premier jour de la semaine (P-03) : « la semaine prochaine » = son prochain premier jour. */
  readonly firstWeekday?: FirstWeekday;
}

/** Zone du texte (indices dans le texte d'origine, fin exclue). */
export interface Hit {
  readonly start: number;
  readonly end: number;
  /** Retrait sans les petits mots qui précèdent (marques # et @). */
  readonly plain?: boolean;
}

/** Morceau du texte reconnu. */
export interface NaturalSpan extends Hit {
  readonly kind: 'date' | 'time';
}

export type NaturalDateKind = 'today' | 'tomorrow' | 'dayAfter' | 'weekday' | 'nextWeek' | 'absolute' | 'relative' | 'implied';

export interface NaturalDate {
  /** Toujours posée : déduite (aujourd'hui ou demain) quand seule une heure est écrite. */
  readonly date: LocalDate;
  readonly time: LocalTime | null;
  /** Plage (« du lundi au mercredi », « du 5 au 7 octobre ») ; seule la première date est retenue pour la tâche. */
  readonly dateRange: { readonly start: LocalDate; readonly end: LocalDate } | null;
  /** Un mot de date est écrit ; faux : date déduite d'une heure seule. */
  readonly dateWritten: boolean;
  readonly dateKind: NaturalDateKind;
  readonly spans: readonly NaturalSpan[];
}

type Moment = 'matin' | 'midi' | 'apres-midi' | 'soir';

/** Heures par défaut des moments flous (Q-02 D3). */
export const MOMENT_TIMES: Readonly<Record<Moment, LocalTime>> = {
  matin: '09:00' as LocalTime,
  midi: '12:00' as LocalTime,
  'apres-midi': '14:00' as LocalTime,
  soir: '19:00' as LocalTime,
};

const pad2 = (n: number): string => String(n).padStart(2, '0');
const toTime = (hours: number, minutes: number): LocalTime | null =>
  Number.isInteger(hours) && Number.isInteger(minutes) && hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59
    ? (`${pad2(hours)}:${pad2(minutes)}` as LocalTime)
    : null;

/** Minuscules sans accents, MÊME longueur que le texte (les indices valent pour l'original). */
export function foldKeepLength(text: string): string {
  let out = '';
  for (const unit of text) {
    const base = (unit.normalize('NFD')[0] ?? unit).toLowerCase();
    const mapped = base === '’' || base === '`' ? "'" : base;
    out += mapped.length === unit.length ? mapped : mapped.padEnd(unit.length, ' ').slice(0, unit.length);
  }
  return out;
}

interface DateHit extends Hit {
  readonly kind: NaturalDateKind;
  readonly date?: LocalDate;
  readonly weekday?: Weekday;
  readonly nextWeek?: boolean;
  readonly moment?: Moment;
  readonly range?: { readonly start: LocalDate; readonly end: LocalDate };
  /** Plage de jours de semaine : jour de fin, résolu avec le début. */
  readonly endWeekday?: Weekday;
}
interface TimeHit extends Hit {
  readonly time: LocalTime;
}

const WEEKDAY_FULL = '(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)';
const WEEKDAY_ABBR = '(lun|mar|mer|jeu|ven|sam|dim)\\.';
const MOMENT_RE = '(matin|apres-midi|soir)';

/** Mots qui annoncent une répétition (hors périmètre) : le jour de semaine suivant n'est pas une date. */
const RECURRING_BEFORE = /(?<![a-z])(?:chaque|tous les|toutes les|les)\s+$/;
/** Petits mots retirés avec le texte reconnu quand ils le précèdent immédiatement. */
const LEADING = /(?:^|\s)(le|la|ce|cet|cette|vers|pour|du|au|à|dès)\s+$/;

function blank(text: string, hits: readonly Hit[]): string {
  let out = text;
  for (const hit of hits) out = out.slice(0, hit.start) + ' '.repeat(hit.end - hit.start) + out.slice(hit.end);
  return out;
}

function findTimes(folded: string): TimeHit[] {
  const hits: TimeHit[] = [];
  const push = (match: RegExpExecArray, time: LocalTime | null): void => {
    if (time) hits.push({ start: match.index, end: match.index + match[0].length, time });
  };
  // « 10h », « 10 h 30 », « 10h30 », « 14:30 », « 14 heures » (+ « du matin », « du soir », « de l'après-midi »)
  // Pas une durée (« dans 2 heures », « pendant 2h ») ni une heure suivie de am / pm (lue plus bas).
  const clock = /(?<![\d:./,-])(?<!(?:dans|pendant|durant|en)\s+)(\d{1,2})\s*(?:h(?:eures?)?\s*(\d{2})?|:\s*(\d{2}))(?:\s+du\s+(matin|soir)|\s+de\s+l'apres-midi)?(?!\s*[ap]m(?![a-z]))(?![a-z\d])/g;
  for (let m = clock.exec(folded); m; m = clock.exec(folded)) {
    let hours = Number(m[1]);
    const minutes = m[2] !== undefined ? Number(m[2]) : m[3] !== undefined ? Number(m[3]) : 0;
    const evening = m[4] === 'soir' || m[0].includes("l'apres-midi");
    if (evening && hours >= 1 && hours <= 11) hours += 12;
    push(m, toTime(hours, minutes));
  }
  // « 3pm », « 3:30 pm », « 9 am »
  const meridiem = /(?<![\d:./,-])(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?![a-z\d])/g;
  for (let m = meridiem.exec(folded); m; m = meridiem.exec(folded)) {
    const h12 = Number(m[1]);
    if (h12 >= 1 && h12 <= 12) push(m, toTime((h12 % 12) + (m[3] === 'pm' ? 12 : 0), m[2] !== undefined ? Number(m[2]) : 0));
  }
  // « midi », « midi et demi », « minuit » ; pas « du midi », « le midi » (le Midi, repas du midi).
  const noon = /(?<![a-z'-])(midi(?:\s+et\s+demi)?|minuit)(?![a-z])/g;
  for (let m = noon.exec(folded); m; m = noon.exec(folded)) {
    if (/(?:(?<![a-z])(?:du|le|au|de|en)\s+|['-])$/.test(folded.slice(0, m.index))) continue;
    push(m, m[1] === 'minuit' ? toTime(0, 0) : toTime(12, m[1]?.includes('demi') ? 30 : 0));
  }
  return hits.sort((a, b) => a.start - b.start);
}

function momentAfter(folded: string, from: number): { moment: Moment; end: number } | null {
  const m = new RegExp(`^\\s+${MOMENT_RE}(?![a-z])`).exec(folded.slice(from));
  return m ? { moment: m[1] as Moment, end: from + m[0].length } : null;
}

function findDates(folded: string): DateHit[] {
  const hits: DateHit[] = [];

  // « aujourd'hui », « ce matin », « ce soir », « cet après-midi » : aujourd'hui, heure floue.
  const today = /(?<![a-z])(?:aujourd'?hui|ce\s+(?:matin|soir)|cet(?:te)?\s+apres-midi)(?![a-z])/g;
  for (let m = today.exec(folded); m; m = today.exec(folded)) {
    const named = /(matin|soir|apres-midi)$/.exec(m[0]);
    const after = named ? null : momentAfter(folded, m.index + m[0].length);
    const moment = (named?.[1] ?? after?.moment) as Moment | undefined;
    hits.push({ start: m.index, end: after?.end ?? m.index + m[0].length, kind: 'today', ...(moment ? { moment } : {}) });
  }
  const relative = /(?<![a-z])(apres[- ]demain|demain)(?![a-z])/g;
  for (let m = relative.exec(folded); m; m = relative.exec(folded)) {
    const after = momentAfter(folded, m.index + m[0].length);
    hits.push({ start: m.index, end: after?.end ?? m.index + m[0].length, kind: m[1] === 'demain' ? 'tomorrow' : 'dayAfter', ...(after ? { moment: after.moment } : {}) });
  }
  const nextWeek = /(?<![a-z])(?:la\s+)?semaine\s+prochaine(?![a-z])/g;
  for (let m = nextWeek.exec(folded); m; m = nextWeek.exec(folded)) hits.push({ start: m.index, end: m.index + m[0].length, kind: 'nextWeek' });

  // Jours de semaine, « prochain » avant ou après, plage « du lundi au mercredi ».
  const weekday = new RegExp(`(?<![a-z])(prochain\\s+)?(?:${WEEKDAY_FULL}(?!\\s+gras)|${WEEKDAY_ABBR})(?![a-z])(\\s+prochaine?(?![a-z]))?`, 'g');
  for (let m = weekday.exec(folded); m; m = weekday.exec(folded)) {
    if (RECURRING_BEFORE.test(folded.slice(0, m.index))) continue;
    const weekdayNumber = WEEKDAYS[m[2] ?? m[3] ?? ''];
    if (weekdayNumber === undefined) continue;
    const next = m[1] !== undefined || m[4] !== undefined;
    let end = m.index + m[0].length;
    let endWeekday: Weekday | undefined;
    let moment: Moment | undefined;
    const range = new RegExp(`^\\s+(?:au|jusqu'?au)\\s+(?:${WEEKDAY_FULL}|${WEEKDAY_ABBR})(?![a-z])`).exec(folded.slice(end));
    if (range && /(?<![a-z])du\s+$/.test(folded.slice(0, m.index))) {
      endWeekday = WEEKDAYS[range[1] ?? range[2] ?? ''];
      end += range[0].length;
    } else {
      const after = momentAfter(folded, end);
      if (after) {
        moment = after.moment;
        end = after.end;
      }
    }
    hits.push({
      start: m.index,
      end,
      kind: 'weekday',
      weekday: weekdayNumber,
      ...(next ? { nextWeek: true } : {}),
      ...(moment ? { moment } : {}),
      ...(endWeekday ? { endWeekday } : {}),
    });
  }
  return hits.sort((a, b) => a.start - b.start);
}

/** Ordre de priorité des sources de date : une date écrite en toutes lettres bat un jour de semaine. */
const PRIORITY: Record<NaturalDateKind, number> = { absolute: 0, relative: 0, nextWeek: 1, tomorrow: 2, dayAfter: 2, today: 2, weekday: 3, implied: 9 };

function nextWeekStart(today: LocalDate, first: FirstWeekday): LocalDate {
  return addDays(today, 7 - daysSinceWeekStart(today, first));
}

/** Prochaine occurrence du jour de semaine, STRICTEMENT après `from` (comme le champ Date de T-14). */
function upcoming(from: LocalDate, weekday: Weekday): LocalDate {
  return addDays(from, ((weekday - weekdayOf(from) + 6) % 7) + 1);
}

function chronoDates(masked: string, now: NaturalNow): DateHit[] {
  const { year, month, day } = parseLocalDate(now.date);
  const [h, mi] = now.time.split(':').map(Number);
  const reference = new Date(year, month - 1, day, h ?? 0, mi ?? 0, 0);
  const hits: DateHit[] = [];
  for (const result of chrono.parse(masked, reference, { forwardDate: true })) {
    if (/heure|minute|\bmin\b/i.test(result.text)) continue; // « dans 2 heures » : pas une date
    const certain = result.start.isCertain('day') && result.start.isCertain('month');
    const relative = /^dans\b/i.test(result.text);
    if (!certain && !relative) continue;
    const start = makeLocalDate(result.start.get('year') ?? year, result.start.get('month') ?? month, result.start.get('day') ?? day);
    const endDate = result.end ? makeLocalDate(result.end.get('year') ?? year, result.end.get('month') ?? month, result.end.get('day') ?? day) : null;
    hits.push({
      start: result.index,
      end: result.index + result.text.length,
      kind: relative ? 'relative' : 'absolute',
      date: start,
      ...(endDate && endDate > start ? { range: { start, end: endDate } } : {}),
    });
  }
  return hits;
}

/**
 * Cherche une date et / ou une heure dans `text`. `null` si rien de certain n'y figure. Les indices de `spans` valent pour `text`.
 * `skip` : zones déjà prises (marques # et @ de Q-06), ignorées.
 */
export function naturalDate(text: string, now: NaturalNow, options: NaturalDateOptions = {}, skip: readonly Hit[] = []): NaturalDate | null {
  const first = options.firstWeekday ?? DEFAULT_FIRST_WEEKDAY;
  const folded = blank(foldKeepLength(text), skip);
  const times = findTimes(folded);
  const words = findDates(folded);
  // Les zones lues par la grammaire locale sont masquées pour chrono-node : il ne voit que le reste.
  const chronoHits = chronoDates(blank(text, [...skip, ...times, ...words]), now);

  let dateHit = [...chronoHits, ...words].sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.start - b.start)[0] ?? null;
  if (dateHit && (dateHit.kind === 'absolute' || dateHit.kind === 'relative')) {
    // « samedi 26 sept. » : le jour de semaine écrit juste avant la date fait partie du même morceau.
    const chosen = dateHit;
    const lead = words.find((hit) => hit.kind === 'weekday' && !hit.endWeekday && hit.end <= chosen.start && /^[\s,]*$/.test(folded.slice(hit.end, chosen.start)));
    if (lead) dateHit = { ...chosen, start: lead.start };
  }
  const timeHit = times.find((hit) => !dateHit || hit.end <= dateHit.start || hit.start >= dateHit.end) ?? null;
  if (!dateHit && !timeHit) return null;

  let time: LocalTime | null = timeHit?.time ?? (dateHit?.moment ? MOMENT_TIMES[dateHit.moment] : null);
  if (timeHit && (dateHit?.moment === 'soir' || dateHit?.moment === 'apres-midi')) {
    // « demain soir 8h » : 20:00.
    const [hh, mm] = timeHit.time.split(':').map(Number);
    if (hh !== undefined && hh >= 1 && hh <= 11) time = toTime(hh + 12, mm ?? 0);
  }

  let date: LocalDate;
  let range: NaturalDate['dateRange'] = null;
  if (!dateHit) {
    // Heure seule : aujourd'hui si elle est à venir, sinon demain (critère 5).
    date = time !== null && time > now.time ? now.date : addDays(now.date, 1);
  } else if (dateHit.kind === 'today') {
    date = now.date;
  } else if (dateHit.kind === 'tomorrow') {
    date = addDays(now.date, 1);
  } else if (dateHit.kind === 'dayAfter') {
    date = addDays(now.date, 2);
  } else if (dateHit.kind === 'nextWeek') {
    date = nextWeekStart(now.date, first);
  } else if (dateHit.kind === 'weekday') {
    const weekday = dateHit.weekday ?? 1;
    if (dateHit.nextWeek) {
      date = addDays(nextWeekStart(now.date, first), (weekday - firstWeekdayIso(first) + 7) % 7);
    } else {
      date = upcoming(now.date, weekday);
    }
    if (dateHit.endWeekday !== undefined) {
      const end = upcoming(date, dateHit.endWeekday);
      range = { start: date, end: end === date ? addDays(end, 7) : end };
    }
  } else {
    date = dateHit.date ?? now.date;
    range = dateHit.range ?? null;
  }

  const spans: NaturalSpan[] = [];
  if (dateHit) spans.push({ start: dateHit.start, end: dateHit.end, kind: 'date' });
  if (timeHit) spans.push({ start: timeHit.start, end: timeHit.end, kind: 'time' });
  spans.sort((a, b) => a.start - b.start);
  return { date, time, dateRange: range, dateWritten: dateHit !== null, dateKind: dateHit?.kind ?? 'implied', spans };
}

/**
 * Retire les zones du texte avec le petit mot qui les introduit (« le », « à », « pour », « vers », « du ») et les espaces en trop.
 * Rend le texte résultant, rogné.
 */
export function removeHits(text: string, hits: readonly Hit[]): string {
  const sorted = [...hits].sort((a, b) => a.start - b.start);
  const lower = text.toLowerCase();
  let out = '';
  let at = 0;
  for (const hit of sorted) {
    if (hit.start < at) {
      at = Math.max(at, hit.end);
      continue;
    }
    let start = hit.start;
    // Deux petits mots au plus (« pour le 5 octobre »), sans entamer ce qui est déjà retiré.
    for (let i = 0; i < 2 && !hit.plain; i += 1) {
      const m = LEADING.exec(lower.slice(at, start));
      if (!m) break;
      start -= m[0].length - (/^\s/.test(m[0]) ? 1 : 0);
    }
    out += text.slice(at, start) + ' ';
    at = hit.end;
  }
  out += text.slice(at);
  return out
    .replace(/\s+/g, ' ')
    .replace(/\s+([,;.!?])/g, '$1')
    .replace(/^[\s,;:\-–]+|[\s,;:\-–]+$/g, '')
    .trim();
}
