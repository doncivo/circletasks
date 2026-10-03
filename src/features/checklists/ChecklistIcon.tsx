import { ListChecks } from 'lucide-react';
import type { IconRef } from '../../domain/model';
import { Icon, IconView, resolveIconRefColor } from '../../ui';

/**
 * Icône d'une checklist (C-01, migration 0008) : l'icône ou l'emoji choisi, sinon l'icône « liste » par défaut en vert
 * (Checklists.html : trait #3E7C5A).
 */
export function ChecklistIcon({ icon, size }: { icon: IconRef | null; size: number }) {
  if (icon) return <IconView icon={icon} size={size} color={resolveIconRefColor(icon)} />;
  return <Icon icon={ListChecks} size={size} color="var(--ct-color-icon-green)" />;
}
