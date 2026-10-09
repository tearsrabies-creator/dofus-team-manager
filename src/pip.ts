// La logique du bandeau : une rangée de pseudos cliquables pour passer d'une
// fenêtre Dofus à l'autre en un clic, sans quitter le jeu des yeux.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { classBadge } from "./classes";
import {
  applyTheme,
  copyInvites,
  crownButton,
  fitWindowToContent,
  GameWindow,
  invitePlan,
  placePip,
  refreshWhileVisible,
  restoreMain,
} from "./common";

// Le bandeau relit la liste un peu plus souvent que la fenêtre principale,
// pour que la fenêtre active soit vite à jour (seulement quand il est visible).
const REFRESH_INTERVAL_MS = 1500;

const characters = document.getElementById("characters")!;
const inviteButton = document.getElementById("invite-button") as HTMLButtonElement;
let lastRendered = "";
// La dernière liste reçue, pour calculer la commande d'invitation au clic.
let windows: GameWindow[] = [];

/** Relit les fenêtres et redessine les pseudos si quelque chose a changé. */
async function refresh() {
  // Le thème peut avoir été changé dans la fenêtre principale.
  applyTheme();

  windows = await invoke<GameWindow[]>("list_windows");
  renderInviteButton();
  // Seulement les fenêtres connectées : sans pseudo, rien à afficher.
  const connected = windows.filter((w) => w.character !== null);
  const rendered = JSON.stringify(connected);
  if (rendered === lastRendered) return;
  lastRendered = rendered;

  characters.replaceChildren(
    ...connected.map((w) => {
      // Un encadré par personnage, qui contient le bouton du pseudo et sa
      // couronne (deux boutons distincts : un bouton ne peut pas en contenir
      // un autre). `crown-host` : la couronne apparaît au survol (styles.css).
      const box = document.createElement("span");
      box.className = "character crown-host";
      box.classList.toggle("active", w.active);
      box.classList.toggle("unselected", !w.selected);

      const button = document.createElement("button");
      button.type = "button";
      button.className = "character-name";
      button.title = `Afficher ${w.character}`;
      button.append(classBadge(w.className), w.character!);
      button.addEventListener("click", () => invoke("activate_window", { id: w.id }));

      // La couronne, partagée avec la fenêtre principale (voir common.ts).
      box.append(button, crownButton(w));
      return box;
    }),
  );
  if (connected.length === 0) {
    const empty = document.createElement("span");
    empty.className = "empty";
    empty.textContent = "Aucun personnage";
    characters.append(empty);
  }
}

/**
 * Le bouton 👥 suit les règles de `invitePlan` (common.ts) : grisé s'il n'y a
 * rien à copier ; le survol montre la commande, et le personnage qui recevra
 * la couronne s'il n'y en a pas encore.
 */
function renderInviteButton() {
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
async function onCopyInvites() {
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

/** Le bouton ⏸ / ▶ du bandeau, comme celui de la fenêtre principale. */
function renderPause(paused: boolean) {
  const button = document.getElementById("pause-button")!;
  button.textContent = paused ? "▶" : "⏸";
  const label = paused ? "Raccourcis coupés : cliquer pour les réactiver" : "Couper les raccourcis";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-pressed", String(paused));
}

window.addEventListener("DOMContentLoaded", async () => {
  applyTheme();
  // `true` : le bandeau reste entièrement sur son écran quand il s'élargit.
  fitWindowToContent(document.getElementById("root")!, true);
  document.getElementById("restore-button")!.addEventListener("click", restoreMain);
  document.getElementById("pause-button")!.addEventListener("click", () => invoke("toggle_pause"));
  inviteButton.addEventListener("click", onCopyInvites);
  renderPause(await invoke<boolean>("is_paused"));
  await placePip();

  await refresh();
  refreshWhileVisible(refresh, REFRESH_INTERVAL_MS);
  // Rust prévient quand la fenêtre active change, ou quand les raccourcis
  // sont coupés / réactivés.
  listen("foreground-changed", () => {
    if (!document.hidden) refresh();
  });
  listen<boolean>("shortcuts-paused-changed", (event) => renderPause(event.payload));
  // La couronne a changé (ici ou dans la fenêtre principale) : on redessine.
  listen("config-changed", () => refresh());
});
