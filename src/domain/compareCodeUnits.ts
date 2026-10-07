/**
 * Comparateur par unités de code (jamais `localeCompare`) : ordre stable et identique sur tous les appareils, pour les tris dont le
 * résultat doit être déterministe (identifiants du plan de notifications, ADR 0012). À passer explicitement à `.sort`.
 */
export const compareCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
