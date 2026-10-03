import type { Migration } from '../migrator';
import { SPACE_PRO_ID } from '../seed/defaultSpaces';

/**
 * ES-07 critère 1 : plages silencieuses par défaut de l'espace Pro (chaque soir 19:00 → 08:00, dimanche soir compris, et samedi +
 * dimanche en entier). Migration de DONNÉES : la colonne `space.quiet_hours` existe depuis 0001 (vide : `[]`). Elle ne touche que
 * Pro, et seulement si ses plages sont encore vides : une plage déjà réglée par l'utilisateur est conservée. Rejouable sans effet.
 *
 * Le texte JSON est figé ici (une migration publiée ne change plus) ; il reprend `DEFAULT_PRO_QUIET_HOURS` (src/domain/quietHours.ts),
 * ce que vérifie `0007_pro_quiet_hours.test.ts`. Ni `updated_at` ni `hlc` ne sont modifiés : la ligne reste celle du semis (hlc d'origine),
 * donc toute modification réelle d'un appareil l'emporte à la synchro ; chaque appareil applique les mêmes valeurs.
 */
export const PRO_QUIET_HOURS_JSON =
  '[{"weekdays":[1,2,3,4,5,6,7],"from":"19:00","to":"08:00"},{"weekdays":[6,7],"from":"00:00","to":"00:00"}]';

export const migration0007ProQuietHours: Migration = {
  version: 7,
  name: 'pro_quiet_hours',
  statements: [`UPDATE space SET quiet_hours = '${PRO_QUIET_HOURS_JSON}' WHERE id = '${SPACE_PRO_ID}' AND quiet_hours = '[]'`],
};
