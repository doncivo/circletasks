import { invoke } from '@tauri-apps/api/core';
import type { PrivacyShieldFailure, PrivacyShieldResult } from './index';

/**
 * Adaptateur iOS du plugin local `privacy-shield` (`src-tauri/plugins/privacy-shield`) : SEUL fichier qui nomme `plugin:privacy-shield|`
 * (test de cohérence). Rejet du Swift : `{ code: 'invalid-argument' }` ; plugin absent ou refusé : `unavailable`.
 */

export type PluginInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

const UNAVAILABLE_MESSAGE = /window is not defined|__TAURI|reading 'invoke'|not allowed|plugin .*not found|command .*not found|not registered|unknown command|no such plugin/i;

export function shieldFailureOf(error: unknown): PrivacyShieldFailure {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return (error as { code?: unknown }).code === 'invalid-argument' ? 'invalid-argument' : 'unknown';
  }
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return UNAVAILABLE_MESSAGE.test(message) ? 'unavailable' : 'unknown';
}

export async function setNativeShield(enabled: boolean, call: PluginInvoke = (command, args) => invoke(command, args)): Promise<PrivacyShieldResult> {
  try {
    await call('plugin:privacy-shield|set_enabled', { enabled });
    return { ok: true };
  } catch (error) {
    return { ok: false, code: shieldFailureOf(error) };
  }
}
