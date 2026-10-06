import { createStore } from 'zustand';
import { ORDER3_CAPABILITIES, type OnboardingCapabilities, type OnboardingStepId } from '../../domain/onboarding';
import type { SpaceId } from '../../domain/types';
import type { PlainMessageKey } from '../../i18n';
import { logDesktopFailure } from '../../platform';
import { defineFeatureStore, type AppContainer } from '../app/container';
import { useNavigationStore } from '../app/navigation';
import { createOnboardingUseCases } from './onboardingUseCases';

export interface OnboardingState {
  /** Le premier contrôle (réglage et base) est terminé. */
  readonly ready: boolean;
  /** L'assistant est affiché. */
  readonly open: boolean;
  /** Parti éditer le silence d'un espace : l'assistant est masqué en attendant le retour à Réglages (critère 4, lien « modifiable »). */
  readonly suspended: boolean;
  readonly steps: readonly OnboardingStepId[];
  readonly stepIndex: number;
  /** Interrupteur « Ajouter des données d'exemple » (désactivé par défaut). */
  readonly sampleEnabled: boolean;
  /** Des données d'exemple vivantes existent déjà : l'étape ne les propose pas une seconde fois. */
  readonly sampleExists: boolean;
  readonly busy: boolean;
  readonly errorKey: PlainMessageKey | null;
  /** La création des données d'exemple a échoué à « Commencer » : message affiché hors de l'assistant (Réglages › DONNÉES ET SÉCURITÉ). */
  readonly sampleError: boolean;
  /** Premier contrôle au lancement. Ne rejette jamais ; une erreur de lecture n'ouvre rien. */
  start(capabilities?: OnboardingCapabilities): Promise<void>;
  next(): Promise<void>;
  back(): Promise<void>;
  setSampleEnabled(value: boolean): void;
  /** Relit si des données d'exemple existent (la ligne « Supprimer les données d'exemple » de Réglages suit le store). Ne rejette jamais. */
  refreshSample(): Promise<void>;
  dismissSampleError(): void;
  /** « Passer », croix ou Échap. Ne rejette jamais ; en cas d'échec d'écriture l'assistant se ferme quand même pour cette session. */
  skip(): Promise<void>;
  /** « Commencer ». Ne rejette jamais ; l'assistant se ferme même si les données d'exemple n'ont pas pu être créées (message dans Réglages). */
  finish(): Promise<void>;
  /** « Revoir le guide de bienvenue » (Réglages › À PROPOS). Ne rejette jamais. */
  relaunch(capabilities?: OnboardingCapabilities): Promise<void>;
  /** Lien « modifiable » : masque l'assistant et ouvre l'éditeur du silence de l'espace. */
  editQuietHours(spaceId: SpaceId): void;
  /** Retour de l'éditeur du silence : l'assistant se rouvre à la même étape. */
  resume(): void;
}

export const onboardingStore = defineFeatureStore<OnboardingState>((container: AppContainer) => createOnboardingStore(container));

/**
 * Modules livrés (Y-06, D5) : l'étape « Synchronisation » n'existe que si la synchro est disponible, c'est-à-dire dans l'app installée
 * (PC à l'ordre 4) ou, en développement, avec un simulateur de dossier posé par un test (`globalThis.__ctSync`). Sans synchro
 * (iPhone avant l'ordre 5, navigateur de développement sans simulateur), l'assistant garde ses 3 étapes.
 */
export function onboardingCapabilities(container: AppContainer): OnboardingCapabilities {
  const available = container.syncPlatform?.available() === true;
  const simulated = import.meta.env.DEV && (globalThis as { __ctSync?: unknown }).__ctSync !== undefined;
  return { ...ORDER3_CAPABILITIES, pairing: available && (container.platform.runtime === 'tauri' || simulated) };
}

function createOnboardingStore(container: AppContainer) {
  const useCases = createOnboardingUseCases(container);

  return createStore<OnboardingState>()((set, get) => {
    async function remember(index: number): Promise<void> {
      const step = get().steps[index];
      if (step) await useCases.saveStep(step).catch((error: unknown) => logDesktopFailure('onboarding-step', error));
    }

    async function open(capabilities: OnboardingCapabilities | undefined, forceFirst: boolean): Promise<void> {
      const started = await useCases.start(capabilities, { force: forceFirst });
      if (started.decision !== 'show') {
        set({ ready: true, open: false });
        return;
      }
      const stepIndex = forceFirst ? 0 : started.stepIndex;
      set({ ready: true, open: true, suspended: false, steps: started.steps, stepIndex, sampleEnabled: false, errorKey: null, sampleExists: await useCases.sampleExists() });
      await remember(stepIndex);
    }

    return {
      ready: false,
      open: false,
      suspended: false,
      steps: [],
      stepIndex: 0,
      sampleEnabled: false,
      sampleExists: false,
      sampleError: false,
      busy: false,
      errorKey: null,
      async start(capabilities = onboardingCapabilities(container)) {
        try {
          await open(capabilities, false);
        } catch (error) {
          logDesktopFailure('onboarding-start', error);
          set({ ready: true, open: false });
        }
      },
      async next() {
        const { stepIndex, steps } = get();
        if (stepIndex >= steps.length - 1) return;
        set({ stepIndex: stepIndex + 1, errorKey: null });
        await remember(stepIndex + 1);
      },
      async back() {
        const { stepIndex } = get();
        if (stepIndex <= 0) return;
        set({ stepIndex: stepIndex - 1, errorKey: null });
        await remember(stepIndex - 1);
      },
      setSampleEnabled: (value) => set({ sampleEnabled: value }),
      async refreshSample() {
        set({ sampleExists: await useCases.sampleExists().catch(() => false) });
      },
      dismissSampleError: () => set({ sampleError: false }),
      async skip() {
        set({ open: false, errorKey: null });
        try {
          await useCases.skip();
        } catch (error) {
          logDesktopFailure('onboarding-skip', error);
        }
      },
      async finish() {
        if (get().busy) return;
        set({ busy: true, errorKey: null });
        try {
          await useCases.finish({ withSamples: get().sampleEnabled });
          set({ open: false, busy: false, sampleError: false, sampleExists: await useCases.sampleExists().catch(() => false) });
        } catch (error) {
          logDesktopFailure('onboarding-finish', error);
          // Les éléments déjà créés sont mémorisés ; on marque l'assistant terminé pour ne pas le rouvrir en boucle.
          await useCases.skip().catch(() => undefined);
          set({ open: false, busy: false, errorKey: 'onboarding.sampleError', sampleError: true, sampleExists: await useCases.sampleExists().catch(() => false) });
        }
      },
      async relaunch(capabilities = onboardingCapabilities(container)) {
        try {
          await useCases.relaunch();
          await open(capabilities, true);
        } catch (error) {
          logDesktopFailure('onboarding-relaunch', error);
        }
      },
      editQuietHours(spaceId) {
        set({ suspended: true });
        useNavigationStore.getState().navigate({ tab: 'settings', screen: 'quiet', spaceId });
      },
      resume: () => set({ suspended: false }),
    };
  });
}
