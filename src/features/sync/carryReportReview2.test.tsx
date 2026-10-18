// Y-TECH-05, contre-revue : « Voir » quand Détails est déjà affiché (demande observable puis consommée), section AVERTISSEMENTS quand
// `carry-report` est seul levé, ligne d'état unique pour les e2e (`.ct-sync__sub`). Même harnais que carryReportBanner.test.tsx.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHlcClock } from "../../domain/hlc";
import type {
  EpochCarryReportBody,
  EpochCarryReportHead,
} from "../../domain/sync/epochCarryReport";
import {
  asEntityId,
  type DeviceId,
  type IsoDateTime,
} from "../../domain/types";
import { openTestDb, type TestDb } from "../../db/repositories/sql/testSetup";
import { t } from "../../i18n";
import { AppContainerProvider } from "../app/AppContainerContext";
import { AppStatusBanner } from "../app/AppStatusBanner";
import { useAppStatusStore } from "../app/appStatus";
import { createAppContainer, type AppContainer } from "../app/container";
import { INITIAL_NAVIGATION, useNavigationStore } from "../app/navigation";
import { peekCarryReportOpen, requestCarryReportOpen } from "./carryReportOpen";
import { SyncDetailsScreen } from "./SyncDetailsScreen";
import { startSyncIntegration, type SyncIntegration } from "./startSync";
import { createFakeSyncService, type FakeSyncService } from "./testKit";

const SELF = asEntityId<DeviceId>("60000000-0000-4000-8000-0000000000f5");
const OTHER = asEntityId<DeviceId>("60000000-0000-4000-8000-0000000000f6");
const NOW = "2026-10-18T08:02:00.000Z" as IsoDateTime;
const NO_TIMERS = {
  setInterval: () => 0,
  clearInterval: () => undefined,
  setTimeout: () => 0,
  clearTimeout: () => undefined,
} as const;
const SLOTS = {
  pairing: null,
  conflicts: null,
  version: null,
  forget: null,
  reset: null,
} as const;
const VIEW = "Voir le problème de synchronisation";

let db: TestDb;
let container: AppContainer;
let sync: FakeSyncService;
let integration: SyncIntegration | null = null;

beforeEach(async () => {
  db = await openTestDb(SELF, NOW);
  sync = createFakeSyncService({
    phase: "idle",
    lastSyncAt: "2026-10-18T08:00:00.000Z" as IsoDateTime,
    folderLabel: "CircleTasks",
    folderKind: "icloud",
  });
  container = createAppContainer({
    clock: db.clock,
    hlc: createHlcClock({ clock: db.clock, deviceId: SELF }),
    data: db.data,
    sync,
  });
  requestCarryReportOpen(null);
});

afterEach(async () => {
  vi.restoreAllMocks();
  cleanup();
  integration?.dispose();
  integration = null;
  useNavigationStore.setState(INITIAL_NAVIGATION);
  useAppStatusStore.setState({ sources: {} });
  await db.close();
});

const head = (epoch: string, createdAt: string): EpochCarryReportHead => ({
  epoch,
  cause: "restore",
  reporter: SELF,
  opener: OTHER,
  mode: "replace",
  createdAt: createdAt as IsoDateTime,
});
const body = (labels: readonly string[]): EpochCarryReportBody => ({
  authors: [
    {
      device: OTHER,
      fields: labels.length,
      rows: labels.length,
      tombs: 0,
      late: 0,
    },
  ],
  restored: labels.map((label, i) => ({
    table: "task",
    rowId: `${label}-${String(i)}`,
    label,
    by: OTHER,
    deletedAt: "2026-10-17T09:30:00.000Z" as IsoDateTime,
    deletedBy: SELF,
  })),
  recreated: [],
  parentReplaced: [],
  overflow: 0,
  overflowBy: { restored: 0, recreated: 0, parentReplaced: 0 },
});

async function seed(
  epoch: string,
  createdAt: string,
  labels: readonly string[],
): Promise<number> {
  const reports = await db.data.repos.carryReports();
  const id = await reports.create(head(epoch, createdAt));
  await reports.save(id, body(labels), true);
  return id;
}

const tree = () => (
  <AppContainerProvider container={container}>
    <AppStatusBanner />
    <SyncDetailsScreen slots={SLOTS} />
  </AppContainerProvider>
);

async function start(
  warnings: readonly string[] = ["carry-report"],
): Promise<ReturnType<typeof render>> {
  sync.setStatus({ warnings: warnings as never });
  integration = startSyncIntegration(container, NO_TIMERS);
  await integration.refreshed();
  return render(tree());
}

describe("« Voir » avec Détails déjà affiché (contre-revue, point 2)", () => {
  it("Détails affiché, clic sur Voir : la feuille du compte rendu s’ouvre", async () => {
    await seed("2-a", "2026-10-18T07:00:00.000Z", ["A", "B"]);
    await start();
    await screen.findAllByRole("button", { name: /^Époque du / });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: VIEW }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("A")).toBeTruthy();
  });

  it("demande consommée : elle est effacée, et une réouverture de Détails n’ouvre rien", async () => {
    await seed("2-a", "2026-10-18T07:00:00.000Z", ["A"]);
    const view = await start();
    await screen.findAllByRole("button", { name: /^Époque du / });
    fireEvent.click(await screen.findByRole("button", { name: VIEW }));
    await screen.findByRole("dialog");
    expect(peekCarryReportOpen()).toBeNull();
    view.unmount();
    render(tree());
    await screen.findAllByRole("button", { name: /^Époque du / });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("demande posée avant l’affichage de Détails : la feuille s’ouvre à l’affichage, une fois", async () => {
    const id = await seed("2-a", "2026-10-18T07:00:00.000Z", ["A"]);
    requestCarryReportOpen(id);
    await start();
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(peekCarryReportOpen()).toBeNull();
  });
});

describe("section AVERTISSEMENTS (contre-revue, point 3)", () => {
  it("`carry-report` seul : le titre AVERTISSEMENTS est présent et la ligne du compte rendu est dans la section, avant les conflits", async () => {
    await seed("2-a", "2026-10-18T07:00:00.000Z", ["A"]);
    await start();
    await screen.findAllByRole("button", { name: /^Époque du / });
    const warnings = screen.getByRole("heading", {
      name: t("sync.status.sectionWarnings"),
    });
    const carry = screen.getByRole("heading", {
      name: "Compte rendu du changement d’époque",
    });
    const conflicts = screen.getByRole("heading", {
      name: t("sync.status.sectionConflicts"),
    });
    expect(
      warnings.compareDocumentPosition(carry) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      carry.compareDocumentPosition(conflicts) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Aucune autre rubrique entre le titre AVERTISSEMENTS et la ligne du compte rendu.
    const after = (a: Node, b: Node): boolean =>
      (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    const between = screen
      .getAllByRole("heading", { level: 2 })
      .filter((h) => after(warnings, h) && after(h, carry));
    expect(between).toEqual([]);
  });

  it("aucun avertissement levé : pas de section AVERTISSEMENTS (l’historique reste)", async () => {
    const reports = await db.data.repos.carryReports();
    await reports.acknowledge(
      await seed("2-a", "2026-10-18T07:00:00.000Z", ["A"]),
      NOW,
    );
    await start([]);
    await screen.findAllByRole("button", { name: /^Époque du / });
    expect(
      screen.queryByRole("heading", { name: t("sync.status.sectionWarnings") }),
    ).toBeNull();
  });

  it("la feuille ouverte reste ouverte quand `carry-report` retombe (la ligne ne change pas de place)", async () => {
    await seed("2-a", "2026-10-18T07:00:00.000Z", ["A"]);
    await start();
    fireEvent.click(
      (
        await screen.findAllByRole("button", { name: /^Époque du / })
      )[0] as HTMLElement,
    );
    await screen.findByRole("dialog");
    await act(async () => {
      sync.setStatus({ warnings: [] });
      await integration?.refreshed();
    });
    expect(
      screen.queryByRole("heading", { name: t("sync.status.sectionWarnings") }),
    ).toBeNull();
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("ligne d’état unique (contre-revue, point 1)", () => {
  it("avec des comptes rendus listés, `.ct-sync__sub` ne désigne que la ligne d’état de la synchro", async () => {
    await seed("2-a", "2026-10-18T07:00:00.000Z", ["A"]);
    await seed("3-a", "2026-10-18T07:30:00.000Z", ["B"]);
    const view = await start();
    expect(
      await screen.findAllByRole("button", { name: /^Époque du / }),
    ).toHaveLength(2);
    const subs = view.container.querySelectorAll(".ct-sync__sub");
    expect(subs).toHaveLength(1);
    expect(subs[0]?.getAttribute("data-testid")).toBe("sync-status-text");
  });
});
