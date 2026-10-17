/**
 * Y-TECH-03 (B13 de docs/audit-1.0.md) : plan de pannes d'iCloud (« FaultPlan »), un seul format lu tel quel par les faux du dépôt
 * (`memory.ts` en TypeScript ; `MemFs` et `fake_bookmark` en Rust, phase B) et par les simulateurs. Schéma de référence et exemples :
 * `tests/fixtures/sync/fault-plan.json` (son `$comment` décrit chaque champ et chaque effet pour la réimplémentation Rust).
 *
 * Chaque panne est armée **par chemin de fichier et par rang d'appel**, jamais par le temps : aucun champ de durée n'est accepté. Une entrée
 * que le faux ne sait pas rejouer (opération ou effet inconnu, couple opération/effet non pris en charge, paramètre manquant ou en trop) est
 * refusée au chargement avec un message qui la nomme : jamais une panne ignorée en silence.
 *
 * Module sans effet de bord au chargement : ses constantes de module sont des tableaux littéraux de textes (listes fermées des opérations,
 * effets et champs) et des fonctions fléchées ; aucun appel ni construction d'objet au chargement (ni `Map`, ni `Set`, les expressions
 * régulières sont dans les corps de fonction) ; `memory.ts` n'entre pas dans le bundle de départ et ce module non plus.
 *
 * Lecture croisée avec Rust (`src-tauri/tests/desktop/support/fault_plan.rs`) : mêmes refus, mêmes messages, table commune
 * `tests/fixtures/sync/fault-plan-invalid.json`. Un nombre non entier écrit dans le texte (`1.0`, `1e0`) est refusé comme par serde : la
 * lecture d'un texte passe par `parseFaultPlanText` / `parseFaultPlanFile` (après `JSON.parse`, `1.0` et `1` ne se distinguent plus).
 */

export type FaultOp = 'list' | 'read' | 'write' | 'rename' | 'remove' | 'hydrate';
export type FaultEffect = 'error' | 'accept-not-propagated' | 'evict-after-read' | 'placeholder' | 'overwrite-before-read' | 'download-error' | 'mute';
/** Codes d'erreur armables (ceux d'iCloud qui comptent pour la synchro : disque, fichier pas encore livré). */
export type FaultCode = 'io' | 'cloud-pending';

export interface FaultEntry {
  readonly id: string;
  readonly op: FaultOp;
  /** Chemin sous la racine `CircleTasks`, composants séparés par `/`, `*` = toute suite de caractères dans un composant. */
  readonly file: string;
  /** Rang (à partir de 1) du premier appel de `op` sur un chemin qui correspond à `file`. */
  readonly nth: number;
  /** Nombre d'appels consécutifs touchés à partir de `nth` (1 par défaut), ou `all` : tous les suivants. */
  readonly times: number | 'all';
  readonly effect: FaultEffect;
  readonly code?: FaultCode;
  readonly resurrectAfterCycles?: number;
  readonly content?: readonly string[];
  readonly partialLastLine?: boolean;
  readonly about?: string;
}

export interface FaultPlanOptions {
  /** Mode historique du plugin (avant Y-IOS-02-FIX-02) : `remove` du vrai nom laisse le substitut `.<nom>.icloud` (rien supprimé). */
  readonly removeLeavesPlaceholder: boolean;
}

export interface FaultPlan {
  readonly name: string;
  readonly faults: readonly FaultEntry[];
  readonly options: FaultPlanOptions;
}

/** Plan invalide ou que le faux ne sait pas rejouer : le message nomme le plan et l'entrée. */
export class FaultPlanError extends Error {
  override readonly name = 'FaultPlanError';
}

export const FAULT_OPS: readonly FaultOp[] = ['list', 'read', 'write', 'rename', 'remove', 'hydrate'];
export const FAULT_EFFECTS: readonly FaultEffect[] = ['error', 'accept-not-propagated', 'evict-after-read', 'placeholder', 'overwrite-before-read', 'download-error', 'mute'];

/** Effets que chaque opération sait rejouer (même table dans les trois faux). */
export function effectsOf(op: FaultOp): readonly FaultEffect[] {
  switch (op) {
    case 'list':
      return ['error', 'mute', 'placeholder'];
    case 'read':
      return ['error', 'mute', 'evict-after-read', 'overwrite-before-read'];
    case 'hydrate':
      return ['download-error', 'mute'];
    case 'write':
      return ['error'];
    case 'rename':
      return ['error'];
    case 'remove':
      return ['error', 'accept-not-propagated'];
  }
}

const PLAN_KEYS = ['name', 'about', 'options', 'faults'];
const OPTION_KEYS = ['removeLeavesPlaceholder'];
const ENTRY_KEYS = ['id', 'op', 'file', 'nth', 'times', 'effect', 'code', 'resurrectAfterCycles', 'content', 'partialLastLine', 'about'];
/** Noms de champs qui portent une durée ou une heure : refusés avec un message explicite (règle : rang d'appel, jamais le temps). */
const isDurationKey = (key: string): boolean => /(ms|millis|seconds?|delay|timeout|duration|wait|sleep|time$|at$|date|clock)/i.test(key) && key !== 'times';

/** Valeur citée dans un message : un texte tel quel, sinon son JSON compact (`3`, `null`), `undefined` si absente (comme Rust). */
const shown = (value: unknown): string => (typeof value === 'string' ? value : value === undefined ? 'undefined' : JSON.stringify(value));
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isRank = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * Motif de chemin : composants non vides séparés par `/`, premier composant `devices`, ni `.` ni `..`, `*` comme seul joker ; un dossier
 * se termine par `/`. Aucun horodatage (date ISO, nombre de 10 chiffres ou plus).
 */
function checkPattern(file: unknown, where: string): string {
  if (typeof file !== 'string' || file.length === 0) throw new FaultPlanError(`${where} : « file » absent ou vide`);
  const body = file.endsWith('/') ? file.slice(0, -1) : file;
  const parts = body.split('/');
  if (parts[0] !== 'devices' || parts.some((p) => p.length === 0 || p === '.' || p === '..' || p.includes('\\'))) throw new FaultPlanError(`${where} : chemin « ${file} » invalide (devices/…, composants non vides)`);
  // Identifiants d'appareil (UUID) écartés avant le contrôle : leurs chiffres ne sont pas une heure.
  const withoutIds = file.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'U');
  if (/\d{4}-\d{2}-\d{2}T|\d{10,}/.test(withoutIds)) throw new FaultPlanError(`${where} : chemin « ${file} » : horodatage interdit (rang d'appel seulement)`);
  return file;
}

function parseEntry(raw: unknown, index: number, plan: string, seen: Set<string>): FaultEntry {
  const label = isObject(raw) && typeof raw['id'] === 'string' && raw['id'].length > 0 ? `« ${raw['id']} »` : `n° ${String(index + 1)}`;
  const where = `plan « ${plan} », entrée ${label}`;
  if (!isObject(raw)) throw new FaultPlanError(`${where} : objet attendu`);
  for (const key of Object.keys(raw)) {
    if (isDurationKey(key)) throw new FaultPlanError(`${where} : champ de durée « ${key} » interdit (rang d'appel et cycles seulement)`);
    if (!ENTRY_KEYS.includes(key)) throw new FaultPlanError(`${where} : champ inconnu « ${key} »`);
  }
  const id = raw['id'];
  if (typeof id !== 'string' || id.length === 0) throw new FaultPlanError(`${where} : « id » absent`);
  if (seen.has(id)) throw new FaultPlanError(`${where} : « id » en double`);
  seen.add(id);
  const op = raw['op'];
  if (typeof op !== 'string' || !(FAULT_OPS as readonly string[]).includes(op)) throw new FaultPlanError(`${where} : opération inconnue « ${shown(op)} »`);
  const effect = raw['effect'];
  if (typeof effect !== 'string' || !(FAULT_EFFECTS as readonly string[]).includes(effect)) throw new FaultPlanError(`${where} : effet inconnu « ${shown(effect)} »`);
  if (!effectsOf(op as FaultOp).includes(effect as FaultEffect)) throw new FaultPlanError(`${where} : effet « ${effect} » non rejouable sur l'opération « ${op} »`);
  if (!('nth' in raw)) throw new FaultPlanError(`${where} : rang « nth » absent`);
  if (!isRank(raw['nth'])) throw new FaultPlanError(`${where} : rang « nth » invalide (entier à partir de 1)`);
  const times = raw['times'] ?? 1;
  if (times !== 'all' && !isRank(times)) throw new FaultPlanError(`${where} : « times » invalide (entier à partir de 1 ou « all »)`);
  const file = checkPattern(raw['file'], where);
  const isDir = file.endsWith('/');
  if (op === 'list' && effect !== 'placeholder' && !isDir) throw new FaultPlanError(`${where} : « list » en ${effect} désigne un dossier (chemin terminé par /)`);
  if ((op !== 'list' || effect === 'placeholder') && isDir) throw new FaultPlanError(`${where} : « ${op} » désigne un fichier (pas de / final)`);
  const has = (key: string): boolean => key in raw;
  const only = (key: string, allowed: boolean): void => {
    if (has(key) && !allowed) throw new FaultPlanError(`${where} : « ${key} » sans objet pour l'effet « ${effect} »`);
  };
  only('code', effect === 'error');
  only('resurrectAfterCycles', effect === 'accept-not-propagated');
  only('content', effect === 'overwrite-before-read');
  only('partialLastLine', effect === 'error' && op === 'write');
  const entry: { -readonly [K in keyof FaultEntry]: FaultEntry[K] } = { id, op: op as FaultOp, file, nth: raw['nth'], times, effect: effect as FaultEffect };
  if (effect === 'error') {
    const code = raw['code'];
    if (code !== 'io' && code !== 'cloud-pending') throw new FaultPlanError(`${where} : « code » attendu (io ou cloud-pending)`);
    entry.code = code;
  }
  if (effect === 'accept-not-propagated') {
    if (!isCount(raw['resurrectAfterCycles'])) throw new FaultPlanError(`${where} : « resurrectAfterCycles » attendu (entier, 0 : jamais de retour)`);
    entry.resurrectAfterCycles = raw['resurrectAfterCycles'];
  }
  if (effect === 'overwrite-before-read') {
    const content = raw['content'];
    if (!Array.isArray(content) || !content.every((line) => typeof line === 'string' && !line.includes('\n'))) throw new FaultPlanError(`${where} : « content » attendu (lignes complètes, sans \\n)`);
    entry.content = [...(content as string[])];
  }
  if (has('partialLastLine')) {
    if (typeof raw['partialLastLine'] !== 'boolean') throw new FaultPlanError(`${where} : « partialLastLine » booléen attendu`);
    // Seul un ajout à un segment de journal peut laisser une ligne incomplète (état et instantané : remplacement atomique).
    if (!/(\.ctj|\*)$/.test(file)) throw new FaultPlanError(`${where} : « partialLastLine » réservé aux segments de journal (*.ctj)`);
    entry.partialLastLine = raw['partialLastLine'];
  }
  if (has('about')) {
    if (typeof raw['about'] !== 'string') throw new FaultPlanError(`${where} : « about » texte attendu`);
    entry.about = raw['about'];
  }
  return entry;
}

/** Lecture stricte d'un plan (objet JSON de `fault-plan.json`, ou construit par un test). */
export function parseFaultPlan(raw: unknown): FaultPlan {
  if (!isObject(raw)) throw new FaultPlanError('plan : objet attendu');
  const name = typeof raw['name'] === 'string' && raw['name'].length > 0 ? raw['name'] : null;
  if (name === null) throw new FaultPlanError('plan : « name » absent');
  for (const key of Object.keys(raw)) {
    if (isDurationKey(key)) throw new FaultPlanError(`plan « ${name} » : champ de durée « ${key} » interdit`);
    if (!PLAN_KEYS.includes(key)) throw new FaultPlanError(`plan « ${name} » : champ inconnu « ${key} »`);
  }
  const options = raw['options'] ?? {};
  if (!isObject(options)) throw new FaultPlanError(`plan « ${name} » : « options » objet attendu`);
  for (const key of Object.keys(options)) if (!OPTION_KEYS.includes(key)) throw new FaultPlanError(`plan « ${name} » : option inconnue « ${key} »`);
  // Présente, l'option est un booléen (`null` refusé, comme Rust) ; absente : faux.
  const removeLeavesPlaceholder = 'removeLeavesPlaceholder' in options ? options['removeLeavesPlaceholder'] : false;
  if (typeof removeLeavesPlaceholder !== 'boolean') throw new FaultPlanError(`plan « ${name} » : « removeLeavesPlaceholder » booléen attendu`);
  const faults = raw['faults'];
  if (!Array.isArray(faults)) throw new FaultPlanError(`plan « ${name} » : « faults » tableau attendu`);
  const seen = new Set<string>();
  return { name, faults: faults.map((entry, index) => parseEntry(entry, index, name, seen)), options: { removeLeavesPlaceholder } };
}

/**
 * `JSON.parse` qui refuse comme serde un nombre écrit autrement qu'en entier décimal (`1.0`, `1e0`, `-0`) : il devient `NaN`, refusé
 * ensuite par le contrôle du champ (rang, `times`, `resurrectAfterCycles`, `schema`) avec le même message que Rust. Les plans ne
 * portent que des entiers.
 */
function parseStrictJson(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown, context?: { readonly source?: string }) =>
    typeof value === 'number' && typeof context?.source === 'string' && !/^-?(?:0|[1-9]\d*)$/.test(context.source) ? Number.NaN : value,
  );
}

/** Lecture stricte d'un plan écrit en texte JSON (fixtures) : nombres non entiers refusés comme par serde. */
export function parseFaultPlanText(text: string): FaultPlan {
  return parseFaultPlan(parseStrictJson(text));
}

/**
 * Lecture stricte d'un fichier de plans (`{ $comment, schema: 1, plans: [...] }`), mêmes messages que `parse_file` de `fault_plan.rs` :
 * racine, schéma, noms de plans uniques.
 */
export function parseFaultPlanFile(text: string): FaultPlan[] {
  const root = parseStrictJson(text);
  if (!isObject(root)) throw new FaultPlanError('fichier de plans : objet attendu');
  for (const key of Object.keys(root)) if (!['$comment', 'schema', 'plans'].includes(key)) throw new FaultPlanError(`fichier de plans : champ inconnu « ${key} »`);
  if (root['schema'] !== 1) throw new FaultPlanError('fichier de plans : « schema » 1 attendu');
  const plans = root['plans'];
  if (!Array.isArray(plans)) throw new FaultPlanError('fichier de plans : « plans » tableau attendu');
  const out: FaultPlan[] = [];
  for (const raw of plans) {
    const plan = parseFaultPlan(raw);
    if (out.some((p) => p.name === plan.name)) throw new FaultPlanError(`fichier de plans : plan « ${plan.name} » en double`);
    out.push(plan);
  }
  return out;
}

/** Le chemin `path` (composants séparés par `/`, `/` final pour un dossier) correspond-il au motif ? Joker `*` dans un composant. */
export function matchFaultPath(pattern: string, path: string): boolean {
  if (pattern.endsWith('/') !== path.endsWith('/')) return false;
  const a = pattern.replace(/\/$/, '').split('/');
  const b = path.replace(/\/$/, '').split('/');
  if (a.length !== b.length) return false;
  return a.every((part, i) => new RegExp(`^${part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(b[i] ?? ''));
}

/** Appel touché par une entrée (journal des pannes rejouées, comparé d'une exécution à l'autre : déterminisme). */
export interface FaultFiring {
  readonly id: string;
  readonly op: FaultOp;
  readonly path: string;
  /** Rang de l'appel pour cette entrée. */
  readonly call: number;
}

/**
 * Compteurs d'un plan armé : chaque appel de `op` sur un chemin qui correspond au motif d'une entrée incrémente le compteur de cette entrée ;
 * l'entrée se déclenche si le compteur est dans `[nth, nth + times - 1]`. Plusieurs entrées déclenchées par le même appel : la première du
 * plan l'emporte (les autres comptent quand même l'appel).
 */
export class FaultCounters {
  private readonly counts = new Map<string, number>();
  private readonly log: FaultFiring[] = [];

  constructor(readonly plan: FaultPlan) {}

  hit(op: FaultOp, path: string): FaultEntry | null {
    let fired: FaultEntry | null = null;
    for (const entry of this.plan.faults) {
      if (entry.op !== op || !matchFaultPath(entry.file, path)) continue;
      const call = (this.counts.get(entry.id) ?? 0) + 1;
      this.counts.set(entry.id, call);
      const inRange = call >= entry.nth && (entry.times === 'all' || call < entry.nth + entry.times);
      if (inRange && fired === null) {
        fired = entry;
        this.log.push({ id: entry.id, op, path, call });
      }
    }
    return fired;
  }

  /** Pannes rejouées, dans l'ordre. */
  fired(): readonly FaultFiring[] {
    return [...this.log];
  }

  /** Entrées jamais déclenchées (un test peut exiger qu'aucune panne armée ne soit restée sans effet). */
  unfired(): readonly string[] {
    const ids = new Set(this.log.map((f) => f.id));
    return this.plan.faults.filter((e) => !ids.has(e.id)).map((e) => e.id);
  }
}
