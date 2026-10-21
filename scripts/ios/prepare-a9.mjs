/* global localStorage, process, console */
// I-06 A9 : instrumentation réservée aux branches de build privées, jamais aux tags publiés.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const A9_KEY = 'ct.a9.afterapply.consumed';

// Fonction autonome : son corps est inséré dans le callback afterApply et exécuté aussi par la preuve automatique.
export async function afterApplyFault(db, report) {
  if (localStorage.getItem('ct.a9.afterapply.consumed') === '1') return;
  const versions = await db.select('SELECT MAX(version) AS version FROM schema_migrations');
  if (report.currentVersion !== 19 || report.applied.length !== 1 || report.applied[0] !== 19 || versions[0]?.version !== 19) {
    throw Object.assign(new Error('A9 requires a fresh migration from schema 18 to 19'), { name: 'A9InvalidBaseline' });
  }
  await db.select('SELECT COUNT(*) AS count FROM epoch_carry_report');
  // Une seule panne : la restauration/recharge exerce le vrai parcours de reprise sans réinjecter la panne.
  localStorage.setItem('ct.a9.afterapply.consumed', '1');
  throw Object.assign(new Error('A9 injected failure after committed schema 19'), { name: 'A9AfterApplyCommitted19' });
}

// Barrière volontaire, sans délai ni relance automatique : Ali tue réellement le processus.
// Le prochain processus trouve « paused », passe la barrière et exécute le vrai afterApply.
export async function pauseAfterCommit(db, report) {
  if (['paused', 'resuming'].includes(localStorage.getItem('ct.a9.interruption') ?? '')) {
    localStorage.setItem('ct.a9.interruption', 'resuming');
    return;
  }
  if (localStorage.getItem('ct.a9.interruption') === 'completed') return;
  const versions = await db.select('SELECT MAX(version) AS version FROM schema_migrations');
  if (report.currentVersion !== 19 || report.applied.length !== 1 || report.applied[0] !== 19 || versions[0]?.version !== 19) {
    throw Object.assign(new Error('A9 interruption requires schema 18 before first launch'), { name: 'A9InvalidBaseline' });
  }
  localStorage.setItem('ct.a9.interruption', 'paused');
  await new Promise(() => { /* Le processus est arrêté physiquement, jamais par un minuteur. */ });
}

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`A9 anchor absent or ambiguous: ${before}`);
  return source.replace(before, after);
}

export function instrumentBootstrap(source, mode) {
  if (mode === 'afterapply') {
    const body = afterApplyFault.toString().slice(afterApplyFault.toString().indexOf('{') + 1, -1);
    return replaceOnce(source,
      'afterApply: (db) => reintegrateAfterMigration(db, options.clock).then(() => undefined),',
      `afterApply: async (db, report) => {\n        await reintegrateAfterMigration(db, options.clock);\n${body}\n      },`);
  }
  if (mode === 'interruption') {
    const body = pauseAfterCommit.toString().slice(pauseAfterCommit.toString().indexOf('{') + 1, -1);
    // La fonction imbriquée évite qu'un return du contrôle de reprise saute le vrai afterApply.
    return replaceOnce(source,
      'afterApply: (db) => reintegrateAfterMigration(db, options.clock).then(() => undefined),',
      `afterApply: async (db, report) => {\n        await (async () => {\n${body}\n        })();\n        await reintegrateAfterMigration(db, options.clock);\n        localStorage.setItem('ct.a9.interruption', 'completed');\n        logFailure('db', 'A9InterruptionAfterApplyReturned');\n      },`);
  }
  throw new Error('A9 mode must be afterapply or interruption');
}

export function instrumentRestore(source) {
  // Après le vrai rollback Rust : arrêter ici pour installer 0.3.3 et prouver l'ouverture en 18.
  // La restauration n'est pas remplacée ; seule sa relance automatique est neutralisée dans le build de laboratoire.
  return replaceOnce(source, 'await service.restart();', "await Promise.reject(new Error('A9RestoreCompletedInstallSchema18BeforeReload'));");
}

export function instrumentWorkflow(source) {
  return replaceOnce(source,
    "if: startsWith(github.ref, 'refs/tags/ios-v') && (github.event_name == 'push' || inputs.publish == true)",
    'if: ${{ false }} # I-06 A9 : publication interdite pour les builds de laboratoire');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const branch = execFileSync('git', ['branch', '--show-current'], { encoding: 'utf8' }).trim();
  if (!/^i-06-a9-build-(afterapply|interruption)$/.test(branch)) throw new Error('A9 instrumentation requires an isolated A9 build branch');
  const mode = process.argv[2];
  if (branch !== `i-06-a9-build-${mode}`) throw new Error('A9 branch/mode mismatch');
  const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  if (conf.version !== '1.0.0' || conf.identifier !== 'fr.circletasks.planner') throw new Error('A9 requires the reviewed 1.0.0 candidate identity');
  const path = 'src/features/app/bootstrap.ts';
  const source = readFileSync(path, 'utf8');
  writeFileSync(path, instrumentBootstrap(source, mode));
  if (mode === 'afterapply') {
    const restorePath = 'src/features/app/updateRestore.ts';
    writeFileSync(restorePath, instrumentRestore(readFileSync(restorePath, 'utf8')));
  }
  const workflow = '.github/workflows/build-ios.yml';
  writeFileSync(workflow, instrumentWorkflow(readFileSync(workflow, 'utf8')));
  const plist = 'src-tauri/Info.ios.plist';
  writeFileSync(plist, replaceOnce(readFileSync(plist, 'utf8'), '<dict>', `<dict>\n\t<key>CFBundleDisplayName</key>\n\t<string>CircleTasks A9 ${mode === 'afterapply' ? 'erreur' : 'arrêt'}</string>`));
  console.log(`A9 ${mode}: bootstrap instrumented; publish=false only, same bundle identifier`);
}
