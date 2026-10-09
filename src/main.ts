// La logique de la fenêtre principale, en TypeScript (du JavaScript avec des
// types).
//
// Principe : l'interface ne sait rien faire seule avec Windows. Elle demande
// tout à la partie Rust avec `invoke("nom_de_commande", { arguments })`, qui
// rend une « promesse » (Promise) : la réponse arrivera plus tard, d'où les
// `await` (« attendre la réponse avant de continuer ») dans les fonctions
// marquées `async`.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { classBadge } from "./classes";
// Les types et outils partagés avec le bandeau (voir common.ts).
import {
  applyTheme,
  Config,
  copyInvites,
  crownButton,
  currentTheme,
  fitWindowToContent,
  GameWindow,
  invitePlan,
  pipWindow,
  readPref,
  refreshWhileVisible,
  writePref,
} from "./common";

// Toutes les combien de millisecondes on relit la liste des fenêtres
// (seulement quand la fenêtre est visible).
const REFRESH_INTERVAL_MS = 2000;

// ---------------------------------------------------------------------------
// État de l'interface
// ---------------------------------------------------------------------------

let config: Config;
let windows: GameWindow[] = [];
// La dernière liste affichée, en texte, pour ne redessiner que si elle change.
let lastRendered = "";
// Vrai pendant qu'on fait glisser une ligne : on ne redessine pas la liste.
let dragging = false;

// Raccourci pour trouver un élément de la page par son id.
// Le `!` dit à TypeScript « je sais qu'il existe » (il est dans index.html).
const el = (id: string) => document.getElementById(id)!;

// ---------------------------------------------------------------------------
// Fenêtres de jeu
// ---------------------------------------------------------------------------

/** Redemande la liste à Rust et la redessine si elle a changé. */
async function refresh(force = false) {
  // Pendant un glisser-déposer ou la saisie d'un raccourci dans la liste, on
  // ne redessine pas : ça ferait disparaître ce que l'utilisateur manipule.
  // (Seuls les champs de raccourci comptent : un bouton ou une case cliqués
  // gardent aussi le focus, mais doivent bien voir la liste se mettre à jour.)
  const focused = document.activeElement;
  const capturing = focused instanceof HTMLInputElement && focused.classList.contains("shortcut");
  if (dragging || (capturing && el("window-list").contains(focused))) return;

  windows = await invoke<GameWindow[]>("list_windows");
  const rendered = JSON.stringify(windows);
  if (!force && rendered === lastRendered) return;
  lastRendered = rendered;

  // Rust a pu ajouter de nouveaux personnages à la configuration : on la relit.
  config = await invoke<Config>("read_config");
  renderWindows();
  renderInvites();
}

/** Construit la liste des fenêtres dans la page. */
function renderWindows() {
  const list = el("window-list");
  list.replaceChildren(); // vide la liste avant de la reconstruire

  if (windows.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Aucune fenêtre Dofus ouverte.";
    list.append(empty);
    return;
  }

  for (const w of windows) {
    const connected = w.character !== null;
    const row = document.createElement("li");
    row.className = "window-row";
    row.classList.toggle("active", w.active);
    row.classList.toggle("unselected", !w.selected);

    // La poignée : on attrape la ligne par ici pour la déplacer. Une fenêtre
    // non connectée n'a pas de place dans l'ordre : pas de poignée (mais on
    // garde la place pour que les lignes restent alignées).
    const grip = document.createElement("span");
    grip.className = "grip";
    grip.textContent = "⠿";
    if (connected) {
      grip.title = "Glisser pour changer l'ordre";
      row.classList.add("draggable");
      row.dataset.key = w.key; // `data-key` : la clé, relue après le déplacement
      enableDrag(grip, row);
    } else {
      grip.style.visibility = "hidden";
    }

    // Case à cocher : inclure ou non la fenêtre dans la navigation.
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = w.selected;
    checkbox.disabled = !connected;
    checkbox.title = "Inclure dans la navigation";
    checkbox.addEventListener("change", () => setSelected(w.key, checkbox.checked));

    const number = document.createElement("span");
    number.className = "number";
    number.textContent = w.number !== null ? String(w.number) : "–";

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = w.character ?? "Non connectée";
    name.title = w.title;
    // La classe s'affiche sous le nom (voir `.name small` dans styles.css).
    if (w.className) {
      const className = document.createElement("small");
      className.textContent = w.className;
      name.append(className);
    }

    // La couronne du chef de groupe (partagée avec le bandeau, voir common.ts).
    // La ligne porte la classe `crown-host` pour l'apparence au survol.
    const crown = crownButton(w);
    row.classList.add("crown-host");
    if (!connected) crown.style.visibility = "hidden";

    row.append(grip, checkbox, number, classBadge(w.className), name, crown);

    // Raccourci optionnel propre au personnage (pas pour une fenêtre non
    // connectée : sans nom, impossible de l'enregistrer).
    if (w.character !== null) {
      const character = w.character;
      // Même principe : toujours la version actuelle de la configuration.
      const keys = () => config.shortcuts.characters;
      row.append(
        ...shortcutField(
          `Raccourci de ${character}`,
          () => keys()[character] ?? "",
          // Un raccourci vide est retiré du dictionnaire (`delete`).
          (v) => (v ? (keys()[character] = v) : delete keys()[character]),
        ),
      );
    }

    list.append(row);
  }
}

/**
 * Permet de faire glisser `row` en la tenant par `grip`.
 *
 * On utilise les « pointer events » (souris, stylet ou doigt) :
 * - `pointerdown` sur la poignée : on attrape la ligne ;
 * - `pointermove` : à chaque mouvement, on la replace dans la liste, avant
 *   la première ligne dont le milieu est plus bas que le pointeur ;
 * - `pointerup` : on la lâche, on lit le nouvel ordre et on l'enregistre.
 * Les mouvements et le lâcher sont écoutés sur toute la page (`document`),
 * pas seulement sur la poignée : le pointeur la quitte dès qu'on bouge.
 */
function enableDrag(grip: HTMLElement, row: HTMLLIElement) {
  grip.addEventListener("pointerdown", (down) => {
    down.preventDefault(); // pas de sélection de texte pendant le glisser
    dragging = true;
    row.classList.add("dragging");
    const list = el("window-list");
    const draggableRows = () => [...list.querySelectorAll<HTMLLIElement>("li.draggable")];

    const onMove = (move: PointerEvent) => {
      const others = draggableRows().filter((r) => r !== row);
      const before = others.find((r) => {
        const box = r.getBoundingClientRect();
        return move.clientY < box.top + box.height / 2;
      });
      if (before) list.insertBefore(row, before);
      else others[others.length - 1]?.after(row); // après la dernière ligne
    };

    const onUp = async () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      row.classList.remove("dragging");
      applyOrder(draggableRows().map((r) => r.dataset.key!));
      dragging = false;
      await save();
      await refresh(true);
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  });
}

/**
 * Reporte le nouvel ordre des lignes affichées dans `config.order`, qui
 * contient aussi les personnages absents. On réutilise les mêmes places
 * (« slots ») qu'avant, triées : les personnages absents ne bougent pas.
 */
function applyOrder(keys: string[]) {
  const slots = keys
    .map((key) => config.order.indexOf(key))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b);
  slots.forEach((slot, i) => (config.order[slot] = keys[i]));
}

/** Petit bouton réutilisable. */
function iconButton(text: string, label: string, action: () => void) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "small";
  button.textContent = text;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.addEventListener("click", action);
  return button;
}

/** Coche ou décoche une fenêtre, puis enregistre. */
async function setSelected(key: string, selected: boolean) {
  config.selection = config.selection.filter((k) => k !== key);
  if (selected) config.selection.push(key);
  await save();
  await refresh(true);
}

// ---------------------------------------------------------------------------
// Invitations de groupe
// ---------------------------------------------------------------------------

// Les règles (qui est le chef, qui inviter, quand le bouton est grisé) sont
// dans `invitePlan` (common.ts), partagé avec le bandeau.
function renderInvites() {
  const plan = invitePlan(windows);
  el("invite-preview").textContent = plan.kind === "ready" ? plan.command : plan.reason;
  (el("copy-invites") as HTMLButtonElement).disabled = plan.kind !== "ready";
}

async function onCopyInvites() {
  const plan = invitePlan(windows);
  if (plan.kind !== "ready") return;
  const confirmation = el("copy-confirmation");
  try {
    await copyInvites(plan);
    confirmation.textContent = "Copié !";
  } catch (e) {
    confirmation.textContent = `Échec : ${e}`;
  }
  setTimeout(() => (confirmation.textContent = ""), 2000);
}

// ---------------------------------------------------------------------------
// Raccourcis
// ---------------------------------------------------------------------------

/** Construit les champs « suivante / précédente / interrupteur ». */
function renderShortcuts() {
  // Les fonctions vont chercher `config.shortcuts` au moment où on les
  // appelle, pas au moment où on les crée : `config` est remplacé à chaque
  // relecture, et il faut toujours modifier la version actuelle.
  const s = () => config.shortcuts;
  const rows: [string, () => string, (v: string) => void][] = [
    ["Fenêtre suivante", () => s().next, (v) => (s().next = v)],
    ["Fenêtre précédente", () => s().previous, (v) => (s().previous = v)],
    ["Couper / réactiver les raccourcis", () => s().toggle, (v) => (s().toggle = v)],
  ];

  const container = el("shortcuts");
  container.replaceChildren();
  for (const [label, read, write] of rows) {
    const [field, clear] = shortcutField(label, read, write);
    const wrapper = document.createElement("label");
    wrapper.append(label, field);
    container.append(wrapper, clear);
  }
}

/**
 * Fabrique un champ de saisie de raccourci et son bouton « effacer ».
 * `read` donne la valeur actuelle, `write` la modifie dans `config` :
 * le même code sert ainsi pour tous les raccourcis, où qu'ils soient rangés.
 */
function shortcutField(
  label: string,
  read: () => string,
  write: (v: string) => void,
): [HTMLInputElement, HTMLButtonElement] {
  const field = document.createElement("input");
  field.className = "shortcut";
  field.readOnly = true; // on ne tape pas dedans, on « capture » les touches
  field.placeholder = "Raccourci";
  field.title = label;
  field.setAttribute("aria-label", label);
  field.value = readable(read());
  enableCapture(field, read, write);

  const clear = iconButton("✕", `Effacer « ${label} »`, async () => {
    write("");
    field.value = "";
    await save();
  });
  return [field, clear];
}

// Les quatre familles de modificateurs : nom générique, touche gauche,
// touche droite (noms du web, tels que donnés par `KeyboardEvent.code`).
const MODIFIER_FAMILIES: [string, string, string][] = [
  ["Control", "ControlLeft", "ControlRight"],
  ["Alt", "AltLeft", "AltRight"],
  ["Shift", "ShiftLeft", "ShiftRight"],
  ["Super", "MetaLeft", "MetaRight"],
];
const MODIFIER_CODES = MODIFIER_FAMILIES.flatMap(([, left, right]) => [left, right]);

/**
 * Transforme un champ en zone de capture : quand il a le focus, la prochaine
 * combinaison de touches devient le raccourci.
 */
function enableCapture(field: HTMLInputElement, read: () => string, write: (v: string) => void) {
  // Les modificateurs enfoncés pendant la saisie, avec leur côté
  // (« ControlLeft », « AltRight »...). Un `Set` est une liste sans doublon.
  const held = new Set<string>();
  // Vrai si Alt droit a été pressé en tant qu'AltGr (claviers français) :
  // Windows simule alors en plus un appui sur Ctrl gauche, qu'on ignore.
  let altGraph = false;

  // Pendant la saisie, on suspend les raccourcis pour que Windows ne les
  // intercepte pas avant qu'ils n'arrivent ici.
  field.addEventListener("focus", () => {
    held.clear();
    altGraph = false;
    field.value = "Appuyez sur une combinaison…";
    invoke("suspend_shortcuts");
  });
  field.addEventListener("blur", async () => {
    field.value = readable(read());
    showErrors(await invoke<string[]>("resume_shortcuts"));
  });
  field.addEventListener("keyup", (e) => held.delete(e.code));

  field.addEventListener("keydown", async (e) => {
    e.preventDefault(); // empêche l'effet normal de la touche (Tab, etc.)
    if (e.code === "Escape") {
      field.blur();
      return;
    }
    // Un modificateur seul ne fait pas un raccourci : on le retient et on
    // attend la touche principale.
    if (MODIFIER_CODES.includes(e.code)) {
      held.add(e.code);
      if (e.key === "AltGraph") {
        altGraph = true;
        held.delete("ControlLeft");
      }
      return;
    }

    // Format compris par la partie Rust : « Control+Alt+KeyP », ou avec les
    // côtés « ControlLeft+AltRight+KeyP ». `e.code` désigne la touche
    // physique, quelle que soit la disposition du clavier.
    const distinguish = config.advanced.distinguishSides;
    const flags = [e.ctrlKey, e.altKey, e.shiftKey, e.metaKey];
    const parts: string[] = [];
    MODIFIER_FAMILIES.forEach(([generic, left, right], i) => {
      const leftDown = held.has(left);
      const rightDown = held.has(right);
      // Le faux Ctrl gauche d'AltGr ne compte pas (sauf avec les côtés
      // désactivés, où Windows traite de toute façon AltGr comme Ctrl + Alt).
      if (generic === "Control" && altGraph && distinguish && !rightDown) return;
      // `flags[i]` : l'indication du navigateur, au cas où le modificateur
      // était déjà enfoncé avant de cliquer dans le champ.
      if (!leftDown && !rightDown && !flags[i]) return;
      if (distinguish && leftDown !== rightDown) parts.push(leftDown ? left : right);
      else parts.push(generic);
    });
    parts.push(e.code);

    write(parts.join("+"));
    // On enregistre d'abord (Rust écrit le fichier et applique les nouveaux
    // raccourcis), puis on quitte le champ : `blur` réaffiche la valeur.
    await save();
    field.blur();
  });
}

// Ce que porte chaque touche sur le clavier de l'utilisateur (AZERTY,
// QWERTY...), fourni par le navigateur intégré : `KeyQ` → « a » en AZERTY.
let keyboardLayout: Map<string, string> | null = null;

async function loadKeyboardLayout() {
  try {
    // `as any` : cette fonction récente n'est pas encore décrite dans les
    // types de TypeScript utilisés ici.
    keyboardLayout = (await (navigator as any).keyboard?.getLayoutMap()) ?? null;
  } catch {
    keyboardLayout = null; // on affichera les noms QWERTY à la place
  }
}

/** « ControlLeft+Shift+KeyQ » devient « Ctrl G + Maj + A » (en AZERTY). */
function readable(shortcut: string): string {
  if (!shortcut) return "";
  const names: Record<string, string> = {
    Control: "Ctrl",
    ControlLeft: "Ctrl G",
    ControlRight: "Ctrl D",
    Alt: "Alt",
    AltLeft: "Alt G",
    AltRight: "Alt D",
    Shift: "Maj",
    ShiftLeft: "Maj G",
    ShiftRight: "Maj D",
    Super: "Win",
    MetaLeft: "Win G",
    MetaRight: "Win D",
    ArrowLeft: "←",
    ArrowRight: "→",
    ArrowUp: "↑",
    ArrowDown: "↓",
    Space: "Espace",
    Enter: "Entrée",
    Escape: "Échap",
    Backspace: "Retour",
    Delete: "Suppr",
    Insert: "Inser",
    Home: "Début",
    End: "Fin",
    PageUp: "Page ↑",
    PageDown: "Page ↓",
  };
  return shortcut
    .split("+")
    .map((code) => {
      if (names[code]) return names[code];
      if (code.startsWith("Digit")) return code.slice(5); // chiffre de la rangée du haut
      if (code.startsWith("Numpad")) return "Pavé " + code.slice(6);
      // Sinon : ce qui est écrit sur la touche, selon la disposition du clavier.
      const label = keyboardLayout?.get(code);
      return label ? label.toUpperCase() : code.replace(/^Key/, "");
    })
    .join(" + ");
}

function showErrors(errors: string[]) {
  el("errors").replaceChildren(
    ...errors.map((text) => {
      const item = document.createElement("li");
      item.textContent = text;
      return item;
    }),
  );
}

/** Le bouton ⏸ / ▶ montre si les raccourcis sont actifs ou coupés. */
function renderPause(paused: boolean) {
  const button = el("pause-button");
  button.textContent = paused ? "▶" : "⏸";
  const label = paused ? "Raccourcis coupés : cliquer pour les réactiver" : "Couper les raccourcis";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.setAttribute("aria-pressed", String(paused));
}

// ---------------------------------------------------------------------------
// Affichage : aide, thème, bandeau, masquage
// ---------------------------------------------------------------------------

/** Affiche ou masque les textes d'aide (classe `no-help` sur la page). */
function applyHelp() {
  const visible = readPref("help") !== "hidden";
  document.body.classList.toggle("no-help", !visible);
  el("help-button").setAttribute("aria-pressed", String(visible));
}

function toggleHelp() {
  writePref("help", readPref("help") === "hidden" ? "visible" : "hidden");
  applyHelp();
}

/** Le bouton montre le thème vers lequel on va basculer. */
function renderThemeButton() {
  el("theme-button").textContent = currentTheme() === "dark" ? "☀" : "☾";
}

function toggleTheme() {
  writePref("theme", currentTheme() === "dark" ? "light" : "dark");
  applyTheme();
  renderThemeButton();
}

/** L'option « afficher le bandeau quand l'organizer est masqué » (oui par défaut). */
const pipOnMinimize = () => readPref("pip-on-minimize") !== "no";

// Vrai quand le bandeau a été ouvert automatiquement par le masquage : il
// sera alors refermé automatiquement quand l'organizer reviendra.
let pipOpenedByMinimize = false;

/** Bouton ▭ : ouvre ou ferme le bandeau à la main. */
async function togglePip() {
  const pip = await pipWindow();
  if (!pip) return;
  pipOpenedByMinimize = false;
  if (await pip.isVisible()) await pip.hide();
  else await pip.show();
}

/**
 * Réagit quand l'organizer est réduit ou revient, quelle qu'en soit la façon
 * (notre bouton —, celui de Windows, un clic dans la barre des tâches...).
 * Windows signale ces changements comme des redimensionnements.
 */
async function watchMinimize() {
  const main = getCurrentWindow();
  await main.onResized(async () => {
    const pip = await pipWindow();
    if (!pip) return;
    if (await main.isMinimized()) {
      if (pipOnMinimize() && !(await pip.isVisible())) {
        await pip.show();
        pipOpenedByMinimize = true;
      }
    } else if (pipOpenedByMinimize) {
      await pip.hide();
      pipOpenedByMinimize = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Enregistrement et démarrage
// ---------------------------------------------------------------------------

/** Envoie la configuration à Rust, qui l'écrit sur le disque. */
async function save() {
  try {
    showErrors(await invoke<string[]>("save_config", { config }));
  } catch (e) {
    showErrors([`Impossible d'enregistrer la configuration : ${e}`]);
  }
}

// Point de départ : quand la page est chargée, on applique les préférences,
// on lit la configuration, on dessine tout, puis on relit les fenêtres
// régulièrement (seulement quand l'organizer est visible).
window.addEventListener("DOMContentLoaded", async () => {
  applyTheme();
  renderThemeButton();
  applyHelp();
  // La fenêtre prend la taille de son contenu, et la suit quand il change.
  fitWindowToContent(el("root"));

  await loadKeyboardLayout();
  config = await invoke<Config>("read_config");
  renderShortcuts();
  renderPause(await invoke<boolean>("is_paused"));
  await refresh(true);

  el("copy-invites").addEventListener("click", onCopyInvites);
  el("help-button").addEventListener("click", toggleHelp);
  el("theme-button").addEventListener("click", toggleTheme);
  el("pause-button").addEventListener("click", () => invoke("toggle_pause"));
  el("pip-button").addEventListener("click", togglePip);
  el("minimize-button").addEventListener("click", () => getCurrentWindow().minimize());
  // Fermer la fenêtre principale quitte toute l'application (voir lib.rs).
  el("close-button").addEventListener("click", () => getCurrentWindow().close());

  const sidesCheckbox = el("distinguish-sides") as HTMLInputElement;
  sidesCheckbox.checked = config.advanced.distinguishSides;
  sidesCheckbox.addEventListener("change", async () => {
    config.advanced.distinguishSides = sidesCheckbox.checked;
    await save(); // Rust change de moteur (raccourcis Windows ou crochet)
  });

  const pipCheckbox = el("pip-on-minimize") as HTMLInputElement;
  pipCheckbox.checked = pipOnMinimize();
  pipCheckbox.addEventListener("change", () =>
    writePref("pip-on-minimize", pipCheckbox.checked ? "yes" : "no"),
  );
  await watchMinimize();

  refreshWhileVisible(refresh, REFRESH_INTERVAL_MS);
  // Rust prévient quand la fenêtre au premier plan change, ou quand les
  // raccourcis sont coupés / réactivés (par le raccourci ou le bandeau).
  listen("foreground-changed", () => {
    if (!document.hidden) refresh();
  });
  listen<boolean>("shortcuts-paused-changed", (event) => renderPause(event.payload));
  // La configuration a changé ailleurs (couronne donnée depuis le bandeau...) :
  // on la relit et on redessine, même si la fenêtre est cachée, pour ne
  // jamais garder une copie dépassée.
  // (On relit d'abord la configuration à part : `refresh` peut s'abstenir,
  // par exemple pendant la saisie d'un raccourci.)
  listen("config-changed", async () => {
    config = await invoke<Config>("read_config");
    await refresh(true);
  });
});
