/** Un marqueur appareil/époque est un repli : les fichiers détaillés qu'il contient sont comptés à sa place. */
export function pendingFileCount(paths: readonly string[]): number {
  const unique = [...new Set(paths)];
  return unique.filter((path) => !unique.some((other) => other.startsWith(`${path}/`))).length;
}
