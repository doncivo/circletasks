import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrations } from '../../../../src/db/migrations';
import { SYNC_FORMAT_MAJOR } from '../../../../src/domain/sync/format';
import { SYNC_COMMAND_WINDOWS, SYNC_COMMANDS } from '../../../../src/platform/sync/types';
import { authenticAnnouncements, parseResetState, resetStatusOf, RESET_REMINDER_MS, type ResetInput } from '../../../../src/sync/reset';
import type { DeviceId, Hlc } from '../../../../src/domain/types';
import type { FolderScan } from '../../../../src/platform/sync/types';
import type { SyncStateRow } from '../../../../src/db/repositories';
import type { DeviceAck, EpochId, PublishedDeviceState } from '../../../../src/domain/sync/format';
import type { ForgetVerdict } from '../../../../src/domain/sync/retention';

/**
 * Y-11 critères 17, 21 et 22 (exigences d'Ali) : aucun chemin d'erreur de `reset.ts` ne se limite à un journal ou à un `catch` vide ;
 * aucun test de la story ne dépend d'un délai réel ; aucune migration, aucun changement de `sm`, aucune commande nouvelle. Critère 8 :
 * seules les annonces authentiques suspendent.
 */

const root = join(__dirname, '../../../..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

/** Corps de chaque `catch` d'un source (accolades équilibrées). */
function catchBodies(source: string): string[] {
  const out: string[] = [];
  const re = /catch\s*(\([^)]*\))?\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') depth -= 1;
      i += 1;
    }
    out.push(source.slice(start, i - 1));
  }
  return out;
}

describe('aucun échec silencieux (critère 17)', () => {
  it('chaque catch de reset.ts écrit resetState.failure (recordResetFailure) ou propage l’erreur ; aucun catch vide', () => {
    const source = read('src/sync/reset.ts');
    const bodies = catchBodies(source);
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    for (const body of bodies) expect(body.includes('recordResetFailure') || /\bthrow\b/.test(body), body).toBe(true);
    // Les promesses de reset.ts ne sont jamais avalées par `.catch(() => …)`.
    expect(source).not.toMatch(/\.catch\(\s*\(\)\s*=>/);
  });

  it('les catch du moteur autour de la réinitialisation gardent l’échec ou font échouer le cycle de façon visible', () => {
    const engine = read('src/sync/engine.ts');
    const start = engine.indexOf('// Y-11 (§14.3, §18 point 2)');
    const block = engine.slice(start, engine.indexOf('const directive = resetDirective;'));
    for (const body of catchBodies(block)) expect(body).toMatch(/return fail\(/);
    const service = read('src/sync/service.ts');
    const run = service.slice(service.indexOf('const runReset = async'), service.indexOf('return service;', service.indexOf('const runReset = async')));
    for (const body of catchBodies(run)) expect(body.includes('recordResetFailure') || body.includes('dismissResetState'), body).toBe(true);
  });
});

describe('aucun délai réel (critère 21)', () => {
  it('ni setTimeout, ni setInterval, ni sleep, ni attente temporisée dans reset.ts et les tests de la story', () => {
    const files = ['src/sync/reset.ts', ...readdirSync(join(root, 'tests/unit/sync/reset')).filter((f) => f.endsWith('.ts') && f !== 'resetHygiene.test.ts').map((f) => `tests/unit/sync/reset/${f}`)];
    for (const file of files) {
      const text = read(file);
      expect(text, file).not.toMatch(/\bsetTimeout\s*\(|\bsetInterval\s*\(|\bsleep\s*\(|waitForTimeout|retry\s*:/);
    }
    // Rappel des 30 jours : une durée comparée à l'horloge injectée, jamais un minuteur.
    expect(RESET_REMINDER_MS).toBe(30 * 86_400_000);
  });
});

describe('ni migration, ni format, ni commande nouvelle (critère 22)', () => {
  it('17 migrations (aucune ajoutée par Y-11), sm 1, 24 commandes sync_* dont 3 pour la fenêtre pairing', () => {
    expect(migrations.at(-1)?.version).toBe(17);
    expect(SYNC_FORMAT_MAJOR).toBe(1);
    expect(SYNC_COMMANDS).toHaveLength(24);
    expect(SYNC_COMMANDS.filter((c) => SYNC_COMMAND_WINDOWS[c] === 'pairing').sort()).toEqual(['sync_key_import', 'sync_pairing_close', 'sync_pairing_payload']);
    expect(SYNC_COMMAND_WINDOWS.sync_reset_key).toBe('main');
  });
});

describe('état persistant (critère 17) et rappel (critère 13)', () => {
  it('lecture défensive de resetState ; rappel à 30 jours exactement, jamais avant', () => {
    expect(parseResetState({ role: 'x' })).toBeNull();
    expect(parseResetState('texte')).toBeNull();
    const state = parseResetState({ role: 'initiator', step: 'waiting-devices', startedAt: '2026-10-05T08:00:00.000Z', waitingSince: '2026-10-05T08:00:00.000Z', waiting: ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'pas-un-id'], failure: { code: 'io', at: '2026-10-05T08:00:00.000Z', step: 'snapshot' } });
    expect(state?.waiting).toEqual(['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']);
    expect(state?.failure).toEqual({ code: 'io', at: '2026-10-05T08:00:00.000Z', step: 'snapshot' });
    const t0 = Date.parse('2026-10-05T08:00:00.000Z');
    expect(resetStatusOf(state, t0 + RESET_REMINDER_MS - 1)?.reminder).toBe(false);
    expect(resetStatusOf(state, t0 + RESET_REMINDER_MS)?.reminder).toBe(true);
    expect(resetStatusOf(state, t0 + 400 * 86_400_000)?.reminder).toBe(true);
  });
});

describe('annonce authentique seulement (critère 8)', () => {
  const A = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' as DeviceId;
  const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as DeviceId;
  const K = '0123456789abcdef';
  const ep = `e0001-${A}` as EpochId;
  const state: PublishedDeviceState = {
    deviceId: A,
    platform: 'windows',
    appVersion: '0.4.0',
    sm: 1,
    sv: 17,
    epoch: ep,
    stateSeq: 7,
    head: { epoch: ep, segment: 0, record: 0, hlc: null, stateSeq: 7 },
    acks: new Map<DeviceId, DeviceAck>(),
    snapshot: null,
    purgeHorizon: null,
    lastSyncHlc: `000000000001000-0000-${A}` as Hlc,
    forgotten: [],
    reset: { kid: 'fedcba9876543210', epoch: `e0002-${A}` as EpochId, at: `000000000002000-0000-${A}` as Hlc },
  };
  const scan = (kid: string, status: 'ok' | 'foreign' | 'rollback' = 'ok'): FolderScan => ({
    devices: [{ deviceId: A, kid, state: status === 'ok' ? state : null, stateStatus: status, epochs: [], pending: [] }],
    ignored: 0,
    totalBytes: 0,
    tooManyDevices: false,
    incomplete: false,
    forgotten: { entries: [], done: [], overflow: false, accepted: [], selfForgotten: null },
  });
  const row = (kid: string | null, stateSeq: number): SyncStateRow => ({ deviceId: A, kid, stateSeq }) as unknown as SyncStateRow;
  const input = (over: Partial<ResetInput>): ResetInput => ({
    scan: scan(K),
    known: new Map<string, SyncStateRow>([[A, row(K, 6)]]),
    accepted: new Map<DeviceId, PublishedDeviceState>([[A, state]]),
    forget: { order: new Map<DeviceId, ForgetVerdict>(), master: [], done: new Set<DeviceId>(), selfForgotten: false, revived: [] },
    key: { kid: K },
    ...over,
  });

  it('état déchiffré avec la clé locale et accepté : authentique', () => {
    expect(authenticAnnouncements(input({}), B)).toHaveLength(1);
  });

  it('clé inconnue (foreign), état rejoué (rollback, non accepté) : sans effet', () => {
    expect(authenticAnnouncements(input({ scan: scan('ffffffffffffffff', 'foreign') }), B)).toHaveLength(0);
    expect(authenticAnnouncements(input({ accepted: new Map<DeviceId, PublishedDeviceState>() }), B), 'rejoué : non accepté').toHaveLength(0);
  });

  it('§18 point 15 (critère 8 (1) révisé) : appareil jamais accepté ou connu avec une autre clé : authentique, comme chez Rust (même gagnant partout)', () => {
    expect(authenticAnnouncements(input({ known: new Map<string, SyncStateRow>() }), B), 'appareil inconnu de B').toHaveLength(1);
    expect(authenticAnnouncements(input({ known: new Map<string, SyncStateRow>([[A, row(K, 0)]]) }), B), 'aucun état déjà accepté').toHaveLength(1);
    expect(authenticAnnouncements(input({ known: new Map<string, SyncStateRow>([[A, row('ffffffffffffffff', 6)]]) }), B), 'connu avec une autre clé').toHaveLength(1);
  });
});
