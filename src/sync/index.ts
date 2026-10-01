/**
 * Synchronisation par journaux chiffrés dans iCloud Drive (ordre 4, agent sync-icloud).
 * Couche autorisée à dépendre de domain, db et platform ; jamais de features ni d'ui.
 * Format et générateur hlc : src/domain/hlc.ts (ADR 0005). Format de journal et
 * schema_version : à définir par ADR avant implémentation.
 */
export {};
