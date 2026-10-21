import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error script .mjs sans déclaration de types
import { instrumentBootstrap, instrumentRestore, instrumentWorkflow } from './prepare-a9.mjs';

const source = readFileSync(new URL('../../src/features/app/bootstrap.ts', import.meta.url), 'utf8');
describe('I-06 A9 : les branches de laboratoire sont séparées du candidat', () => {
  it('la version normale ne contient aucune injection', () => {
    expect(source).not.toContain('A9AfterApplyCommitted19');
    expect(source).not.toContain('ct.a9.interruption');
  });
  it('afterapply : le vrai traitement précède la panne, commit 19 vérifié, injection unique', () => {
    const result = instrumentBootstrap(source, 'afterapply') as string;
    expect(result.indexOf('await reintegrateAfterMigration(db, options.clock)')).toBeLessThan(result.indexOf('A9AfterApplyCommitted19'));
    expect(result).toContain('versions[0]?.version !== 19');
    expect(result).toContain("localStorage.setItem('ct.a9.afterapply.consumed', '1')");
  });
  it('interruption : barrière avant le vrai traitement, puis reprise sans réappliquer la migration', () => {
    const result = instrumentBootstrap(source, 'interruption') as string;
    expect(result.indexOf('await new Promise(')).toBeLessThan(result.indexOf('await reintegrateAfterMigration(db, options.clock)'));
    expect(result).toContain("localStorage.setItem('ct.a9.interruption', 'completed')");
  });
  it('refuse une source ambiguë ou une variante inconnue', () => {
    expect(() => instrumentBootstrap('', 'afterapply')).toThrow('anchor');
    expect(() => instrumentBootstrap(source, 'other')).toThrow('mode');
  });
  it('le build exception conserve la vraie restauration, puis empêche la remigration automatique avant le contrôle en 18', () => {
    const restore = readFileSync(new URL('../../src/features/app/updateRestore.ts', import.meta.url), 'utf8');
    const result = instrumentRestore(restore) as string;
    expect(result).toContain('await service.restore({ name, stamp: backupStamp(clock) })');
    expect(result).toContain('A9RestoreCompletedInstallSchema18BeforeReload');
    expect(result).not.toContain('await service.restart()');
    expect(result).toContain('return { ok: true, restartFailed: true }');
  });
  it('interdit la publication des IPA de laboratoire même si publish était demandé', () => {
    const workflow = readFileSync(new URL('../../.github/workflows/build-ios.yml', import.meta.url), 'utf8');
    const result = instrumentWorkflow(workflow) as string;
    expect(result).toContain('if: ${{ false }} # I-06 A9');
    expect(result).not.toContain("if: startsWith(github.ref, 'refs/tags/ios-v') && (github.event_name == 'push' || inputs.publish == true)");
    expect(() => instrumentWorkflow('unrecognized workflow')).toThrow('anchor');
  });
});
