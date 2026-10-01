import type { DeviceId, HexColor, Hlc, IsoDateTime, SpaceId } from '../../domain/types';

/**
 * Identifiants et valeurs stables des espaces Pro et Perso (ES-01, PRD section 5),
 * créés par la migration `0001_core_tables` (data-model). Ces constantes sont
 * gravées dans une migration déjà appliquée : ne jamais les changer ; un
 * changement de nom ou de couleur par défaut passe par une mise à jour (ES-01),
 * pas par une modification de ces valeurs.
 */
export const SPACE_PRO_ID = '00000000-0000-4000-8000-000000000001' as SpaceId;
export const SPACE_PERSO_ID = '00000000-0000-4000-8000-000000000002' as SpaceId;

/** Couleurs validées (PRD section 5, maquettes). */
export const SPACE_PRO_COLOR = '#2f6b7a' as HexColor;
export const SPACE_PERSO_COLOR = '#b5483b' as HexColor;

export const SPACE_PRO_NAME = 'Pro';
export const SPACE_PERSO_NAME = 'Perso';

/**
 * Appareil « système » utilisé pour les colonnes de synchro des lignes écrites
 * par une migration (aucun appareil réel ne les a produites). `SEED_HLC` est
 * délibérément antérieur à toute écriture réelle (partie temporelle à zéro) :
 * la première écriture locale sur ces lignes aura toujours un hlc plus grand.
 */
export const SEED_DEVICE_ID = '00000000-0000-4000-8000-000000000000' as DeviceId;
export const SEED_AT = '2026-01-01T00:00:00.000Z' as IsoDateTime;
export const SEED_HLC = `000000000000000-0000-${SEED_DEVICE_ID}` as Hlc;
