import { nowIso, type Clock } from './clock';
import { isId, type DeviceId, type Hlc, type IsoDateTime } from './types';

/**
 * Horloge logique hybride (HLC, Kulkarni et al. 2014), ADR 0005.
 *
 * Format texte (colonne `hlc`, lignes de journal) :
 *   `<ms : 15 chiffres décimaux>-<compteur : 4 hexa>-<device_id : UUID>`
 *   ex. `001759312800000-0000-0f8fad5b-d9cb-469f-a165-70867728950e`
 * Largeurs fixes : l'ordre lexicographique des chaînes est l'ordre causal, l'UUID
 * de l'appareil départage deux écritures au même (ms, compteur).
 */
export interface HlcTimestamp {
  readonly ms: number;
  readonly counter: number;
  readonly deviceId: DeviceId;
}

export const HLC_MAX_COUNTER = 0xffff;
const MS_WIDTH = 15;
const HLC_RE = /^(\d{15})-([0-9a-f]{4})-(.+)$/;

export function formatHlc(t: HlcTimestamp): Hlc {
  if (!Number.isSafeInteger(t.ms) || t.ms < 0 || t.ms >= 10 ** MS_WIDTH) {
    throw new RangeError(`HLC : temps physique invalide (${String(t.ms)})`);
  }
  if (!Number.isInteger(t.counter) || t.counter < 0 || t.counter > HLC_MAX_COUNTER) {
    throw new RangeError(`HLC : compteur invalide (${String(t.counter)})`);
  }
  if (!isId(t.deviceId)) throw new TypeError(`HLC : device_id invalide (${t.deviceId})`);
  return `${String(t.ms).padStart(MS_WIDTH, '0')}-${t.counter.toString(16).padStart(4, '0')}-${t.deviceId}` as Hlc;
}

export function parseHlc(value: string): HlcTimestamp {
  const m = HLC_RE.exec(value);
  const deviceId = m?.[3];
  if (!m || deviceId === undefined || !isId(deviceId)) throw new TypeError(`HLC invalide : « ${value} »`);
  return { ms: Number(m[1]), counter: parseInt(m[2] ?? '0', 16), deviceId: deviceId as DeviceId };
}

export function isHlc(value: string): value is Hlc {
  try {
    parseHlc(value);
    return true;
  } catch {
    return false;
  }
}

/** Ordre total des HLC : négatif si a < b, 0 si égaux, positif si a > b. */
export function compareHlc(a: Hlc, b: Hlc): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Générateur HLC d'un appareil. Une instance par app, créée au démarrage. */
export interface HlcClock {
  readonly deviceId: DeviceId;
  /** Nouvelle valeur pour une écriture locale ; strictement croissante. */
  now(): Hlc;
  /**
   * Intègre une valeur reçue d'un autre appareil (lecture de journal, ordre 4) et
   * renvoie une valeur locale strictement supérieure aux deux.
   */
  receive(remote: Hlc): Hlc;
  /** Dernière valeur émise ou reçue (null avant la première). */
  last(): Hlc | null;
}

export interface HlcClockOptions {
  readonly clock: Clock;
  readonly deviceId: DeviceId;
  /**
   * Plus grand hlc déjà présent en base (tous appareils confondus), lu au démarrage :
   * garantit la monotonie même si l'horloge système a reculé depuis.
   */
  readonly seed?: Hlc | null;
}

export function createHlcClock(options: HlcClockOptions): HlcClock {
  const { clock, deviceId } = options;
  let lastMs = 0;
  let lastCounter = -1;
  let hasLast = false;
  if (options.seed) {
    const seed = parseHlc(options.seed);
    lastMs = seed.ms;
    lastCounter = seed.counter;
    hasLast = true;
  }

  const emit = (ms: number, counter: number): Hlc => {
    // Débordement du compteur : on avance le temps logique d'une milliseconde.
    if (counter > HLC_MAX_COUNTER) {
      ms += 1;
      counter = 0;
    }
    lastMs = ms;
    lastCounter = counter;
    hasLast = true;
    return formatHlc({ ms, counter, deviceId });
  };

  return {
    deviceId,
    now: () => {
      const physical = clock.nowMs();
      return physical > lastMs ? emit(physical, 0) : emit(lastMs, lastCounter + 1);
    },
    receive: (remote) => {
      const r = parseHlc(remote);
      const physical = clock.nowMs();
      const ms = Math.max(physical, lastMs, r.ms);
      let counter: number;
      if (ms === lastMs && ms === r.ms) counter = Math.max(lastCounter, r.counter) + 1;
      else if (ms === lastMs) counter = lastCounter + 1;
      else if (ms === r.ms) counter = r.counter + 1;
      else counter = 0;
      return emit(ms, counter);
    },
    last: () => (hasLast ? formatHlc({ ms: lastMs, counter: Math.max(lastCounter, 0), deviceId }) : null),
  };
}

/**
 * Colonnes de synchro posées par chaque écriture locale (ADR 0005) :
 * `updated_at = at` (et `created_at = at` à l'insertion), `device_id`, `hlc`.
 */
export interface WriteStamp {
  readonly at: IsoDateTime;
  readonly deviceId: DeviceId;
  readonly hlc: Hlc;
}

/** Fournit un tampon par ligne écrite. Injecté dans les repositories. */
export interface WriteStamper {
  next(): WriteStamp;
}

export function createWriteStamper(clock: Clock, hlc: HlcClock): WriteStamper {
  return {
    next: () => ({ at: nowIso(clock), deviceId: hlc.deviceId, hlc: hlc.now() }),
  };
}
