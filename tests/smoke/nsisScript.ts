/**
 * REL-TECH-02 : garde-fou statique du script NSIS généré par Tauri (`installer.nsi`) et du fichier de crochets (`src-tauri/windows/hooks.nsh`).
 *
 * Le crochet `NSIS_HOOK_PREUNINSTALL` remet à 0 l'état de la case « Supprimer les données de l'application » (variable globale
 * `$DeleteAppDataCheckboxState`, lue par `un.ConfirmLeave`) AVANT le bloc de `Section Uninstall` qui exécute `RmDir /r` sur les dossiers de
 * données. Le modèle de Tauri n'étant pas figé (CLI 2.12.1 à la rédaction), ce contrôle échoue, en nommant la propriété perdue, si une mise à jour
 * de Tauri renomme la variable, déplace le crochet après les `RmDir` ou cesse d'inclure notre fichier : jamais une protection perdue en silence.
 *
 * Le script généré contient `!include "<chemin absolu>\hooks.nsh"` puis, dans `Section Uninstall`, `!insertmacro NSIS_HOOK_PREUNINSTALL`
 * (sous `!ifmacrodef`) : le corps de la macro est dans le fichier inclus, pas dans le script ; les deux sont donc contrôlés.
 */
export const HOOK_MACRO = 'NSIS_HOOK_PREUNINSTALL';
export const CHECKBOX_VARIABLE = 'DeleteAppDataCheckboxState';

/** Dossiers de données que le modèle supprime (`RmDir /r`) quand la case est cochée. */
const DATA_FOLDERS = ['$APPDATA\\${BUNDLEID}', '$LOCALAPPDATA\\${BUNDLEID}'] as const;

/** Lignes sans les commentaires NSIS (`;` ou `#` en tête de ligne) ni les blancs de bord. */
function codeLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith(';') && !line.startsWith('#'));
}

/** Chemin du fichier de crochets inclus par le script généré (`!include "…hooks.nsh"`), ou undefined s'il n'est pas inclus. */
export function findHooksInclude(installer: string): string | undefined {
  for (const line of codeLines(installer)) {
    const match = /^!include\s+"([^"]*hooks\.nsh)"$/i.exec(line);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

/** Lignes de code entre deux repères (le début exclu), ou undefined si le début est introuvable. */
function block(lines: readonly string[], start: RegExp, end: RegExp): string[] | undefined {
  const from = lines.findIndex((line) => start.test(line));
  if (from < 0) return undefined;
  const to = lines.findIndex((line, index) => index > from && end.test(line));
  return lines.slice(from + 1, to < 0 ? undefined : to);
}

function mentionsVariable(line: string): boolean {
  return line.includes(`$${CHECKBOX_VARIABLE}`);
}

/**
 * Liste des propriétés perdues (vide : conforme). `hooks` est le contenu du fichier de crochets inclus ; absent, c'est une propriété perdue.
 * Chaque message nomme la propriété, pour que l'échec dise ce qui a changé.
 */
export function checkInstallerScript(installer: string, hooks: string | undefined): string[] {
  const problems: string[] = [];
  const lines = codeLines(installer);

  // (c) La variable existe encore : déclarée, alimentée par la page de confirmation du désinstalleur, testée dans Section Uninstall.
  if (!lines.some((line) => new RegExp(`^Var\\s+${CHECKBOX_VARIABLE}$`).test(line))) {
    problems.push(`variable $${CHECKBOX_VARIABLE} non déclarée (Var) : Tauri l'a renommée ou supprimée, le crochet ne remet plus rien à 0`);
  }
  const confirmLeave = block(lines, /^Function\s+un\.ConfirmLeave$/i, /^FunctionEnd$/i) ?? [];
  if (!confirmLeave.some(mentionsVariable)) {
    problems.push(`$${CHECKBOX_VARIABLE} n'est plus alimentée par un.ConfirmLeave : la page de confirmation a changé`);
  }

  // Le fichier de crochets est inclus par le script généré.
  if (findHooksInclude(installer) === undefined) {
    problems.push("le script généré n'inclut pas hooks.nsh (!include) : bundle.windows.nsis.installerHooks n'est plus pris en compte");
  }

  // (a) Le corps de la macro, dans le fichier inclus : remise à 0 de la variable.
  if (hooks === undefined) {
    problems.push('fichier de crochets hooks.nsh illisible : le corps de la macro ne peut pas être contrôlé');
  } else {
    const body = block(codeLines(hooks), new RegExp(`^!macro\\s+${HOOK_MACRO}(\\s|$)`, 'i'), /^!macroend$/i);
    if (body === undefined) {
      problems.push(`macro ${HOOK_MACRO} non définie dans hooks.nsh (!macro … !macroend)`);
    } else if (!body.some((line) => new RegExp(`^StrCpy\\s+\\$${CHECKBOX_VARIABLE}\\s+(0|"0")$`, 'i').test(line))) {
      problems.push(`macro ${HOOK_MACRO} sans « StrCpy $${CHECKBOX_VARIABLE} 0 » : la case « Supprimer les données de l'application » redevient active`);
    }
  }

  // (a) et (b) Le crochet est inséré dans Section Uninstall, AVANT tout RmDir /r.
  const section = block(lines, /^Section\s+Uninstall$/i, /^SectionEnd$/i);
  if (section === undefined) {
    problems.push('Section Uninstall introuvable dans le script généré : le modèle de Tauri a changé');
    return problems;
  }
  const hookIndex = section.findIndex((line) => new RegExp(`^!insertmacro\\s+${HOOK_MACRO}$`, 'i').test(line));
  if (hookIndex < 0) {
    problems.push(`!insertmacro ${HOOK_MACRO} absent de Section Uninstall : le crochet n'est plus exécuté`);
  }
  const recursiveRemovals = section.map((line, index) => ({ line, index })).filter(({ line }) => /^RmDir\s+\/r\s/i.test(line));
  for (const folder of DATA_FOLDERS) {
    if (!recursiveRemovals.some(({ line }) => line.includes(`"${folder}"`))) {
      problems.push(`RmDir /r "${folder}" introuvable dans Section Uninstall : le modèle a changé, le contrôle ne sait plus ce qu'il protège`);
    }
  }
  if (hookIndex >= 0) {
    for (const { line, index } of recursiveRemovals) {
      if (index < hookIndex) problems.push(`${HOOK_MACRO} est placé APRÈS « ${line} » : les données seraient supprimées avant la remise à 0`);
    }
    // Aucune autre affectation de la variable entre le crochet et le test (le test lui-même, `${If} … = 1`, est permis).
    for (const line of section.slice(hookIndex + 1)) {
      if (mentionsVariable(line) && !/^\$\{(If|AndIf|OrIf|ElseIf)\}/i.test(line)) {
        problems.push(`$${CHECKBOX_VARIABLE} est réaffectée après le crochet : « ${line} »`);
      }
    }
  }
  if (!section.some((line) => /^\$\{(If|AndIf|OrIf)\}/i.test(line) && mentionsVariable(line))) {
    problems.push(`$${CHECKBOX_VARIABLE} n'est plus testée dans Section Uninstall : le modèle a changé`);
  }
  return problems;
}
