import { createContext, useContext, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { AppContainer, FeatureStore } from './container';

const AppContainerContext = createContext<AppContainer | null>(null);

export function AppContainerProvider({ container, children }: { container: AppContainer; children: ReactNode }) {
  return <AppContainerContext.Provider value={container}>{children}</AppContainerContext.Provider>;
}

/** Conteneur courant ; lève une erreur hors `AppContainerProvider`. */
export function useAppContainer(): AppContainer {
  const container = useContext(AppContainerContext);
  if (!container) throw new Error('useAppContainer : AppContainerProvider manquant');
  return container;
}

/** Lit un store de feature du conteneur courant avec un sélecteur. */
export function useFeatureStore<S, T>(feature: FeatureStore<S>, selector: (state: S) => T): T {
  return useStore(feature.get(useAppContainer()), selector);
}
