// La disposition du bandeau, partagée par le bandeau lui-même (pip.ts) et par
// son aperçu dans l'onglet « Bandeau » de la fenêtre principale (main.ts) :
// les deux utilisent le même code et le même CSS, l'aperçu est donc fidèle.
//
// Le bandeau est horizontal ou vertical, et ses pseudos sont répartis sur un
// nombre de « lignes » choisi : des colonnes en vertical, des rangées en
// horizontal (une seule par défaut). On le choisit en étirant le bandeau
// dans le sens perpendiculaire : un bandeau vertical élargi assez pour deux
// colonnes de pseudos passe à deux colonnes, puis à trois... La fenêtre, elle,
// colle toujours à son contenu : ce sont les pseudos qui donnent sa taille,
// et les boutons se rangent dans la place qu'ils laissent.
//
// Orientation et nombre de lignes sont des préférences (common.ts),
// partagées par les deux fenêtres : quand l'une les change, l'autre reçoit
// l'événement `storage` du navigateur et se met à jour (voir isPipPref).

import { invoke } from "@tauri-apps/api/core";
import { classBadge } from "./classes";
import { crownButton, fireAndForget, GameWindow, readPref, writePref } from "./common";

export type Orientation = "horizontal" | "vertical";
export type Size = { width: number; height: number };

/** Les éléments d'un bandeau (le vrai, ou son aperçu). */
export type PipParts = { root: HTMLElement; characters: HTMLElement; tools: HTMLElement };

/** L'écart entre deux éléments d'une grille (le `gap` de .pip-grid). */
const GAP = 4;

// ---------------------------------------------------------------------------
// Préférences
// ---------------------------------------------------------------------------

export function readOrientation(): Orientation {
  return readPref("pip-orientation") === "vertical" ? "vertical" : "horizontal";
}

export function writeOrientation(orientation: Orientation): void {
  writePref("pip-orientation", orientation);
}

/** Le nombre de lignes choisi pour une orientation (1 par défaut). */
export function readLines(orientation: Orientation): number {
  const lines = Number(readPref(`pip-lines-${orientation}`));
  return Number.isInteger(lines) && lines >= 1 ? lines : 1;
}

export function saveLines(orientation: Orientation, lines: number): void {
  writePref(`pip-lines-${orientation}`, String(lines));
}

/**
 * Vrai si une préférence modifiée (clé reçue avec l'événement `storage`)
 * concerne la disposition du bandeau. `null` : tout a été effacé.
 */
export function isPipPref(key: string | null): boolean {
  return key === null || key === "pip-orientation" || key.startsWith("pip-lines-");
}

// ---------------------------------------------------------------------------
// Contenu
// ---------------------------------------------------------------------------

/** Dessine les pseudos des fenêtres connectées (sans pseudo, rien à afficher). */
export function renderCharacters(container: HTMLElement, windows: GameWindow[]): void {
  const connected = windows.filter((w) => w.character !== null);
  if (connected.length === 0) {
    const empty = document.createElement("span");
    empty.className = "empty";
    empty.textContent = "Aucun personnage";
    container.replaceChildren(empty);
  } else {
    container.replaceChildren(...connected.map(characterBox));
  }
}

/**
 * L'encadré d'un personnage : le bouton du pseudo et sa couronne (deux
 * boutons distincts : un bouton ne peut pas en contenir un autre).
 */
function characterBox(w: GameWindow): HTMLSpanElement {
  const box = document.createElement("span");
  // `crown-host` : la couronne apparaît au survol de l'encadré (styles.css).
  box.className = "character crown-host";
  box.classList.toggle("active", w.active);
  box.classList.toggle("unselected", !w.selected);

  const button = document.createElement("button");
  button.type = "button";
  button.className = "character-name";
  button.title = `Afficher ${w.character}`;
  button.append(classBadge(w.className), w.character ?? "");
  button.addEventListener("click", () => fireAndForget(invoke("activate_window", { id: w.id })));

  // La couronne, partagée avec la fenêtre principale (voir common.ts).
  box.append(button, crownButton(w));
  return box;
}

// ---------------------------------------------------------------------------
// Disposition
// ---------------------------------------------------------------------------

/**
 * La taille naturelle du plus grand élément d'une grille, dans le sens
 * perpendiculaire (sa largeur en vertical, sa hauteur en horizontal). Le
 * navigateur ne redessine rien entre les deux changements de classe : pas de
 * clignotement.
 */
function itemSize(grid: HTMLElement, vertical: boolean): number {
  grid.classList.add("measuring");
  let size = 0;
  for (const item of grid.children) {
    const rect = item.getBoundingClientRect();
    size = Math.max(size, vertical ? rect.width : rect.height);
  }
  grid.classList.remove("measuring");
  return size;
}

/** Combien de lignes d'éléments de taille `item` tiennent dans `room` pixels. */
function linesIn(room: number, item: number): number {
  return Math.floor((room + GAP) / (item + GAP));
}

/** Borne `lines` entre 1 et le nombre d'éléments de la grille. */
function clampLines(grid: HTMLElement, lines: number): number {
  return Math.min(Math.max(grid.children.length, 1), Math.max(1, lines));
}

/**
 * Place les éléments d'une grille sur `lines` lignes (des colonnes en
 * vertical, des rangées en horizontal).
 *
 * `fillAlong` : les pseudos remplissent une ligne avant de passer à la
 * suivante (colonne 1 de haut en bas, puis colonne 2...) ; les boutons, eux,
 * se rangent en travers (une rangée de boutons sous les pseudos en vertical).
 */
function place(grid: HTMLElement, vertical: boolean, lines: number, fillAlong: boolean): void {
  const perLine = Math.ceil(Math.max(grid.children.length, 1) / lines);
  if (vertical) {
    // `lines` colonnes de même largeur ; les pseudos s'y étirent.
    grid.style.gridTemplateColumns = `repeat(${lines}, ${fillAlong ? "1fr" : "auto"})`;
    grid.style.gridTemplateRows = `repeat(${perLine}, auto)`;
    grid.style.gridAutoFlow = fillAlong ? "column" : "row";
  } else {
    grid.style.gridTemplateRows = `repeat(${lines}, auto)`;
    grid.style.gridTemplateColumns = `repeat(${perLine}, auto)`;
    grid.style.gridAutoFlow = fillAlong ? "row" : "column";
  }
}

/**
 * Dispose un bandeau avec `lines` lignes de pseudos (au plus une par pseudo).
 * Les boutons ne dépassent pas l'étendue des pseudos : ils se rangent sur
 * autant de lignes qu'il en tient dans cette place.
 */
export function layoutPip(parts: PipParts, orientation: Orientation, lines: number): void {
  const { root, characters, tools } = parts;
  const vertical = orientation === "vertical";
  root.classList.toggle("vertical", vertical);
  root.classList.toggle("horizontal", !vertical);

  const characterLines = clampLines(characters, lines);
  place(characters, vertical, characterLines, true);
  // L'étendue des pseudos dans le sens perpendiculaire : leurs lignes et les
  // écarts entre elles.
  const extent = characterLines * itemSize(characters, vertical) + (characterLines - 1) * GAP;
  place(tools, vertical, clampLines(tools, linesIn(extent, itemSize(tools, vertical))), false);
}

/**
 * Le nombre de lignes de pseudos qui tiennent dans un bandeau de taille
 * `size` (par exemple pendant qu'on l'étire) : seul compte le sens
 * perpendiculaire, une fois retirés la bordure et la marge intérieure.
 */
export function linesForSize(parts: PipParts, orientation: Orientation, size: Size): number {
  const vertical = orientation === "vertical";
  const style = getComputedStyle(parts.root);
  const px = (property: string) => parseFloat(style.getPropertyValue(property)) || 0;
  const room = vertical
    ? size.width -
      px("padding-left") -
      px("padding-right") -
      px("border-left-width") -
      px("border-right-width")
    : size.height -
      px("padding-top") -
      px("padding-bottom") -
      px("border-top-width") -
      px("border-bottom-width");
  return clampLines(parts.characters, linesIn(room, itemSize(parts.characters, vertical)));
}

/** « 2 colonnes », « 1 rangée »... */
export function linesLabel(orientation: Orientation, lines: number): string {
  const word = orientation === "vertical" ? "colonne" : "rangée";
  return `${lines} ${word}${lines > 1 ? "s" : ""}`;
}
