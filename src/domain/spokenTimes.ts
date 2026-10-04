import { foldKeepLength } from './naturalDate';

/**
 * Heures dictées (Q-03 critère 4, décision D3) : la dictée Windows écrit « appeler le notaire demain dix heures trente » ;
 * l'analyseur de dates (Q-02) lit « 10 h 30 ». Ce passage réécrit seulement les heures dites en lettres (« dix heures »,
 * « neuf heures trente », « huit heures et demie », « onze heures moins le quart ») avant l'analyse ; le reste du texte est
 * inchangé. « midi » et « minuit » sont déjà lus par l'analyseur. Règle pure, branchée par src/features/capture avant chaque analyse de saisie.
 *
 * Une durée n'est pas une heure : « pendant deux heures », « dans une heure », « en trois heures » restent du texte.
 */

const HOURS: Readonly<Record<string, number>> = {
  zero: 0,
  un: 1,
  une: 1,
  deux: 2,
  trois: 3,
  quatre: 4,
  cinq: 5,
  six: 6,
  sept: 7,
  huit: 8,
  neuf: 9,
  dix: 10,
  onze: 11,
  douze: 12,
  treize: 13,
  quatorze: 14,
  quinze: 15,
  seize: 16,
  'dix-sept': 17,
  'dix-huit': 18,
  'dix-neuf': 19,
  vingt: 20,
  'vingt-et-un': 21,
  'vingt-et-une': 21,
  'vingt-deux': 22,
  'vingt-trois': 23,
};

const MINUTES: Readonly<Record<string, number>> = {
  cinq: 5,
  dix: 10,
  quinze: 15,
  vingt: 20,
  'vingt-cinq': 25,
  trente: 30,
  'trente-cinq': 35,
  quarante: 40,
  'quarante-cinq': 45,
  cinquante: 50,
  'cinquante-cinq': 55,
};

/** Mots qui font d'« N heures » une durée, pas une heure du jour. */
const DURATION_BEFORE = /(?:^|[^\p{L}])(?:dans|pendant|durant|pour|en|pr[eè]s de|plus de|moins de|environ|toutes les|chaque|ensemble|plus que|encore)\s+(?:(?:les|ces|ses)\s+)?$/u;

const pattern = (words: readonly string[]): string => [...words].sort((a, b) => b.length - a.length).map((w) => w.replace(/-/g, '[-\\s]+')).join('|');

const HOUR_RE = new RegExp(`(?<![\\p{L}-])(${pattern(Object.keys(HOURS))})\\s+heures?(?![\\p{L}])`, 'gu');
const SUFFIX_RE = new RegExp(
  `^\\s+(?:et\\s+(quart|demie?)|moins\\s+(?:le\\s+)?(quart|${pattern(['vingt-cinq', 'vingt', 'dix', 'cinq'])})|(${pattern(Object.keys(MINUTES))})(?![\\p{L}])|(\\d{1,2})(?![\\d\\p{L}:]))`,
  'u',
);

const key = (word: string): string => word.replace(/[-\s]+/g, '-');
const two = (n: number): string => String(n).padStart(2, '0');

/** Réécrit les heures dites en lettres en chiffres (« dix heures trente » donne « 10 h 30 »). Le reste du texte est inchangé. */
export function normalizeSpokenTimes(text: string): string {
  const folded = foldKeepLength(text);
  let out = '';
  let cursor = 0;
  HOUR_RE.lastIndex = 0;
  for (let match = HOUR_RE.exec(folded); match; match = HOUR_RE.exec(folded)) {
    const start = match.index;
    if (start < cursor) continue;
    if (DURATION_BEFORE.test(folded.slice(0, start))) continue;
    let hour = HOURS[key(match[1] ?? '')];
    if (hour === undefined) continue;
    let end = start + match[0].length;
    let minutes = 0;
    const suffix = SUFFIX_RE.exec(folded.slice(end));
    if (suffix) {
      const [whole, plus, minus, spoken, digits] = suffix;
      if (plus) minutes = plus === 'quart' ? 15 : 30;
      else if (minus) {
        const taken = minus === 'quart' ? 15 : (MINUTES[key(minus)] ?? 0);
        hour = (hour + 23) % 24;
        minutes = 60 - taken;
      } else if (spoken) minutes = MINUTES[key(spoken)] ?? 0;
      else if (digits) minutes = Number(digits);
      if (minutes < 60) end += whole.length;
      else minutes = 0;
    }
    out += text.slice(cursor, start) + (minutes > 0 ? `${hour} h ${two(minutes)}` : `${hour} h`);
    cursor = end;
  }
  return out + text.slice(cursor);
}

/** Texte lu par l'analyse de la saisie rapide : dictée normalisée. Un texte tapé en chiffres traverse sans changement. */
export function normalizeQuickText(text: string): string {
  return normalizeSpokenTimes(text);
}
