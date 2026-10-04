/**
 * Icône d'un élément (tâche, routine, objectif, événement) : un seul champ `icon`
 * par ligne (PRD section 6), qui contient soit une icône Lucide, soit un emoji (T-03).
 *
 * Forme en base (colonne TEXT) : 'lucide:<nom-kebab>' ou 'emoji:<caractères>'.
 * Le nom Lucide est celui du catalogue lucide (ex. 'file-text', 'glass-water') ;
 * la couleur de l'icône vient du thème, jamais de la base (pas de couleur par tâche).
 */
export type IconRef =
  | { readonly kind: 'lucide'; readonly name: string }
  | { readonly kind: 'emoji'; readonly value: string };

/**
 * Catalogue fermé des icônes Lucide autorisées dans `IconRef` (T-03, sous-tâche 2) :
 * seule source de vérité du domaine. `src/ui/iconCatalog.ts` importe cette liste
 * pour associer à chaque nom un composant Lucide, une couleur de jeton et un
 * libellé i18n (`IconPicker`) : un nom qui n'y figure pas n'est jamais accepté par
 * `isValidIconRef`, et `parseIcon` le traite comme une tâche sans icône. Noms venus
 * des maquettes (docs/maquettes/Ajout.html et la proposition de la fiche T-03 :
 * téléphone, document, calendrier, sport, livre, verre d'eau, lit, panier) et des
 * besoins proches (routines R-01, objectifs).
 */
export const ICON_NAMES = [
  'bed',
  'book-open',
  'briefcase',
  'cake',
  'calendar',
  'car',
  'cat',
  'chart-bar',
  'clock',
  'credit-card',
  'dog',
  'dumbbell',
  'file-text',
  'gift',
  'glass-water',
  'graduation-cap',
  'heart',
  'house',
  'mail',
  'phone',
  'piggy-bank',
  'plane',
  'shopping-basket',
  'shopping-cart',
  'star',
  'target',
  'trash',
  'triangle-alert',
  'wrench',
] as const;

export type IconName = (typeof ICON_NAMES)[number];

const ICON_NAME_SET: ReadonlySet<string> = new Set(ICON_NAMES);

/** Un emoji composé (drapeau, famille, teinte) tient en quelques points de code. */
export const EMOJI_MAX_LENGTH = 16;

/**
 * Compte les graphèmes (caractères perçus par l'utilisateur) d'une chaîne :
 * `Intl.Segmenter` quand le moteur le fournit (PC Windows, iOS récents) ; à
 * défaut, repli sur le compte de points de code Unicode (`Array.from`), qui
 * sous-compte rarement en pratique pour un seul emoji composé (ZWJ, teintes).
 */
function graphemeCount(value: string): number {
  const SegmenterCtor = (Intl as { Segmenter?: new (locale?: string, options?: { granularity: 'grapheme' }) => { segment(input: string): Iterable<unknown> } }).Segmenter;
  if (SegmenterCtor) {
    const segmenter = new SegmenterCtor(undefined, { granularity: 'grapheme' });
    return Array.from(segmenter.segment(value)).length;
  }
  return Array.from(value).length;
}

/** Un nom Lucide connu du catalogue (`ICON_NAMES`), ou un emoji d'un seul graphème. */
export function isValidIconRef(icon: IconRef): boolean {
  if (icon.kind === 'lucide') return ICON_NAME_SET.has(icon.name);
  const value = icon.value;
  return value.length > 0 && value.length <= EMOJI_MAX_LENGTH && !/\s/.test(value) && graphemeCount(value) === 1;
}

/** Sérialise pour la colonne `icon` ; lève une erreur si l'icône est invalide. */
export function encodeIcon(icon: IconRef): string {
  if (!isValidIconRef(icon)) throw new TypeError('Icône invalide');
  return icon.kind === 'lucide' ? `lucide:${icon.name}` : `emoji:${icon.value}`;
}

/** Lit la colonne `icon` ; `null` si vide ou illisible (valeur venue d'une version future). */
export function parseIcon(stored: string | null): IconRef | null {
  if (stored === null) return null;
  const sep = stored.indexOf(':');
  if (sep < 0) return null;
  const prefix = stored.slice(0, sep);
  const body = stored.slice(sep + 1);
  const icon: IconRef | null =
    prefix === 'lucide' ? { kind: 'lucide', name: body } : prefix === 'emoji' ? { kind: 'emoji', value: body } : null;
  return icon && isValidIconRef(icon) ? icon : null;
}
