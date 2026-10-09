// Les champs de saisie des raccourcis clavier : on clique dedans, on appuie
// sur une combinaison, et elle est enregistrée. Utilisés par la fenêtre
// principale, dans la liste des personnages et dans la section Raccourcis.
//
// Le module ne connaît pas la configuration : on lui passe ce dont il a
// besoin (`ShortcutFieldContext`). Il reste ainsi indépendant du reste de la
// page, et facile à relire.

import { invoke } from "@tauri-apps/api/core";
import { fireAndForget, handler, iconButton } from "./common";

/** Ce dont un champ de raccourci a besoin de la page qui l'utilise. */
export interface ShortcutFieldContext {
  /** Vrai si l'option « distinguer gauche et droite » est cochée. */
  distinguishSides(): boolean;
  /** Enregistre la configuration, après une modification. */
  save(): Promise<void>;
  /** Affiche les problèmes signalés par Rust (raccourci déjà pris...). */
  showErrors(errors: string[]): void;
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
 * Fabrique un champ de saisie de raccourci et son bouton « effacer ».
 * `read` donne la valeur actuelle, `write` la modifie : le même code sert
 * ainsi pour tous les raccourcis, où qu'ils soient rangés.
 */
export function shortcutField(
  label: string,
  read: () => string,
  write: (value: string) => void,
  context: ShortcutFieldContext,
): [HTMLInputElement, HTMLButtonElement] {
  const field = document.createElement("input");
  field.className = "shortcut";
  field.readOnly = true; // on ne tape pas dedans, on « capture » les touches
  field.placeholder = "Raccourci";
  field.title = label;
  field.setAttribute("aria-label", label);
  field.value = readable(read());
  enableCapture(field, read, write, context);

  const clear = iconButton(
    "✕",
    `Effacer « ${label} »`,
    handler(async () => {
      write("");
      field.value = "";
      await context.save();
    }),
  );
  return [field, clear];
}

/**
 * Transforme un champ en zone de capture : quand il a le focus, la prochaine
 * combinaison de touches devient le raccourci.
 */
function enableCapture(
  field: HTMLInputElement,
  read: () => string,
  write: (value: string) => void,
  context: ShortcutFieldContext,
): void {
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
    fireAndForget(invoke("suspend_shortcuts"));
  });
  field.addEventListener(
    "blur",
    handler(async () => {
      field.value = readable(read());
      context.showErrors(await invoke<string[]>("resume_shortcuts"));
    }),
  );
  field.addEventListener("keyup", (e) => held.delete(e.code));

  field.addEventListener(
    "keydown",
    handler(async (e: KeyboardEvent) => {
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

      write(
        buildShortcut({
          code: e.code,
          held,
          browserFlags: [e.ctrlKey, e.altKey, e.shiftKey, e.metaKey],
          altGraph,
          distinguishSides: context.distinguishSides(),
        }),
      );
      // On enregistre d'abord (Rust écrit le fichier et applique les nouveaux
      // raccourcis), puis on quitte le champ : `blur` réaffiche la valeur.
      await context.save();
      field.blur();
    }),
  );
}

/** Ce qu'on sait du clavier au moment où la touche principale est pressée. */
interface KeyPress {
  /** La touche principale (`KeyboardEvent.code`, par exemple « KeyP »). */
  code: string;
  /** Les modificateurs enfoncés, avec leur côté. */
  held: ReadonlySet<string>;
  /** Ctrl, Alt, Maj, Win d'après le navigateur (sans les côtés). */
  browserFlags: [boolean, boolean, boolean, boolean];
  /** Vrai si Alt droit a été pressé en tant qu'AltGr. */
  altGraph: boolean;
  distinguishSides: boolean;
}

/**
 * Écrit la combinaison dans le format compris par la partie Rust :
 * « Control+Alt+KeyP », ou avec les côtés « ControlLeft+AltRight+KeyP ».
 * Fonction pure : elle ne dépend que de ce qu'on lui donne.
 */
function buildShortcut(press: KeyPress): string {
  const parts: string[] = [];
  MODIFIER_FAMILIES.forEach(([generic, left, right], i) => {
    const leftDown = press.held.has(left);
    const rightDown = press.held.has(right);
    // Le faux Ctrl gauche d'AltGr ne compte pas (sauf avec les côtés
    // désactivés, où Windows traite de toute façon AltGr comme Ctrl + Alt).
    if (generic === "Control" && press.altGraph && press.distinguishSides && !rightDown) return;
    // L'indication du navigateur sert si le modificateur était déjà enfoncé
    // avant de cliquer dans le champ.
    if (!leftDown && !rightDown && !press.browserFlags[i]) return;
    if (press.distinguishSides && leftDown !== rightDown) parts.push(leftDown ? left : right);
    else parts.push(generic);
  });
  parts.push(press.code);
  return parts.join("+");
}

// ---------------------------------------------------------------------------
// Affichage lisible d'un raccourci
// ---------------------------------------------------------------------------

/**
 * La partie de l'API « Keyboard » du navigateur dont on se sert. Elle est
 * récente et pas encore décrite dans les types de TypeScript : on la décrit
 * ici nous-mêmes plutôt que d'utiliser `any`, qui désactiverait toute
 * vérification.
 */
interface NavigatorWithKeyboard {
  keyboard?: { getLayoutMap(): Promise<Map<string, string>> };
}

// Ce que porte chaque touche sur le clavier de l'utilisateur (AZERTY,
// QWERTY...), fourni par le navigateur intégré : `KeyQ` → « a » en AZERTY.
let keyboardLayout: Map<string, string> | null = null;

// Au-delà de ce délai, on renonce à connaître la disposition du clavier.
const LAYOUT_TIMEOUT_MS = 1000;

/**
 * Charge la disposition du clavier. À appeler une fois, au démarrage, SANS
 * attendre la réponse pour continuer : selon le contexte, le navigateur peut
 * ne jamais répondre. On abandonne donc au bout d'une seconde, et en
 * attendant, les touches s'affichent comme sur un clavier AZERTY. Rend `true` si la disposition est
 * connue (il faut alors redessiner les raccourcis).
 */
export async function loadKeyboardLayout(): Promise<boolean> {
  const keyboard = (navigator as NavigatorWithKeyboard).keyboard;
  if (!keyboard) return false;
  // `Promise.race` : la première des deux promesses à se terminer l'emporte.
  const timeout = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), LAYOUT_TIMEOUT_MS),
  );
  try {
    keyboardLayout = await Promise.race([keyboard.getLayoutMap(), timeout]);
  } catch {
    keyboardLayout = null; // on suppose alors un clavier AZERTY
  }
  return keyboardLayout !== null;
}

const KEY_NAMES: Record<string, string> = {
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

/**
 * Ce que porte chaque touche sur un clavier AZERTY français, quand cela
 * diffère du nom QWERTY de sa position. Sert quand le navigateur ne donne
 * pas la disposition réelle du clavier : on suppose alors un AZERTY.
 */
const AZERTY_LABELS: Record<string, string> = {
  KeyQ: "A",
  KeyW: "Z",
  KeyA: "Q",
  KeyZ: "W",
  Semicolon: "M",
  KeyM: ",",
  Comma: ";",
  Period: ":",
  Slash: "!",
  Backquote: "²",
  Minus: ")",
  Equal: "=",
  BracketLeft: "^",
  BracketRight: "$",
  Quote: "Ù",
  Backslash: "*",
  IntlBackslash: "<",
};

/** « ControlLeft+Shift+KeyQ » devient « Ctrl G + Maj + A » (en AZERTY). */
export function readable(shortcut: string): string {
  if (!shortcut) return "";
  return shortcut
    .split("+")
    .map((code) => {
      if (KEY_NAMES[code]) return KEY_NAMES[code];
      if (code.startsWith("Digit")) return code.slice(5); // chiffre de la rangée du haut
      if (code.startsWith("Numpad")) return "Pavé " + code.slice(6);
      // Sinon : ce qui est écrit sur la touche, selon la disposition du
      // clavier ; si elle est inconnue, comme sur un clavier AZERTY.
      const label = keyboardLayout?.get(code) ?? AZERTY_LABELS[code];
      return label ? label.toUpperCase() : code.replace(/^Key/, "");
    })
    .join(" + ");
}
