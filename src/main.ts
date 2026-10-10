// La logique de la fenêtre principale, en TypeScript (du JavaScript avec des
// types).
//
// Principe : l'interface ne sait rien faire seule avec Windows. Elle demande
// tout à la partie Rust avec `invoke("nom_de_commande", { arguments })`, qui
// rend une « promesse » (Promise) : la réponse arrivera plus tard, d'où les
// `await` (« attendre la réponse avant de continuer ») dans les fonctions
// marquées `async`.
//
// Ce fichier assemble la page ; les morceaux réutilisables sont ailleurs :
// - common.ts : ce qui est partagé avec le bandeau ;
// - shortcut-field.ts : la saisie des raccourcis ;
// - classes.ts : les symboles de classe.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { classBadge } from "./classes";
import {
  applyTheme,
  Config,
  copyInvites,
  crownButton,
  currentTheme,
  fireAndForget,
  fitWindowToContent,
  GameWindow,
  handler,
  invitePlan,
  pipWindow,
  readPref,
  refreshWhileVisible,
  renderPauseButton,
  reportUncaughtErrors,
  retry,
  writePref,
} from "./common";
import { loadKeyboardLayout, ShortcutFieldContext, shortcutField } from "./shortcut-field";

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

// Ce que les champs de raccourci (shortcut-field.ts) attendent de la page.
const shortcutContext: ShortcutFieldContext = {
  distinguishSides: () => config.advanced.distinguishSides,
  save,
  showErrors,
};

// ---------------------------------------------------------------------------
// Fenêtres de jeu
// ---------------------------------------------------------------------------

/** Redemande la liste à Rust et la redessine si elle a changé. */
async function refresh(force = false): Promise<void> {
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
function renderWindows(): void {
  const list = el("window-list");
  if (windows.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Aucune fenêtre Dofus ouverte.";
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...windows.map(windowRow));
}

/** Une ligne de la liste : poignée, case, numéro, classe, nom, couronne, raccourci. */
function windowRow(w: GameWindow): HTMLLIElement {
  const connected = w.character !== null;
  const row = document.createElement("li");
  // `crown-host` : la couronne apparaît au survol de la ligne (styles.css).
  row.className = "window-row crown-host";
  row.classList.toggle("active", w.active);
  row.classList.toggle("unselected", !w.selected);

  // La poignée : on attrape la ligne par ici pour la déplacer. Une fenêtre
  // non connectée n'a pas de place dans l'ordre : pas de poignée, ni de
  // couronne (classe `invisible` : la place reste réservée, pour que les
  // lignes restent alignées).
  const grip = document.createElement("span");
  grip.className = "grip";
  grip.textContent = "⠿";
  if (connected) {
    grip.title = "Glisser pour changer l'ordre";
    row.classList.add("draggable");
    row.dataset.key = w.key; // `data-key` : la clé, relue après le déplacement
    enableDrag(grip, row);
  } else {
    grip.classList.add("invisible");
  }

  // Case à cocher : inclure ou non la fenêtre dans la navigation.
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = w.selected;
  checkbox.disabled = !connected;
  checkbox.title = "Inclure dans la navigation";
  checkbox.addEventListener(
    "change",
    handler(() => setSelected(w.key, checkbox.checked)),
  );

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
  const crown = crownButton(w);
  if (!connected) crown.classList.add("invisible");

  row.append(grip, checkbox, number, classBadge(w.className), name, crown);

  // Raccourci optionnel propre au personnage (pas pour une fenêtre non
  // connectée : sans nom, impossible de l'enregistrer).
  if (w.character !== null) {
    const character = w.character;
    // Les fonctions vont chercher `config` au moment où on les appelle :
    // `config` est remplacé à chaque relecture, et il faut toujours modifier
    // la version actuelle.
    const keys = () => config.shortcuts.characters;
    row.append(
      ...shortcutField(
        `Raccourci de ${character}`,
        () => keys()[character] ?? "",
        // Un raccourci vide est retiré du dictionnaire (`delete`).
        (value) => {
          if (value) keys()[character] = value;
          else delete keys()[character];
        },
        shortcutContext,
      ),
    );
  }
  return row;
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
function enableDrag(grip: HTMLElement, row: HTMLLIElement): void {
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

    const onUp = handler(async () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      row.classList.remove("dragging");
      applyOrder(draggableRows().map((r) => r.dataset.key!));
      dragging = false;
      await save();
      await refresh(true);
    });

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
function applyOrder(keys: string[]): void {
  const slots = keys
    .map((key) => config.order.indexOf(key))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b);
  slots.forEach((slot, i) => (config.order[slot] = keys[i]));
}

/** Coche ou décoche une fenêtre, puis enregistre. */
async function setSelected(key: string, selected: boolean): Promise<void> {
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
function renderInvites(): void {
  const plan = invitePlan(windows);
  el("invite-preview").textContent = plan.kind === "ready" ? plan.command : plan.reason;
  (el("copy-invites") as HTMLButtonElement).disabled = plan.kind !== "ready";
}

async function onCopyInvites(): Promise<void> {
  const plan = invitePlan(windows);
  if (plan.kind !== "ready") return;
  const confirmation = el("copy-confirmation");
  try {
    await copyInvites(plan);
    confirmation.textContent = "Copié !";
  } catch (error) {
    confirmation.textContent = `Échec : ${String(error)}`;
  }
  setTimeout(() => (confirmation.textContent = ""), 2000);
}

// ---------------------------------------------------------------------------
// Raccourcis
// ---------------------------------------------------------------------------

/** Construit les champs « suivante / précédente / interrupteur ». */
function renderShortcuts(): void {
  // Même principe que dans `windowRow` : toujours la version actuelle.
  const s = () => config.shortcuts;
  const rows: [string, () => string, (value: string) => void][] = [
    ["Fenêtre suivante", () => s().next, (value) => (s().next = value)],
    ["Fenêtre précédente", () => s().previous, (value) => (s().previous = value)],
    ["Couper / réactiver les raccourcis", () => s().toggle, (value) => (s().toggle = value)],
  ];

  const container = el("shortcuts");
  container.replaceChildren();
  for (const [label, read, write] of rows) {
    const [field, clear] = shortcutField(label, read, write, shortcutContext);
    const wrapper = document.createElement("label");
    wrapper.append(label, field);
    container.append(wrapper, clear);
  }
}

function showErrors(errors: string[]): void {
  el("errors").replaceChildren(
    ...errors.map((text) => {
      const item = document.createElement("li");
      item.textContent = text;
      return item;
    }),
  );
}

// ---------------------------------------------------------------------------
// Affichage : aide, thème, bandeau, masquage
// ---------------------------------------------------------------------------

/** Affiche ou masque les textes d'aide (classe `no-help` sur la page). */
function applyHelp(): void {
  const visible = readPref("help") !== "hidden";
  document.body.classList.toggle("no-help", !visible);
  el("help-button").setAttribute("aria-pressed", String(visible));
}

function toggleHelp(): void {
  writePref("help", readPref("help") === "hidden" ? "visible" : "hidden");
  applyHelp();
}

/** Le bouton montre le thème vers lequel on va basculer. */
function renderThemeButton(): void {
  el("theme-button").textContent = currentTheme() === "dark" ? "☀" : "☾";
}

function toggleTheme(): void {
  writePref("theme", currentTheme() === "dark" ? "light" : "dark");
  applyTheme();
  renderThemeButton();
}

/** L'option « afficher le bandeau quand l'application est masquée » (oui par défaut). */
const pipOnMinimize = () => readPref("pip-on-minimize") !== "no";

// Vrai quand le bandeau a été ouvert automatiquement par le masquage : il
// sera alors refermé automatiquement quand l'application reviendra.
let pipOpenedByMinimize = false;

/** Bouton ▭ : ouvre ou ferme le bandeau à la main. */
async function togglePip(): Promise<void> {
  const pip = await pipWindow();
  if (!pip) return;
  pipOpenedByMinimize = false;
  if (await pip.isVisible()) await pip.hide();
  else await pip.show();
}

/**
 * Bouton — : cache la fenêtre principale. Elle disparaît aussi de la barre
 * des tâches ; seule reste l'icône dans la zone de notification, près de
 * l'horloge (voir tray.rs), qui la fait revenir d'un clic. Le bandeau
 * s'ouvre à sa place si l'option est cochée.
 */
async function hideToTray(): Promise<void> {
  const pip = await pipWindow();
  if (pip && pipOnMinimize() && !(await pip.isVisible())) {
    await pip.show();
    pipOpenedByMinimize = true;
  }
  await getCurrentWindow().hide();
}

/**
 * Quand la fenêtre principale revient (icône de la zone de notification,
 * bouton ⤢ du bandeau...), on referme le bandeau s'il avait été ouvert
 * automatiquement par le masquage. `visibilitychange` est l'événement du
 * navigateur qui signale qu'une page est cachée ou de nouveau visible.
 */
function watchVisibility(): void {
  document.addEventListener(
    "visibilitychange",
    handler(async () => {
      if (document.hidden || !pipOpenedByMinimize) return;
      pipOpenedByMinimize = false;
      await (await pipWindow())?.hide();
    }),
  );
}

// ---------------------------------------------------------------------------
// Enregistrement et démarrage
// ---------------------------------------------------------------------------

/** Envoie la configuration à Rust, qui l'écrit sur le disque. */
async function save(): Promise<void> {
  try {
    showErrors(await invoke<string[]>("save_config", { config }));
  } catch (error) {
    showErrors([`Impossible d'enregistrer la configuration : ${String(error)}`]);
  }
}

// ---------------------------------------------------------------------------
// Mise à jour
// ---------------------------------------------------------------------------

/** Montre le bandeau « nouvelle version prête » (voir updater.rs). */
function showUpdate(version: string): void {
  el("update-version").textContent = version;
  el("update-banner").hidden = false;
}

/** Installe la nouvelle version : l'application se ferme puis se relance. */
async function installUpdate(): Promise<void> {
  const button = el("update-button") as HTMLButtonElement;
  button.disabled = true;
  button.textContent = "Installation…";
  try {
    await invoke("install_update");
  } catch (error) {
    button.disabled = false;
    button.textContent = "Redémarrer et mettre à jour";
    showErrors([`La mise à jour a échoué : ${String(error)}`]);
  }
}

/**
 * Range les boutons des fenêtres Dofus de la barre des tâches dans l'ordre de
 * la liste (voir `reorder_taskbar` dans game_windows.rs).
 */
async function onReorderTaskbar(): Promise<void> {
  const confirmation = el("reorder-confirmation");
  try {
    await invoke("reorder_taskbar");
    confirmation.textContent = "Rangé !";
  } catch (error) {
    confirmation.textContent = `Échec : ${String(error)}`;
  }
  setTimeout(() => (confirmation.textContent = ""), 2000);
}

/** Branche les boutons et cases de la page sur leurs actions. */
function bindControls(): void {
  el("copy-invites").addEventListener("click", handler(onCopyInvites));
  el("reorder-taskbar").addEventListener("click", handler(onReorderTaskbar));
  el("update-button").addEventListener("click", handler(installUpdate));
  el("help-button").addEventListener("click", toggleHelp);
  el("theme-button").addEventListener("click", toggleTheme);
  el("pause-button").addEventListener("click", () => fireAndForget(invoke("toggle_pause")));
  el("pip-button").addEventListener("click", handler(togglePip));
  el("minimize-button").addEventListener("click", handler(hideToTray));
  // Fermer la fenêtre principale quitte toute l'application (voir lib.rs).
  el("close-button").addEventListener("click", () => fireAndForget(getCurrentWindow().close()));

  const sidesCheckbox = el("distinguish-sides") as HTMLInputElement;
  sidesCheckbox.checked = config.advanced.distinguishSides;
  sidesCheckbox.addEventListener(
    "change",
    handler(async () => {
      config.advanced.distinguishSides = sidesCheckbox.checked;
      await save(); // Rust change de moteur (raccourcis Windows ou crochet)
    }),
  );

  const updateCheckbox = el("auto-update") as HTMLInputElement;
  updateCheckbox.checked = config.advanced.autoUpdate;
  updateCheckbox.addEventListener(
    "change",
    handler(async () => {
      config.advanced.autoUpdate = updateCheckbox.checked;
      await save(); // si activée, Rust cherche une nouvelle version aussitôt
    }),
  );

  const pipCheckbox = el("pip-on-minimize") as HTMLInputElement;
  pipCheckbox.checked = pipOnMinimize();
  pipCheckbox.addEventListener("change", () =>
    writePref("pip-on-minimize", pipCheckbox.checked ? "yes" : "no"),
  );
}

/** Écoute les événements envoyés par Rust. */
async function listenToRust(): Promise<void> {
  // La fenêtre au premier plan a changé : mise à jour de la fenêtre active.
  await listen("foreground-changed", () => {
    if (!document.hidden) fireAndForget(refresh());
  });
  // Une nouvelle version a été téléchargée en arrière-plan.
  await listen<string>("update-ready", (event) => showUpdate(event.payload));
  // Les raccourcis ont été coupés / réactivés (par le raccourci ou le bandeau).
  await listen<boolean>("shortcuts-paused-changed", (event) =>
    renderPauseButton(el("pause-button"), event.payload),
  );
  // La configuration a changé ailleurs (couronne donnée depuis le bandeau...) :
  // on la relit et on redessine, même si la fenêtre est cachée, pour ne
  // jamais garder une copie dépassée. On relit d'abord la configuration à
  // part : `refresh` peut s'abstenir, par exemple pendant une saisie.
  await listen(
    "config-changed",
    handler(async () => {
      config = await invoke<Config>("read_config");
      await refresh(true);
    }),
  );
}

/**
 * Point de départ : on applique les préférences, on lit la configuration, on
 * dessine tout, puis on relit les fenêtres régulièrement (seulement quand
 * l'application est visible).
 */
async function start(): Promise<void> {
  applyTheme();
  renderThemeButton();
  applyHelp();
  // La fenêtre prend la taille de son contenu, et la suit quand il change.
  fitWindowToContent(el("root"));

  // Sans configuration, rien ne peut s'afficher : on réessaie jusqu'à
  // l'obtenir (un échec ponctuel ne doit pas laisser la fenêtre vide).
  config = await retry(() => invoke<Config>("read_config"));
  renderShortcuts();
  // La disposition du clavier arrive plus tard (ou jamais) : on ne l'attend
  // pas, et on redessine les raccourcis quand elle est connue.
  fireAndForget(
    loadKeyboardLayout().then((known) => {
      if (!known) return;
      renderShortcuts();
      return refresh(true);
    }),
  );
  bindControls();
  watchVisibility();
  // Le rafraîchissement régulier démarre avant tout appel qui pourrait
  // échouer : si l'un d'eux échoue, la liste se remplira quand même.
  refreshWhileVisible(() => fireAndForget(refresh()), REFRESH_INTERVAL_MS);
  fireAndForget(refresh(true));
  fireAndForget(
    invoke<boolean>("is_paused").then((paused) => renderPauseButton(el("pause-button"), paused)),
  );
  await listenToRust();
  // La mise à jour a pu être prête avant qu'on écoute l'événement.
  const pending = await invoke<string | null>("pending_update");
  if (pending) showUpdate(pending);
}

reportUncaughtErrors();
window.addEventListener("DOMContentLoaded", handler(start));
