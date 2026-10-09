// La logique du bandeau : une rangée de pseudos cliquables pour passer d'une
// fenêtre Dofus à l'autre en un clic, sans quitter le jeu des yeux.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { classBadge } from "./classes";
import {
  applyTheme,
  copyInvites,
  crownButton,
  fireAndForget,
  fitWindowToContent,
  GameWindow,
  handler,
  invitePlan,
  placePip,
  refreshWhileVisible,
  renderPauseButton,
  restoreMain,
} from "./common";

// Le bandeau relit la liste un peu plus souvent que la fenêtre principale,
// pour que la fenêtre active soit vite à jour (seulement quand il est visible).
const REFRESH_INTERVAL_MS = 1500;

const characters = document.getElementById("characters")!;
const inviteButton = document.getElementById("invite-button") as HTMLButtonElement;
const pauseButton = document.getElementById("pause-button")!;
let lastRendered = "";
// La dernière liste reçue, pour calculer la commande d'invitation au clic.
let windows: GameWindow[] = [];

/** Relit les fenêtres et redessine les pseudos si quelque chose a changé. */
async function refresh(): Promise<void> {
  // Le thème peut avoir été changé dans la fenêtre principale.
  applyTheme();

  windows = await invoke<GameWindow[]>("list_windows");
  renderInviteButton();
  // Seulement les fenêtres connectées : sans pseudo, rien à afficher.
  const connected = windows.filter((w) => w.character !== null);
  const rendered = JSON.stringify(connected);
  if (rendered === lastRendered) return;
  lastRendered = rendered;

  if (connected.length === 0) {
    const empty = document.createElement("span");
    empty.className = "empty";
    empty.textContent = "Aucun personnage";
    characters.replaceChildren(empty);
    return;
  }
  characters.replaceChildren(...connected.map(characterBox));
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

async function start(): Promise<void> {
  applyTheme();
  // `true` : le bandeau reste entièrement sur son écran quand il s'élargit.
  fitWindowToContent(document.getElementById("root")!, true);
  document.getElementById("restore-button")!.addEventListener("click", handler(restoreMain));
  pauseButton.addEventListener("click", () => fireAndForget(invoke("toggle_pause")));
  inviteButton.addEventListener("click", handler(onCopyInvites));
  renderPauseButton(pauseButton, await invoke<boolean>("is_paused"));
  await placePip();

  await refresh();
  refreshWhileVisible(() => fireAndForget(refresh()), REFRESH_INTERVAL_MS);
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

window.addEventListener("DOMContentLoaded", handler(start));
