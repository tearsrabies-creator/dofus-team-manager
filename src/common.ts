// Ce qui sert aux deux fenêtres de l'application : la fenêtre principale
// (main.ts) et le bandeau (pip.ts). Chacune importe ce dont elle a besoin
// avec `import { ... } from "./common"`.

import { invoke } from "@tauri-apps/api/core";
import { LogicalSize, PhysicalPosition } from "@tauri-apps/api/dpi";
import { currentMonitor, getCurrentWindow, Window } from "@tauri-apps/api/window";

// ---------------------------------------------------------------------------
// Tâches asynchrones
//
// Beaucoup d'actions passent par Rust (`invoke`) et rendent une promesse.
// Un gestionnaire d'événement (un clic...) n'attend pas de réponse : si l'on
// y lance une promesse sans s'en occuper, une erreur éventuelle passerait
// inaperçue. Ces deux outils la font apparaître dans la console de
// développement (clic droit > Inspecter, en mode dev).
// ---------------------------------------------------------------------------

/** Lance une tâche sans l'attendre, en signalant une éventuelle erreur. */
export function fireAndForget(task: Promise<unknown>): void {
  task.catch((error: unknown) => console.error(error));
}

/**
 * Adapte une fonction asynchrone pour en faire un gestionnaire d'événement :
 * `button.addEventListener("click", handler(onClick))`.
 * `<A extends unknown[]>` : la fonction rendue accepte les mêmes arguments.
 */
export function handler<A extends unknown[]>(
  task: (...args: A) => Promise<unknown>,
): (...args: A) => void {
  return (...args) => fireAndForget(task(...args));
}

// ---------------------------------------------------------------------------
// Petits éléments d'interface partagés
// ---------------------------------------------------------------------------

/** Petit bouton avec un symbole, un libellé au survol et une action. */
export function iconButton(text: string, label: string, action: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "small";
  button.textContent = text;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.addEventListener("click", action);
  return button;
}

/** Le bouton ⏸ / ▶ (des deux fenêtres) montre si les raccourcis sont actifs ou coupés. */
export function renderPauseButton(button: HTMLElement, paused: boolean): void {
  button.textContent = paused ? "▶" : "⏸";
  const label = paused ? "Raccourcis coupés : cliquer pour les réactiver" : "Couper les raccourcis";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-pressed", String(paused));
}

// ---------------------------------------------------------------------------
// Types : ils décrivent la forme des données envoyées par Rust. Ils doivent
// correspondre aux structures `GameWindow` (lib.rs) et `Config` (config.rs).
// `string | null` veut dire « un texte, ou rien » (le `Option` de Rust).
// `export` rend l'élément utilisable depuis les autres fichiers.
// ---------------------------------------------------------------------------

export interface GameWindow {
  id: number;
  key: string;
  character: string | null;
  className: string | null;
  title: string;
  selected: boolean;
  active: boolean;
  leader: boolean;
  number: number | null;
}

export interface Shortcuts {
  next: string;
  previous: string;
  toggle: string;
  // Un objet utilisé comme dictionnaire : nom du personnage → raccourci.
  characters: Record<string, string>;
}

export interface Config {
  order: string[];
  selection: string[];
  leader: string | null;
  shortcuts: Shortcuts;
  advanced: {
    // Distinguer gauche et droite (Ctrl, Alt, Maj, Win) dans les raccourcis.
    distinguishSides: boolean;
    // Chercher les nouvelles versions au lancement (désactivé par défaut).
    autoUpdate: boolean;
  };
}

// ---------------------------------------------------------------------------
// Invitations de groupe (bouton de la fenêtre principale et du bandeau)
// ---------------------------------------------------------------------------

// Ce qui sépare les commandes d'invitation dans le presse-papiers.
// À ajuster si le chat de Dofus attend autre chose.
const INVITE_SEPARATOR = "; ";

/**
 * Ce que fera un clic sur le bouton des invitations, ou la raison pour
 * laquelle il est désactivé.
 *
 * `type` permet de décrire une valeur qui a plusieurs formes possibles :
 * - `ready` : on peut copier `command` ; si `newLeader` n'est pas `null`,
 *   il faudra d'abord lui donner la couronne ;
 * - `disabled` : le bouton est grisé, `reason` explique pourquoi.
 */
export type InvitePlan =
  | { kind: "ready"; command: string; newLeader: string | null }
  | { kind: "disabled"; reason: string };

/**
 * Prépare les invitations de groupe :
 * - il faut au moins deux personnages connectés ;
 * - le chef est celui qui porte la couronne ; sans couronne, c'est le
 *   personnage dont la fenêtre est au premier plan, qui la recevra ;
 * - on invite tous les autres personnages cochés.
 */
export function invitePlan(windows: GameWindow[]): InvitePlan {
  const connected = windows.filter((w) => w.character !== null);
  if (connected.length < 2) {
    return { kind: "disabled", reason: "Il faut au moins deux personnages connectés." };
  }
  const crowned = connected.find((w) => w.leader);
  const leader = crowned ?? connected.find((w) => w.active);
  if (!leader) {
    return {
      kind: "disabled",
      reason: "Donnez la couronne 👑 au chef de groupe, ou affichez sa fenêtre Dofus.",
    };
  }
  const command = connected
    .filter((w) => w.selected && w !== leader)
    .map((w) => `/invite ${w.character}`)
    .join(INVITE_SEPARATOR);
  if (!command) {
    return { kind: "disabled", reason: "Cochez au moins un autre personnage connecté." };
  }
  return { kind: "ready", command, newLeader: crowned ? null : leader.character };
}

/** Exécute un plan prêt : couronne si besoin, puis copie de la commande. */
export async function copyInvites(plan: InvitePlan & { kind: "ready" }): Promise<void> {
  if (plan.newLeader) await invoke("set_leader", { character: plan.newLeader });
  await copyText(plan.command);
}

// ---------------------------------------------------------------------------
// La couronne du chef de groupe (fenêtre principale et bandeau)
// ---------------------------------------------------------------------------

/**
 * Fabrique le bouton couronne d'un personnage. Il n'y a qu'une couronne :
 * cliquer sur celle d'un autre personnage la lui donne (et la retire au chef
 * précédent) ; cliquer sur celle du chef la retire.
 *
 * C'est Rust qui enregistre le choix (`set_leader`) puis prévient les deux
 * fenêtres (événement `config-changed`), qui se redessinent.
 *
 * Pour l'apparence (seule la couronne du chef est visible, les autres
 * apparaissent au survol), l'élément qui contient le bouton doit avoir la
 * classe CSS `crown-host`.
 */
export function crownButton(w: GameWindow): HTMLButtonElement {
  const label = w.leader ? "Retirer la couronne" : `Donner la couronne à ${w.character}`;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "small crown";
  button.textContent = "👑";
  button.title = label;
  button.setAttribute("aria-label", label);
  // `aria-pressed` indique l'état aux lecteurs d'écran ; le CSS s'en sert
  // aussi pour l'apparence.
  button.setAttribute("aria-pressed", String(w.leader));
  button.addEventListener("click", (event) => {
    // Le clic ne doit pas atteindre ce qui entoure la couronne (sur le
    // bandeau, ça afficherait aussi la fenêtre du personnage).
    event.stopPropagation();
    fireAndForget(invoke("set_leader", { character: w.leader ? null : w.character }));
  });
  return button;
}

/**
 * Met un texte dans le presse-papiers. C'est la partie Rust qui s'en charge
 * (voir clipboard.rs) : le navigateur intégré refuse de le faire depuis une
 * fenêtre sans focus, comme le bandeau.
 */
export function copyText(text: string): Promise<void> {
  return invoke("copy_text", { text });
}

// ---------------------------------------------------------------------------
// Préférences d'affichage
//
// Elles sont rangées dans le `localStorage` du navigateur intégré : un petit
// espace de stockage clé → texte, partagé par les deux fenêtres et conservé
// entre deux lancements. Il peut être indisponible : on entoure donc chaque
// accès d'un `try / catch` (« essayer / en cas d'erreur »), et l'application
// fonctionne quand même avec les valeurs par défaut.
// ---------------------------------------------------------------------------

export function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Pas grave : la préférence ne sera simplement pas retenue.
  }
}

export type Theme = "light" | "dark";

/** Le thème choisi, ou à défaut celui de Windows. */
export function currentTheme(): Theme {
  const chosen = readPref("theme");
  if (chosen === "light" || chosen === "dark") return chosen;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Applique le thème à la page : le CSS réagit à l'attribut `data-theme`. */
export function applyTheme() {
  document.documentElement.dataset.theme = currentTheme();
}

/**
 * Appelle `refresh` toutes les `intervalMs` millisecondes, mais seulement
 * quand la fenêtre est visible : réduite ou cachée, elle ne fait rien
 * (légèreté). Quand elle redevient visible, on rafraîchit tout de suite.
 * `document.hidden` est fourni par le navigateur intégré.
 */
export function refreshWhileVisible(refresh: () => void, intervalMs: number) {
  setInterval(() => {
    if (!document.hidden) refresh();
  }, intervalMs);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refresh();
  });
}

// ---------------------------------------------------------------------------
// Taille et fenêtres
// ---------------------------------------------------------------------------

/**
 * Donne à la fenêtre exactement la taille de `root`, et la réajuste à
 * chaque fois que le contenu change (une ligne de plus, l'aide masquée...).
 *
 * `ResizeObserver` est un « observateur » fourni par le navigateur : il
 * appelle notre fonction dès que la taille de l'élément observé change.
 * Les tailles CSS sont en pixels « logiques », indépendants du zoom de
 * Windows : d'où `LogicalSize`.
 */
export function fitWindowToContent(root: HTMLElement, keepOnScreen = false): void {
  const appWindow = getCurrentWindow();
  const fit = async () => {
    const { width, height } = root.getBoundingClientRect();
    await appWindow.setSize(new LogicalSize(Math.ceil(width), Math.ceil(height)));
    if (keepOnScreen) await moveBackOnScreen();
  };
  new ResizeObserver(handler(fit)).observe(root);
}

/**
 * Si la fenêtre dépasse du bord droit ou du bas de son écran (par exemple
 * le bandeau collé dans le coin, qui s'élargit quand un personnage se
 * connecte), on la décale pour qu'elle reste entièrement visible.
 * Tout est en pixels physiques ici.
 */
async function moveBackOnScreen() {
  const appWindow = getCurrentWindow();
  const monitor = await currentMonitor();
  if (!monitor) return;
  const position = await appWindow.outerPosition();
  const size = await appWindow.outerSize();
  const right = monitor.position.x + monitor.size.width;
  const bottom = monitor.position.y + monitor.size.height;
  // `Math.min` : on recule si on dépasse ; `Math.max` : sans passer avant le bord gauche/haut.
  const x = Math.max(monitor.position.x, Math.min(position.x, right - size.width));
  const y = Math.max(monitor.position.y, Math.min(position.y, bottom - size.height));
  if (x !== position.x || y !== position.y) {
    await appWindow.setPosition(new PhysicalPosition(x, y));
  }
}

/** Les deux fenêtres, retrouvées par leur nom (« label » dans tauri.conf.json). */
export const mainWindow = () => Window.getByLabel("main");
export const pipWindow = () => Window.getByLabel("pip");

/** Fait revenir la fenêtre principale au premier plan et cache le bandeau. */
export async function restoreMain() {
  const main = await mainWindow();
  // `?.` : n'appelle la méthode que si la fenêtre existe (sinon ne fait rien).
  await main?.unminimize();
  await main?.show();
  await main?.setFocus();
  await (await pipWindow())?.hide();
}

/**
 * Place le bandeau là où l'utilisateur l'avait laissé, ou par défaut dans le
 * coin en haut à droite de l'écran. Appelée par le bandeau lui-même.
 */
export async function placePip(): Promise<void> {
  const pip = getCurrentWindow();
  const saved = savedPipPosition();
  if (saved) {
    await pip.setPosition(new PhysicalPosition(saved.x, saved.y));
  } else {
    const monitor = await currentMonitor();
    if (monitor) {
      // Ici on travaille en pixels « physiques » (les vrais pixels de l'écran).
      const size = await pip.outerSize();
      const margin = Math.round(16 * monitor.scaleFactor);
      await pip.setPosition(
        new PhysicalPosition(
          monitor.position.x + monitor.size.width - size.width - margin,
          monitor.position.y + margin,
        ),
      );
    }
  }
  // Retient la position à chaque déplacement.
  await pip.onMoved(({ payload }) =>
    writePref("pip-position", JSON.stringify({ x: payload.x, y: payload.y })),
  );
}

/**
 * La position du bandeau retenue lors d'une session précédente, ou `null`.
 * Le texte enregistré est vérifié : s'il est abîmé, on l'ignore au lieu de
 * planter (`JSON.parse` rend une valeur de type inconnu, `unknown`).
 */
function savedPipPosition(): { x: number; y: number } | null {
  try {
    const value: unknown = JSON.parse(readPref("pip-position") ?? "null");
    if (
      typeof value === "object" &&
      value !== null &&
      "x" in value &&
      "y" in value &&
      typeof value.x === "number" &&
      typeof value.y === "number"
    ) {
      return { x: value.x, y: value.y };
    }
  } catch {
    // Texte illisible : on repart de la position par défaut.
  }
  return null;
}
