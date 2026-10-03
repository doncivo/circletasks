import { projectChoicesFor } from '../../domain/projectRules';
import type { ProjectId, SpaceId } from '../../domain/types';
import { t } from '../../i18n';
import { DropdownSelect } from '../../ui';
import { useAppStore } from '../app/appStore';

export interface ProjectSelectProps {
  /** Espace de l'élément : seuls les projets actifs de cet espace sont proposés (ES-04 critère 4). */
  readonly spaceId: SpaceId | null;
  readonly value: ProjectId | null;
  readonly onChange: (projectId: ProjectId | null) => void;
  readonly variant?: 'field' | 'pill';
}

/**
 * Liste « Projet : aucun ▾ » (Ajout.html, fiche détail) : « Aucun » puis les projets actifs de l'espace de l'élément, dans l'ordre
 * des Réglages. Le projet déjà porté par l'élément reste visible même archivé (« Mission (archivé) », ES-04 critère 5) sans être
 * proposé aux autres. Un projet n'est jamais obligatoire.
 */
export function ProjectSelect({ spaceId, value, onChange, variant = 'field' }: ProjectSelectProps) {
  const projects = useAppStore((s) => s.projects);
  const choices = spaceId ? projectChoicesFor(projects, spaceId, value) : [];
  const label = (project: (typeof choices)[number]): string => (project.archived ? t('spaces.projectArchivedOption', { name: project.name }) : project.name);
  const selected = choices.find((project) => project.id === value);
  return (
    <DropdownSelect
      variant={variant}
      label={t('spaces.projectLabel')}
      options={[{ value: '', label: t('spaces.projectNone') }, ...choices.map((project) => ({ value: project.id, label: label(project) }))]}
      value={selected ? selected.id : ''}
      display={selected ? t('spaces.projectField', { name: label(selected) }) : t('spaces.projectFieldNone')}
      onChange={(next) => onChange(next === '' ? null : (next as ProjectId))}
      disabled={spaceId === null}
    />
  );
}
