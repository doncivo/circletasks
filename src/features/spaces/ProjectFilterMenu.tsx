import { activeProjectsOf, isProjectFilterAvailable } from '../../domain/projectRules';
import type { ProjectId } from '../../domain/types';
import { t } from '../../i18n';
import { DropdownSelect, SpacePills } from '../../ui';
import { useAppStore } from '../app/appStore';
import { useEffectiveProjectFilter } from './useSpaceDefaults';
import './ProjectFilterMenu.css';

/**
 * Menu « Projet : tous » (QB-15, ES-04 critère 6), à droite des pastilles Pro / Perso / Tout d'Aujourd'hui, de la Semaine et d'Un jour.
 * Visible seulement quand l'espace filtré (Pro ou Perso) a au moins un projet actif ; masqué en « Tout » et pour un espace sans
 * projet, sans filtre projet appliqué alors. Choisir un projet restreint ces listes à ses tâches ; « Tous les projets » retire le filtre.
 * L'état est global (`useAppStore.projectFilter`), comme le filtre d'espace.
 */
export function ProjectFilterMenu() {
  const spaceFilter = useAppStore((s) => s.spaceFilter);
  const projects = useAppStore((s) => s.projects);
  const setProjectFilter = useAppStore((s) => s.setProjectFilter);
  const current = useEffectiveProjectFilter();
  if (!isProjectFilterAvailable(spaceFilter, projects)) return null;
  const choices = activeProjectsOf(projects, spaceFilter);
  const selected = choices.find((project) => project.id === current);
  return (
    <DropdownSelect
      variant="pill"
      className="ct-project-filter"
      label={t('spaces.projectFilterLabel')}
      options={[{ value: '', label: t('spaces.projectFilterAll') }, ...choices.map((project) => ({ value: project.id, label: project.name }))]}
      value={current ?? ''}
      display={selected ? t('spaces.projectField', { name: selected.name }) : t('spaces.projectFilterFieldAll')}
      onChange={(value) => setProjectFilter(value === '' ? null : (value as ProjectId))}
    />
  );
}

/** Pastilles d'espace suivies du menu de projet (Aujourd'hui, Semaine, Un jour) : une seule rangée, un seul état global. */
export function SpaceFilterBar() {
  const spaces = useAppStore((s) => s.spaces);
  const spaceFilter = useAppStore((s) => s.spaceFilter);
  const setSpaceFilter = useAppStore((s) => s.setSpaceFilter);
  return (
    <div className="ct-filter-bar">
      <SpacePills items={spaces} value={spaceFilter} onChange={setSpaceFilter} />
      <ProjectFilterMenu />
    </div>
  );
}
