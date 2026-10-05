/**
 * Ports fixes des simulateurs d'agendas pour Playwright (ADR 0008) : `globalSetup` les lance, le serveur de développement les connaît par
 * `VITE_CT_GOOGLE_SIM` et `VITE_CT_CALDAV_SIM` (playwright.config.ts). Les tests qui modifient l'état d'un simulateur (révocation, erreur
 * injectée, événements) en démarrent un à eux (tests/e2e/helpers/calendars.ts) : deux workers ne partagent jamais un état modifiable.
 */
export const E2E_SIM_PORTS = { google: 53701, caldav: 53702 } as const;

/** URL de base d'un simulateur local sur son port. */
export const simUrl = (port: number): string => `http://127.0.0.1:${String(port)}`;

/**
 * Port fixe du simulateur de dossier iCloud (Y-04, parcours 10 à deux pages ; `tests/sim/syncFolderSim.ts`), lancé par `globalSetup`.
 * Chaque test y ouvre son propre espace (`room`) : aucun état modifiable partagé entre workers.
 */
export const E2E_SYNC_SIM_PORT = 53703;
