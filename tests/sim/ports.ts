/**
 * Ports des serveurs de la suite e2e (Playwright). Ils sont configurables pour que deux copies de travail (agents, worktrees) lancent
 * leurs tests en même temps sans collision (EADDRINUSE) et sans qu'un test vise le serveur d'une autre copie.
 *
 * - Sans variable : valeurs historiques, inchangées (CI comprise) : Vite 1420, Google 53701, CalDAV 53702, dossier iCloud 53703.
 * - `CT_E2E_PORT_BASE=<n>` : Vite sur n, Google n+1, CalDAV n+2, dossier iCloud n+3. Prendre des bases distantes d'au moins 10 par copie
 *   (ex. 41000, 41010) et libres (`netstat -ano | findstr :41000`).
 *
 * Lu par playwright.config.ts, vite.config.ts (port du serveur lancé par Playwright), tests/e2e/globalSetup.ts et les helpers e2e.
 * Les simulateurs d'agendas sont lancés par `globalSetup` ; le serveur de développement les connaît par `VITE_CT_GOOGLE_SIM` et
 * `VITE_CT_CALDAV_SIM` (playwright.config.ts). Les tests qui modifient l'état d'un simulateur (révocation, erreur injectée,
 * événements) en démarrent un à eux sur un port libre (tests/e2e/helpers/calendars.ts) : deux workers ne partagent jamais un état modifiable.
 */
function portBase(): number | null {
  const raw = process.env['CT_E2E_PORT_BASE'];
  if (raw === undefined || raw === '') return null;
  const base = Number(raw);
  if (!Number.isInteger(base) || base < 1024 || base > 65_530) throw new Error(`CT_E2E_PORT_BASE invalide : « ${raw} » (entier de 1024 à 65530 attendu)`);
  return base;
}

const BASE = portBase();

/** Port du serveur de développement Vite lancé par Playwright (1420 par défaut, comme `devUrl` de src-tauri/tauri.conf.json). */
export const E2E_DEV_PORT = BASE ?? 1420;

/** Ports des simulateurs d'agendas Google et CalDAV (ADR 0008). */
export const E2E_SIM_PORTS = BASE === null ? ({ google: 53701, caldav: 53702 } as const) : ({ google: BASE + 1, caldav: BASE + 2 } as const);

/** URL de base d'un simulateur local sur son port. */
export const simUrl = (port: number): string => `http://127.0.0.1:${String(port)}`;

/**
 * Port du simulateur de dossier iCloud (Y-04, parcours 10 à deux pages ; `tests/sim/syncFolderSim.ts`), lancé par `globalSetup`.
 * Chaque test y ouvre son propre espace (`room`) : aucun état modifiable partagé entre workers.
 */
export const E2E_SYNC_SIM_PORT = BASE === null ? 53703 : BASE + 3;
