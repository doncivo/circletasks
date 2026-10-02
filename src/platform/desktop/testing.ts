import type { DesktopPlatform, PendingUpdate, TrayLabels, UpdateProgress } from './types';

/** Faux `PendingUpdate` pour les tests. */
export interface FakePendingUpdate extends PendingUpdate {
  readonly installMock: { calls: number };
  readonly disposed: { count: number };
}

export function fakePendingUpdate(
  version: string,
  options: { notes?: string | null; install?: (onProgress: (p: UpdateProgress) => void) => Promise<void> } = {},
): FakePendingUpdate {
  const installMock = { calls: 0 };
  const disposed = { count: 0 };
  return {
    version,
    notes: options.notes === undefined ? 'Notes de test' : options.notes,
    install: (onProgress) => {
      installMock.calls += 1;
      return options.install ? options.install(onProgress) : Promise.resolve();
    },
    dispose: () => {
      disposed.count += 1;
      return Promise.resolve();
    },
    installMock,
    disposed,
  };
}

/** Faux `DesktopPlatform` en mémoire (tests de features, aucun IPC). */
export interface FakeDesktop extends DesktopPlatform {
  trayLabels: TrayLabels | null;
  autostart: boolean;
  version: string;
  /** Résultat de la prochaine vérification : mise à jour, null, ou erreur à lever. */
  nextCheck: PendingUpdate | null | Error;
  checks: number;
  openedReleases: number;
  /** Déclenche « Ajout rapide » comme le fait le menu de la zone de notification. */
  emitQuickAdd(): void;
  quickAddListeners: number;
  /** Déclenche « Quitter » ; résout quand le handler a fini et que la sortie est confirmée. */
  emitQuitting(): Promise<void>;
  quitConfirmed: boolean;
  quittingHandler: (() => Promise<void>) | null;
  failAutostart: boolean;
}

export function createFakeDesktop(initial: Partial<Pick<FakeDesktop, 'autostart' | 'version' | 'nextCheck'>> = {}): FakeDesktop {
  const handlers = new Set<() => void>();
  const fake: FakeDesktop = {
    trayLabels: null,
    autostart: initial.autostart ?? false,
    version: initial.version ?? '0.1.0',
    nextCheck: initial.nextCheck ?? null,
    checks: 0,
    openedReleases: 0,
    quickAddListeners: 0,
    quitConfirmed: false,
    quittingHandler: null,
    emitQuitting: async () => {
      await fake.quittingHandler?.().catch(() => undefined);
      fake.quitConfirmed = true;
    },
    onQuitting: (handler) => {
      fake.quittingHandler = handler;
      return Promise.resolve(() => {
        fake.quittingHandler = null;
      });
    },
    failAutostart: false,
    emitQuickAdd: () => handlers.forEach((handler) => handler()),
    setTrayLabels: (labels) => {
      fake.trayLabels = labels;
      return Promise.resolve();
    },
    onQuickAdd: (handler) => {
      handlers.add(handler);
      fake.quickAddListeners = handlers.size;
      return Promise.resolve(() => {
        handlers.delete(handler);
        fake.quickAddListeners = handlers.size;
      });
    },
    getAutostart: () => Promise.resolve(fake.autostart),
    setAutostart: (enabled) => {
      if (fake.failAutostart) return Promise.reject(new Error('registre inaccessible'));
      fake.autostart = enabled;
      return Promise.resolve();
    },
    getVersion: () => Promise.resolve(fake.version),
    checkForUpdate: () => {
      fake.checks += 1;
      return fake.nextCheck instanceof Error ? Promise.reject(fake.nextCheck) : Promise.resolve(fake.nextCheck);
    },
    openLatestRelease: () => {
      fake.openedReleases += 1;
      return Promise.resolve();
    },
  };
  return fake;
}
