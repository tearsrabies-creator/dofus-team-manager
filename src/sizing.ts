// Les calculs de taille des fenêtres et du bandeau, sans Tauri ni navigateur :
// des fonctions pures, vérifiées par sizing.test.ts (`npm test`).
//
// Le problème qu'elles règlent : Windows ne donne pas toujours à une fenêtre
// exactement la taille qu'on lui demande. Une fenêtre sans cadre (les
// nôtres) garde une bordure invisible pour l'ombre et l'étirement, que Tauri
// estime d'après l'état de la fenêtre à cet instant ; selon la version de
// Windows, le zoom de l'écran ou une fenêtre encore cachée, l'estimation peut
// être fausse de quelques pixels... et les derniers boutons du bandeau
// disparaissent hors de la fenêtre. On relit donc la taille obtenue, et on
// corrige l'écart.

export type Size = { width: number; height: number };

/** Une fenêtre dont on peut changer et relire la taille utile (en pixels physiques). */
export type SizableWindow = {
  setInnerSize(size: Size): Promise<void>;
  innerSize(): Promise<Size>;
};

/** Le nombre maximal de demandes pour atteindre la bonne taille. */
const MAX_SIZE_ATTEMPTS = 3;

/**
 * La taille en pixels physiques (les vrais pixels de l'écran) qu'il faut
 * pour afficher `css` pixels CSS, `ratio` étant `window.devicePixelRatio`.
 * Arrondie au-dessus : jamais un pixel de moins que le contenu. La petite
 * marge absorbe les imprécisions de calcul (33.6 × 1.25 = 42.00000001).
 */
export function toPhysical(css: Size, ratio: number): Size {
  const up = (value: number) => Math.max(1, Math.ceil(value * ratio - 0.001));
  return { width: up(css.width), height: up(css.height) };
}

/** L'inverse de `toPhysical` : des pixels physiques en pixels CSS. */
export function toCss(physical: Size, ratio: number): Size {
  return { width: physical.width / ratio, height: physical.height / ratio };
}

/**
 * La prochaine taille à demander pour obtenir `target`, sachant que la
 * demande `requested` a donné `obtained` : on reporte l'écart. `null` si la
 * taille est atteinte, ou si la fenêtre n'a pas de taille (réduite dans la
 * barre des tâches : il n'y a rien à corriger).
 */
export function nextRequest(target: Size, requested: Size, obtained: Size): Size | null {
  if (obtained.width <= 0 || obtained.height <= 0) return null;
  if (obtained.width === target.width && obtained.height === target.height) return null;
  return {
    width: Math.max(1, requested.width + target.width - obtained.width),
    height: Math.max(1, requested.height + target.height - obtained.height),
  };
}

/**
 * Donne à la fenêtre une taille utile de `target` pixels physiques, en
 * corrigeant l'écart si Windows en donne une autre. Renvoie la taille
 * finalement obtenue (en pixels physiques).
 */
export async function resizeWindow(win: SizableWindow, target: Size): Promise<Size> {
  let requested = target;
  let obtained = target;
  for (let attempt = 0; attempt < MAX_SIZE_ATTEMPTS; attempt++) {
    await win.setInnerSize(requested);
    obtained = await win.innerSize();
    const next = nextRequest(target, requested, obtained);
    if (next === null) break;
    requested = next;
  }
  return obtained;
}

/** Vrai si `size` est l'une des tailles `sizes`, à `tolerance` pixels près. */
export function matchesAny(size: Size, sizes: readonly Size[], tolerance = 2): boolean {
  return sizes.some(
    (s) =>
      Math.abs(s.width - size.width) <= tolerance && Math.abs(s.height - size.height) <= tolerance,
  );
}

// ---------------------------------------------------------------------------
// Lignes du bandeau
// ---------------------------------------------------------------------------

/** L'écart entre deux éléments d'une grille du bandeau (le `gap` de .pip-grid). */
export const GAP = 4;

/**
 * La tolérance, en pixels, quand on compte les lignes qui tiennent : les
 * tailles de fenêtre que donne le navigateur sont arrondies au pixel entier
 * (`innerWidth`), alors que les pseudos ont des tailles fractionnaires. Sans
 * elle, une fenêtre pile à la taille de deux colonnes pourrait n'en compter
 * qu'une, et rétrécir au moindre redimensionnement.
 */
const ROUNDING_SLACK = 1;

/** Combien de lignes d'éléments de taille `item` tiennent dans `room` pixels. */
export function linesIn(room: number, item: number): number {
  if (item <= 0) return 1;
  return Math.floor((room + GAP + ROUNDING_SLACK) / (item + GAP));
}

/** Borne `lines` entre 1 et le nombre d'éléments `count`. */
export function clampLines(count: number, lines: number): number {
  return Math.min(Math.max(count, 1), Math.max(1, lines));
}

/** L'étendue de `lines` lignes d'éléments de taille `item`, écarts compris. */
export function extentOf(lines: number, item: number): number {
  return lines * item + (lines - 1) * GAP;
}

// ---------------------------------------------------------------------------
// Rester sur l'écran
// ---------------------------------------------------------------------------

/** Un rectangle : sa position (coin en haut à gauche) et sa taille. */
export type Rect = { x: number; y: number } & Size;

/**
 * La taille à donner à une fenêtre qui colle à son contenu (`content`),
 * sans dépasser la place disponible (`room`, la zone utile de l'écran, sans
 * la barre des tâches). Sur un petit écran, ou avec un fort zoom, le contenu
 * peut ne pas tenir : la fenêtre prend alors toute la place, et son contenu
 * défile (`scroll`). La barre de défilement (`scrollbar` pixels de large)
 * s'ajoute à la largeur, pour ne rien cacher sur le côté.
 */
export function fitWithin(
  content: Size,
  room: Size,
  scrollbar: number,
): { size: Size; scroll: boolean } {
  const scroll = content.height > room.height || content.width > room.width;
  if (!scroll) return { size: content, scroll };
  return {
    size: {
      width: Math.min(
        room.width,
        content.height > room.height ? content.width + scrollbar : content.width,
      ),
      height: Math.min(
        room.height,
        content.width > room.width ? content.height + scrollbar : content.height,
      ),
    },
    scroll,
  };
}

/**
 * La position qui garde la fenêtre `window` entièrement dans `area` : on la
 * recule si elle dépasse à droite ou en bas, sans passer avant le bord
 * gauche ou le haut (une fenêtre plus grande que la zone reste calée en haut
 * à gauche, là où sont ses boutons).
 */
export function keepInside(window: Rect, area: Rect): { x: number; y: number } {
  return {
    x: Math.max(area.x, Math.min(window.x, area.x + area.width - window.width)),
    y: Math.max(area.y, Math.min(window.y, area.y + area.height - window.height)),
  };
}
