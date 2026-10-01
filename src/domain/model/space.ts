import type { HexColor, LocalTime, ProjectId, SpaceId, SyncMeta, Weekday } from '../types';

/**
 * Plage silencieuse d'un espace (ES-07, appliquée à l'ordre 5 par notifications) :
 * aucun rappel de l'espace entre `from` et `to` les jours listés ; une plage dont
 * `to` < `from` traverse minuit (19:00 → 08:00). Stockée en JSON dans `space.quiet_hours`.
 */
export interface QuietHours {
  readonly weekdays: readonly Weekday[];
  readonly from: LocalTime;
  readonly to: LocalTime;
}

/** Espace Pro ou Perso (M13). Table `space`. */
export interface Space extends SyncMeta {
  readonly id: SpaceId;
  readonly name: string;
  readonly color: HexColor;
  readonly sortOrder: number;
  readonly quietHours: readonly QuietHours[];
}

/** Projet facultatif rattaché à un espace (ES-04). Table `project`. */
export interface Project extends SyncMeta {
  readonly id: ProjectId;
  readonly spaceId: SpaceId;
  readonly name: string;
  readonly color: HexColor;
  readonly archived: boolean;
  readonly sortOrder: number;
}

export type SpaceFields = Omit<Space, keyof SyncMeta>;
export type NewSpace = SpaceFields & { readonly id: SpaceId };
export type SpacePatch = Partial<SpaceFields>;

export type ProjectFields = Omit<Project, keyof SyncMeta>;
export type NewProject = ProjectFields & { readonly id: ProjectId };
export type ProjectPatch = Partial<ProjectFields>;
