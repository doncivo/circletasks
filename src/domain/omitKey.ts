/** Copie d'un objet sans une clé (Y-TECH-02 : remplace les déstructurations `const { k: _k, ...rest } = o; void _k;`). */
export function omitKey<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key)) as Omit<T, K>;
}
