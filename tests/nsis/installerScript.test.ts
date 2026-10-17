import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkInstallerScript, findHooksInclude } from '../smoke/nsisScript';

/**
 * REL-TECH-02, critères 4 et 6 : lecture du script NSIS RÉELLEMENT généré par `tauri build --debug --bundles nsis` avec la configuration de fumée
 * (`npm run test:smoke:installer-build`, dossier cargo `src-tauri/target/smoke`) : `<dossier cargo>/debug/nsis/x64/installer.nsi`
 * (`project_out_directory()/nsis/<arch>/installer.nsi` dans le bundler de Tauri 2.12.1). Les cas factices sont dans tests/unit/smoke/nsisScript.test.ts.
 *
 * Hors CI, l'absence du script (NSIS n'est pas installé sur le poste) déclare le test ignoré avec un message explicite ; en CI (variable `CI`),
 * l'absence est un ÉCHEC : le job qui lance ce test construit l'installeur avant, un test ignoré ne protège rien.
 */
const ROOT = resolve(import.meta.dirname, '..', '..');
const SCRIPT = process.env['CT_NSIS_SCRIPT'] ?? join(ROOT, 'src-tauri', 'target', 'smoke', 'debug', 'nsis', 'x64', 'installer.nsi');
const HOOKS = join(ROOT, 'src-tauri', 'windows', 'hooks.nsh');

describe('REL-TECH-02 : script NSIS généré', () => {
  it('insère le crochet dans Section Uninstall avant les RmDir /r, et la variable de la case existe encore', (context) => {
    if (!existsSync(SCRIPT)) {
      const reason = `script NSIS généré absent : ${SCRIPT} (construire l'installeur : npm run test:smoke:installer-build ; NSIS n'est installé que par la CI)`;
      if (process.env['CI']) throw new Error(`${reason}. En CI, l'absence est un échec : l'étape de build NSIS du job n'a rien produit.`);
      context.skip(reason);
    }
    const installer = readFileSync(SCRIPT, 'utf8');
    // Le script généré inclut le fichier de crochets par son chemin absolu : c'est bien celui du dépôt, et il se lit.
    const included = findHooksInclude(installer);
    expect(included, 'hooks.nsh absent des !include du script généré (installerHooks non pris en compte par la configuration de fumée ?)').toBeDefined();
    const includedPath = isAbsolute(included ?? '') ? (included ?? '') : resolve(join(SCRIPT, '..'), included ?? '');
    expect(existsSync(includedPath), `fichier de crochets inclus introuvable : ${includedPath}`).toBe(true);
    expect(realpathSync(includedPath).toLowerCase(), 'le script inclut un autre hooks.nsh que celui du dépôt').toBe(realpathSync(HOOKS).toLowerCase());
    const problems = checkInstallerScript(installer, readFileSync(includedPath, 'utf8'));
    expect(problems, `protection des données perdue dans ${SCRIPT} :\n- ${problems.join('\n- ')}`).toEqual([]);
  });
});
