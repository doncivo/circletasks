import type { SettingKey, SettingsValues } from '../../domain/model';
import type { Hlc } from '../../domain/types';

/**
 * Réglages typés (table `settings`, clé unique, valeur JSON). Contrat des clés et
 * valeurs par défaut : `SETTINGS_DEFINITIONS` (src/domain/model/settings.ts).
 * Une clé absente vaut sa valeur par défaut ; une clé inconnue en base est conservée.
 */
export interface SettingsRepository {
  get<K extends SettingKey>(key: K): Promise<SettingsValues[K]>;
  /** Toutes les clés connues, valeurs par défaut comprises (chargement au démarrage). */
  getAll(): Promise<SettingsValues>;
  set<K extends SettingKey>(key: K, value: SettingsValues[K]): Promise<void>;
}

/** Métadonnées de synchro locales, lues au démarrage (ADR 0005). */
export interface SyncMetaRepository {
  /**
   * Plus grand `hlc` présent dans les tables synchronisées (lignes supprimées
   * comprises), tous appareils confondus ; null sur une base vide. Sert de graine
   * au générateur HLC pour rester monotone même si l'horloge système a reculé.
   */
  maxHlc(): Promise<Hlc | null>;
}
