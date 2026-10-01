/**
 * Catalogue d'icônes Lucide adressables par nom kebab-case (`IconRef`, T-03).
 *
 * `Icon.tsx` exige un composant importé nommément par l'appelant (tree-shaking,
 * ADR 0001) : ce fichier est le seul endroit qui relie un nom stocké en base
 * (`icon` d'une tâche, routine, objectif…) à son composant Lucide. Les noms
 * viennent des maquettes (docs/maquettes/Ajout.html et suivants) ; toute icône
 * supplémentaire proposée dans le sélecteur d'icônes s'ajoute ici.
 *
 * Un nom absent du catalogue est un cas normal (version future, migration) :
 * `resolveIconComponent` renvoie `null`, à charge de l'appelant d'afficher un
 * repli (ex. une icône générique ou rien).
 */
import {
  BookOpen,
  Briefcase,
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
  ShoppingCart,
  Target,
  Trash,
  TriangleAlert,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

export const ICON_CATALOG: Readonly<Record<string, LucideIcon>> = {
  'book-open': BookOpen,
  briefcase: Briefcase,
  calendar: Calendar,
  car: Car,
  cat: Cat,
  'chart-bar': ChartBar,
  clock: Clock,
  'credit-card': CreditCard,
  dog: Dog,
  dumbbell: Dumbbell,
  'file-text': FileText,
  gift: Gift,
  'glass-water': GlassWater,
  'graduation-cap': GraduationCap,
  heart: Heart,
  house: House,
  mail: Mail,
  phone: Phone,
  'piggy-bank': PiggyBank,
  plane: Plane,
  'shopping-cart': ShoppingCart,
  target: Target,
  trash: Trash,
  'triangle-alert': TriangleAlert,
  wrench: Wrench,
};

/** Composant Lucide pour un nom kebab-case du catalogue, ou `null` si inconnu. */
export function resolveIconComponent(name: string): LucideIcon | null {
  return ICON_CATALOG[name] ?? null;
}
