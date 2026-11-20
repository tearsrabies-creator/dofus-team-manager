// La logique du bandeau : une rangée de pseudos cliquables pour passer d'une
// fenêtre Dofus à l'autre en un clic, sans quitter le jeu des yeux. Sa
// disposition (orientation, colonnes / rangées) est dans pip-layout.ts.

import { invoke } from "@tauri-apps/api/core";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  applyTheme,
  copyInvites,
  fireAndForget,
  GameWindow,
  handler,
  invitePlan,
  moveBackOnScreen,
  placePip,
  refreshWhileVisible,
  renderPauseButton,
  reportUncaughtErrors,
  restoreMain,
} from "./common";
import {
  isPipPref,
  layoutPip,
  linesForSize,
  Orientation,
  PipParts,
  readLines,
  readOrientation,
  renderCharacters,
  saveLines,
  Size,
  writeOrientation,
} from "./pip-layout";

// Le bandeau relit la liste un peu plus souvent que la fenêtre principale,
// pour que la fenêtre active soit vite à jour (seulement quand il est visible).
const REFRESH_INTERVAL_MS = 1500;

/**
 * Combien de temps sans changement de taille avant de considérer qu'on a
 * fini d'étirer le bandeau (la fenêtre se recolle alors à son contenu).
 */
const RESIZE_SETTLE_MS = 250;

const parts: PipParts = {
  root: document.getElementById("root")!,
  characters: document.getElementById("characters")!,
  tools: document.getElementById("tools")!,
};
const inviteButton = document.getElementById("invite-button") as HTMLButtonElement;
const reorderButton = document.getElementById("reorder-button")!;
const pauseButton = document.getElementById("pause-button")!;
const orientationButton = document.getElementById("orientation-button")!;
let lastRendered = "";
// La dernière liste reçue, pour calculer la commande d'invitation au clic.
let windows: GameWindow[] = [];

let orientation: Orientation = readOrientation();
let lines = readLines(orientation);

/** Relit les fenêtres et redessine les pseudos si quelque chose a changé. */
async function refresh(): Promise<void> {
  // Le thème peut avoir été changé dans la fenêtre principale.
  applyTheme();

  windows = await invoke<GameWindow[]>("list_windows");
  renderInviteButton();
  const rendered = JSON.stringify(windows.filter((w) => w.character !== null));
  if (rendered === lastRendered) return;
  lastRendered = rendered;
  renderCharacters(parts.characters, windows);
  layout();
}

/**
 * Le bouton 👥 suit les règles de `invitePlan` (common.ts) : grisé s'il n'y a
 * rien à copier ; le survol montre la commande, et le personnage qui recevra
 * la couronne s'il n'y en a pas encore.
 */
function renderInviteButton(): void {
  const plan = invitePlan(windows);
  inviteButton.disabled = plan.kind !== "ready";
  let label: string;
  if (plan.kind !== "ready") label = `Copier les invitations : ${plan.reason}`;
  else if (plan.newLeader) label = `Couronner ${plan.newLeader} et copier : ${plan.command}`;
  else label = `Copier les invitations : ${plan.command}`;
  inviteButton.title = label;
  inviteButton.setAttribute("aria-label", label);
}

/**
 * Copie les invitations, et affiche ✓ (ou ✗ en cas d'échec) un court instant.
 * On relit d'abord la liste : sans couronne, c'est la fenêtre au premier
 * plan à cet instant qui devient chef.
 */
async function onCopyInvites(): Promise<void> {
  windows = await invoke<GameWindow[]>("list_windows");
  const plan = invitePlan(windows);
  if (plan.kind !== "ready") return;
  let ok = true;
  try {
    await copyInvites(plan);
  } catch {
    ok = false;
  }
  inviteButton.textContent = ok ? "✓" : "✗";
  setTimeout(() => (inviteButton.textContent = "👥"), 1500);
}

/**
 * Bouton 🔃 : range les fenêtres Dofus de la barre des tâches dans l'ordre de
 * la liste (comme le bouton de la fenêtre principale), puis affiche ✓ (ou ✗
 * en cas d'échec) un court instant.
 */
async function onReorderTaskbar(): Promise<void> {
  let ok = true;
  try {
    await invoke("reorder_taskbar");
  } catch {
    ok = false;
  }
  reorderButton.textContent = ok ? "✓" : "✗";
  setTimeout(() => (reorderButton.textContent = "🔃"), 1500);
}

// ---------------------------------------------------------------------------
// Taille de la fenêtre
//
// La fenêtre colle à son contenu. Quand l'utilisateur étire un bord, on
// laisse faire Windows pendant le geste, en redisposant les pseudos selon la
// place (une colonne de plus dès qu'elle tient...) ; une fois le geste fini,
// le nombre de lignes est retenu et la fenêtre se recolle au contenu.
// ---------------------------------------------------------------------------

/** Redispose le bandeau et met à jour le bouton d'orientation. */
function layout(): void {
  layoutPip(parts, orientation, lines);
  const vertical = orientation === "vertical";
  const label = vertical ? "Passer le bandeau à l'horizontale" : "Passer le bandeau à la verticale";
  orientationButton.textContent = vertical ? "⇆" : "⇅";
  orientationButton.title = label;
  orientationButton.setAttribute("aria-label", label);
}

/**
 * Les tailles que nous avons nous-mêmes demandées à la fenêtre ces dernières
 * secondes : un changement de taille qui n'en fait pas partie vient de
 * l'utilisateur (il étire un bord).
 */
const requestedSizes: (Size & { at: number })[] = [];

/** Vrai pendant que l'utilisateur étire le bandeau : on ne le recolle pas. */
let userResizing = false;
let settleTimer: number | undefined;

/** La fenêtre prend la taille du contenu, et reste entièrement sur son écran. */
async function fitToContent(): Promise<void> {
  if (userResizing) return;
  const { width, height } = parts.root.getBoundingClientRect();
  const size = { width: Math.ceil(width), height: Math.ceil(height) };
  const now = Date.now();
  requestedSizes.push({ ...size, at: now });
  while (requestedSizes.length > 0 && now - requestedSizes[0].at > 2000) requestedSizes.shift();
  await getCurrentWindow().setSize(new LogicalSize(size.width, size.height));
  await moveBackOnScreen();
}

/** La fenêtre a changé de taille : à notre demande, ou par l'utilisateur. */
function onWindowResized(): void {
  const size = { width: window.innerWidth, height: window.innerHeight };
  const ours = requestedSizes.some(
    (r) => Math.abs(r.width - size.width) <= 2 && Math.abs(r.height - size.height) <= 2,
  );
  if (ours && !userResizing) return;
  // L'utilisateur étire un bord : nombre de lignes selon la place (retenu
  // tout de suite, pour que l'aperçu de la fenêtre principale suive).
  userResizing = true;
  const newLines = linesForSize(parts, orientation, size);
  if (newLines !== lines) {
    lines = newLines;
    saveLines(orientation, lines);
    layout();
  }
  // Geste fini (plus de changement depuis un moment) : on recolle.
  clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => {
    userResizing = false;
    fireAndForget(fitToContent());
  }, RESIZE_SETTLE_MS);
}

/**
 * Relit orientation et nombre de lignes dans les préférences et les
 * applique. Appelée quand elles changent ici (bouton ⇅, double-clic) ou dans
 * l'onglet « Bandeau » de la fenêtre principale.
 */
async function applyPrefs(): Promise<void> {
  orientation = readOrientation();
  lines = readLines(orientation);
  layout();
  await fitToContent();
}

/** Bouton ⇅ / ⇆ : change d'orientation, avec le nombre de lignes retenu pour elle. */
async function toggleOrientation(): Promise<void> {
  writeOrientation(orientation === "vertical" ? "horizontal" : "vertical");
  await applyPrefs();
}

/** Double-clic sur la poignée : retour à une seule ligne. */
async function resetLines(): Promise<void> {
  saveLines(orientation, 1);
  await applyPrefs();
}

async function start(): Promise<void> {
  applyTheme();
  // Sans taille minimale, Windows empêche une fenêtre redimensionnable d'être
  // aussi basse que le bandeau horizontal.
  fireAndForget(getCurrentWindow().setMinSize(new LogicalSize(24, 24)));
  layout();
  // La fenêtre suit le contenu (un pseudo de plus, une colonne de plus...).
  new ResizeObserver(handler(fitToContent)).observe(parts.root);
  window.addEventListener("resize", onWindowResized);
  // Réglages changés dans la fenêtre principale (l'événement `storage` ne
  // vient que des autres fenêtres, jamais de nos propres écritures).
  window.addEventListener("storage", (event) => {
    if (isPipPref(event.key)) fireAndForget(applyPrefs());
  });
  orientationButton.addEventListener("click", handler(toggleOrientation));
  // `detail === 2` : deuxième clic rapide. On écoute `mousedown` car le
  // premier clic lance le déplacement de la fenêtre, et l'événement
  // `dblclick` n'arriverait pas toujours.
  document.getElementById("grip")!.addEventListener("mousedown", (event) => {
    if (event.detail === 2) fireAndForget(resetLines());
  });
  document.getElementById("restore-button")!.addEventListener("click", handler(restoreMain));
  pauseButton.addEventListener("click", () => fireAndForget(invoke("toggle_pause")));
  inviteButton.addEventListener("click", handler(onCopyInvites));
  reorderButton.addEventListener("click", handler(onReorderTaskbar));
  // Le rafraîchissement régulier démarre en premier : si un appel à Rust
  // échoue au démarrage, les pseudos apparaîtront quand même.
  refreshWhileVisible(() => fireAndForget(refresh()), REFRESH_INTERVAL_MS);
  fireAndForget(refresh());
  fireAndForget(
    invoke<boolean>("is_paused").then((paused) => renderPauseButton(pauseButton, paused)),
  );
  await placePip();
  // Rust prévient quand la fenêtre active change, quand les raccourcis sont
  // coupés / réactivés, et quand la couronne change (ici ou ailleurs).
  await listen("foreground-changed", () => {
    if (!document.hidden) fireAndForget(refresh());
  });
  await listen<boolean>("shortcuts-paused-changed", (event) =>
    renderPauseButton(pauseButton, event.payload),
  );
  await listen("config-changed", handler(refresh));
}

reportUncaughtErrors();
window.addEventListener("DOMContentLoaded", handler(start));
