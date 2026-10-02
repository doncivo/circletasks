/**
 * Couleur d'un espace utilisable comme texte ou trait sur le fond du thème (AA en clair comme en sombre). Les espaces portent une
 * couleur choisie (ES-01) pensée pour le thème clair ; en thème sombre elle est éclaircie par `--ct-space-white` (tokens.css).
 */
export const spaceTextColor = (color: string): string => `color-mix(in srgb, ${color}, #ffffff var(--ct-space-white, 0%))`;
