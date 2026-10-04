/**
 * Catalogue d'icônes Lucide adressables par nom kebab-case (`IconRef`, T-03).
 *
 * `Icon.tsx` exige un composant importé nommément par l'appelant (tree-shaking,
 * ADR 0001) : ce fichier est le seul endroit qui relie un nom stocké en base
 * (`icon` d'une tâche, routine, objectif…) à son composant Lucide, sa couleur de
 * trait (jeton CSS, jamais une couleur par tâche) et son libellé accessible
 * (`src/i18n`). Les noms autorisés sont ceux de `ICON_NAMES`
 * (`src/domain/model/icon.ts`, seule source de vérité) : ce fichier fournit une
 * entrée pour chacun, vérifié par `iconCatalog.test.ts`. Toute icône
 * supplémentaire s'ajoute d'abord à `ICON_NAMES`, puis ici.
 */
import {
  Bed,
  BookOpen,
  Briefcase,
  Cake,
  Calendar,
  Car,
  Cat,
  ChartBar,
  Clock,
  CreditCard,
  Dog,
  Dumbbell,
  FileText,
  Gift,
  GlassWater,
  GraduationCap,
  Heart,
  House,
  Mail,
  Phone,
  PiggyBank,
  Plane,
  ShoppingBasket,
  ShoppingCart,
  Star,
  Target,
  Trash,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { ICON_NAMES, type IconName, type IconRef } from '../domain/model/icon';
import type { PlainMessageKey } from '../i18n';

export interface IconCatalogEntry {
  readonly component: LucideIcon;
  /** Jeton CSS de couleur (`src/ui/theme/tokens.css`), ex. `var(--ct-color-icon-green)`. */
  readonly color: string;
  /** Clé i18n du libellé accessible français (« Icône téléphone »), critère 6. */
  readonly labelKey: PlainMessageKey;
}

export const ICON_CATALOG_ENTRIES: Readonly<Record<IconName, IconCatalogEntry>> = {
  bed: { component: Bed, color: 'var(--ct-color-icon-amber)', labelKey: 'icons.bed' },
  'book-open': { component: BookOpen, color: 'var(--ct-color-icon-green)', labelKey: 'icons.bookOpen' },
  briefcase: { component: Briefcase, color: 'var(--ct-color-icon-blue)', labelKey: 'icons.briefcase' },
  cake: { component: Cake, color: 'var(--ct-color-icon-red)', labelKey: 'icons.cake' },
  calendar: { component: Calendar, color: 'var(--ct-color-icon-blue)', labelKey: 'icons.calendar' },
  car: { component: Car, color: 'var(--ct-color-icon-purple)', labelKey: 'icons.car' },
  cat: { component: Cat, color: 'var(--ct-color-icon-amber)', labelKey: 'icons.cat' },
  'chart-bar': { component: ChartBar, color: 'var(--ct-color-icon-skyblue)', labelKey: 'icons.chartBar' },
  clock: { component: Clock, color: 'var(--ct-color-icon-purple)', labelKey: 'icons.clock' },
  'credit-card': { component: CreditCard, color: 'var(--ct-color-icon-green)', labelKey: 'icons.creditCard' },
  dog: { component: Dog, color: 'var(--ct-color-icon-red)', labelKey: 'icons.dog' },
  dumbbell: { component: Dumbbell, color: 'var(--ct-color-icon-purple)', labelKey: 'icons.dumbbell' },
  'file-text': { component: FileText, color: 'var(--ct-color-icon-red)', labelKey: 'icons.fileText' },
  gift: { component: Gift, color: 'var(--ct-color-icon-red)', labelKey: 'icons.gift' },
  'glass-water': { component: GlassWater, color: 'var(--ct-color-icon-skyblue)', labelKey: 'icons.glassWater' },
  'graduation-cap': { component: GraduationCap, color: 'var(--ct-color-icon-blue)', labelKey: 'icons.graduationCap' },
  heart: { component: Heart, color: 'var(--ct-color-icon-red)', labelKey: 'icons.heart' },
  house: { component: House, color: 'var(--ct-color-icon-amber)', labelKey: 'icons.house' },
  mail: { component: Mail, color: 'var(--ct-color-icon-blue)', labelKey: 'icons.mail' },
  phone: { component: Phone, color: 'var(--ct-color-icon-green)', labelKey: 'icons.phone' },
  'piggy-bank': { component: PiggyBank, color: 'var(--ct-color-icon-amber)', labelKey: 'icons.piggyBank' },
  plane: { component: Plane, color: 'var(--ct-color-icon-skyblue)', labelKey: 'icons.plane' },
  'shopping-basket': { component: ShoppingBasket, color: 'var(--ct-color-icon-green)', labelKey: 'icons.shoppingBasket' },
  'shopping-cart': { component: ShoppingCart, color: 'var(--ct-color-icon-purple)', labelKey: 'icons.shoppingCart' },
  star: { component: Star, color: 'var(--ct-color-icon-amber)', labelKey: 'icons.star' },
  target: { component: Target, color: 'var(--ct-color-icon-red)', labelKey: 'icons.target' },
  trash: { component: Trash, color: 'var(--ct-color-icon-skyblue)', labelKey: 'icons.trash' },
  'triangle-alert': { component: TriangleAlert, color: 'var(--ct-color-icon-amber)', labelKey: 'icons.triangleAlert' },
  wrench: { component: Wrench, color: 'var(--ct-color-icon-purple)', labelKey: 'icons.wrench' },
};

/** Composant Lucide par nom, pour `IconView` et la ligne de liste (lecture seule). */
export const ICON_CATALOG: Readonly<Record<string, LucideIcon>> = Object.fromEntries(
  ICON_NAMES.map((name) => [name, ICON_CATALOG_ENTRIES[name].component]),
);

/** Composant Lucide pour un nom kebab-case du catalogue, ou `null` si inconnu. */
export function resolveIconComponent(name: string): LucideIcon | null {
  return ICON_CATALOG[name] ?? null;
}

/** Couleur (jeton CSS) d'une icône du catalogue, ou `null` si le nom est inconnu. */
export function resolveIconColor(name: string): string | null {
  return (ICON_CATALOG_ENTRIES as Readonly<Record<string, IconCatalogEntry>>)[name]?.color ?? null;
}

/** Clé i18n du libellé accessible d'une icône du catalogue (critère 6), ou `null`. */
export function resolveIconLabelKey(name: string): PlainMessageKey | null {
  return (ICON_CATALOG_ENTRIES as Readonly<Record<string, IconCatalogEntry>>)[name]?.labelKey ?? null;
}

/**
 * Couleur d'affichage d'un `IconRef` déjà choisi (ligne de liste, pastille de la
 * fiche détail) : jeton par icône Lucide, `currentColor` pour un nom inconnu ou un
 * emoji (sans effet sur son rendu). Point unique pour éviter la logique dupliquée
 * (anciens `iconColorOf` / `colorOf` de `TodayScreen` et `TaskDetail`).
 */
export function resolveIconRefColor(icon: IconRef): string {
  return icon.kind === 'lucide' ? (resolveIconColor(icon.name) ?? 'currentColor') : 'currentColor';
}
