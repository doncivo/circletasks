import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkInstallerScript, findHooksInclude } from '../../smoke/nsisScript';

/**
 * REL-TECH-02, critère 5 : preuve, sans NSIS, que le garde-fou accepte un script conforme et nomme la propriété perdue dans chaque cas dégradé.
 * Les scripts factices reprennent la structure du modèle de Tauri 2.12.1 (`installer.nsi` : `Var`, `un.ConfirmLeave`, `Section Uninstall`).
 */
const HOOKS_FILE = readFileSync(join(import.meta.dirname, '..', '..', '..', 'src-tauri', 'windows', 'hooks.nsh'), 'utf8');
const INCLUDE_PATH = 'C:\\depot\\src-tauri\\windows\\hooks.nsh';

interface Variant {
  /** Nom de la variable dans tout le script (le modèle amont l'a « renommée »). */
  readonly variable?: string;
  readonly hook?: 'avant' | 'apres' | 'absent';
  readonly include?: boolean;
  readonly reassign?: boolean;
}

function script({ variable = 'DeleteAppDataCheckboxState', hook = 'avant', include = true, reassign = false }: Variant = {}): string {
  const insert = ['  !ifmacrodef NSIS_HOOK_PREUNINSTALL', '    !insertmacro NSIS_HOOK_PREUNINSTALL', '  !endif'];
  const removals = [
    `  \${If} $${variable} = 1`,
    '  ${AndIf} $UpdateMode <> 1',
    '    SetShellVarContext current',
    '    RmDir /r "$APPDATA\\${BUNDLEID}"',
    '    RmDir /r "$LOCALAPPDATA\\${BUNDLEID}"',
    '  ${EndIf}',
  ];
  return [
    'Unicode true',
    include ? `!include "${INCLUDE_PATH}"` : '; pas de crochets',
    `Var ${variable}`,
    'Function un.ConfirmLeave',
    `  SendMessage $DeleteAppDataCheckbox \${BM_GETCHECK} 0 0 $${variable}`,
    'FunctionEnd',
    'Section Uninstall',
    ...(hook === 'avant' ? insert : []),
    '  Delete "$INSTDIR\\${MAINBINARYNAME}.exe"',
    ...(reassign ? [`  StrCpy $${variable} 1`] : []),
    ...removals,
    ...(hook === 'apres' ? insert : []),
    'SectionEnd',
  ].join('\n');
}

describe('REL-TECH-02 : garde-fou du script NSIS généré', () => {
  it('accepte le script conforme et le vrai fichier de crochets', () => {
    expect(checkInstallerScript(script(), HOOKS_FILE)).toEqual([]);
    expect(findHooksInclude(script())).toBe(INCLUDE_PATH);
  });

  it('accepte les fins de ligne CRLF', () => {
    expect(checkInstallerScript(script().replaceAll('\n', '\r\n'), HOOKS_FILE.replaceAll('\n', '\r\n'))).toEqual([]);
  });

  it('refuse une variable renommée et nomme chaque propriété perdue', () => {
    const text = checkInstallerScript(script({ variable: 'DeleteUserDataState' }), HOOKS_FILE).join('\n');
    expect(text).toContain('variable $DeleteAppDataCheckboxState non déclarée');
    expect(text).toContain("n'est plus alimentée par un.ConfirmLeave");
    expect(text).toContain("n'est plus testée dans Section Uninstall");
  });

  it('refuse un crochet placé après les RmDir /r', () => {
    const problems = checkInstallerScript(script({ hook: 'apres' }), HOOKS_FILE);
    expect(problems).toHaveLength(2);
    expect(problems.join('\n')).toContain('NSIS_HOOK_PREUNINSTALL est placé APRÈS « RmDir /r "$APPDATA\\${BUNDLEID}" »');
    expect(problems.join('\n')).toContain('NSIS_HOOK_PREUNINSTALL est placé APRÈS « RmDir /r "$LOCALAPPDATA\\${BUNDLEID}" »');
  });

  it('refuse un crochet absent de Section Uninstall', () => {
    const problems = checkInstallerScript(script({ hook: 'absent' }), HOOKS_FILE);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('!insertmacro NSIS_HOOK_PREUNINSTALL absent de Section Uninstall');
  });

  it("refuse un script qui n'inclut plus hooks.nsh", () => {
    const problems = checkInstallerScript(script({ include: false }), HOOKS_FILE);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("n'inclut pas hooks.nsh");
  });

  it('refuse une variable réaffectée entre le crochet et le test', () => {
    const problems = checkInstallerScript(script({ reassign: true }), HOOKS_FILE);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('est réaffectée après le crochet');
  });

  it('refuse un fichier de crochets sans la remise à 0, sans macro, ou illisible', () => {
    const sansRemiseAZero = HOOKS_FILE.replace('StrCpy $DeleteAppDataCheckboxState 0', 'Nop');
    expect(checkInstallerScript(script(), sansRemiseAZero).join('\n')).toContain('sans « StrCpy $DeleteAppDataCheckboxState 0 »');
    const remiseEnCommentaire = HOOKS_FILE.replace('  StrCpy $DeleteAppDataCheckboxState 0', '  ; StrCpy $DeleteAppDataCheckboxState 0');
    expect(checkInstallerScript(script(), remiseEnCommentaire).join('\n')).toContain('sans « StrCpy');
    expect(checkInstallerScript(script(), '; rien').join('\n')).toContain('macro NSIS_HOOK_PREUNINSTALL non définie');
    expect(checkInstallerScript(script(), undefined).join('\n')).toContain('hooks.nsh illisible');
  });

  it('refuse une section Uninstall introuvable ou sans RmDir de données', () => {
    expect(checkInstallerScript(script().replace('Section Uninstall', 'Section Autre'), HOOKS_FILE).join('\n')).toContain('Section Uninstall introuvable');
    const sansRmDir = script().replace('    RmDir /r "$LOCALAPPDATA\\${BUNDLEID}"', '');
    expect(checkInstallerScript(sansRmDir, HOOKS_FILE).join('\n')).toContain('RmDir /r "$LOCALAPPDATA\\${BUNDLEID}" introuvable');
  });

  it('ne se laisse pas tromper par un commentaire', () => {
    const commente = script({ hook: 'absent' }).replace('Section Uninstall', 'Section Uninstall\n; !insertmacro NSIS_HOOK_PREUNINSTALL');
    expect(checkInstallerScript(commente, HOOKS_FILE).join('\n')).toContain('absent de Section Uninstall');
  });
});
