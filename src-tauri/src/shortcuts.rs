//! Les raccourcis clavier : quelles actions existent, et lesquelles doivent
//! être actives en ce moment.
//!
//! Un raccourci actif « réserve » sa combinaison : les autres programmes ne
//! la reçoivent plus. C'est pourquoi on ne garde nos raccourcis actifs QUE
//! lorsque Dofus ou l'application est au premier plan : partout ailleurs
//! (navigateur, Discord...), les touches retrouvent leur effet normal.
//!
//! L'écoute du clavier elle-même est faite par `input.rs`.

use tauri::{AppHandle, Manager};

use crate::combo::Combo;
use crate::config::Shortcuts;
use crate::input::{self, Backend, Binding};
use crate::navigation::Direction;
use crate::AppState;

/// Ce que déclenche un raccourci.
///
/// Une variante d'`enum` peut porter des données : `Character` contient le
/// nom du personnage à afficher. Comme un `String` ne se copie pas
/// gratuitement, l'enum n'est que `Clone` (copie explicite avec `.clone()`),
/// pas `Copy` (copie implicite, réservée aux petites valeurs).
#[derive(Debug, Clone)]
pub enum Action {
    /// Fenêtre suivante ou précédente parmi les fenêtres cochées.
    Cycle(Direction),
    /// Afficher la fenêtre de ce personnage, cochée ou non.
    Character(String),
    /// Couper ou réactiver les autres raccourcis.
    TogglePause,
}

/// Quels raccourcis doivent être actifs en ce moment.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Mode {
    /// Aucun : ni Dofus ni l'application au premier plan, ou saisie en cours.
    Off,
    /// Seulement l'interrupteur : les autres raccourcis sont coupés.
    ToggleOnly,
    /// Tous les raccourcis.
    All,
}

/// L'état qui décide du `Mode`. Rangé dans `AppState` derrière un `Mutex`.
#[derive(Debug, Default)]
pub struct Control {
    /// Vrai pendant que l'utilisateur saisit un raccourci dans l'interface.
    pub capturing: bool,
    /// Vrai quand l'utilisateur a coupé les raccourcis avec l'interrupteur.
    pub paused: bool,
    /// Vrai quand Dofus ou l'application est au premier plan.
    pub foreground_allowed: bool,
    /// Le mode actuellement appliqué (`None` au démarrage).
    pub applied: Option<Mode>,
}

impl Control {
    /// La règle, en une fonction pure (donc facile à tester).
    pub fn desired_mode(&self) -> Mode {
        if self.capturing || !self.foreground_allowed {
            Mode::Off
        } else if self.paused {
            Mode::ToggleOnly
        } else {
            Mode::All
        }
    }
}

/// Met les raccourcis actifs en accord avec l'état actuel.
///
/// Ne fait rien si le bon mode est déjà appliqué, sauf si `force` est vrai
/// (après une modification des raccourcis par exemple). Rend la liste des
/// problèmes rencontrés, pour les afficher dans l'interface.
pub fn sync(app: &AppHandle, force: bool) -> Vec<String> {
    let state = app.state::<AppState>();
    let mut control = crate::lock(&state.control);
    let mode = control.desired_mode();
    if !force && control.applied == Some(mode) {
        return Vec::new();
    }
    control.applied = Some(mode);

    // On ne garde le verrou de la configuration que le temps de la lire : il
    // est relâché à la fin de ce bloc, avant de parler au thread clavier.
    let (bindings, mut errors, distinguish_sides) = {
        let config = crate::lock(&state.config);
        let (bindings, errors) = build_bindings(&config.shortcuts, mode);
        (bindings, errors, config.advanced.distinguish_sides)
    };
    let backend = match mode {
        Mode::Off => Backend::Off,
        _ if distinguish_sides => Backend::Hook,
        _ => Backend::Hotkeys,
    };
    // Une combinaison qui précise un côté (Ctrl gauche...) alors que l'option
    // est décochée marche quand même, mais pour les deux côtés : on prévient.
    if backend == Backend::Hotkeys {
        for binding in bindings.iter().filter(|b| b.combo.has_sides()) {
            errors.push(format!(
                "{} : le côté (gauche / droite) est ignoré tant que l'option avancée n'est pas cochée.",
                binding.label
            ));
        }
    }
    errors.extend(input::apply(bindings, backend));
    errors
}

/// Transforme les raccourcis de la configuration en `Binding` prêts à
/// l'emploi, en ne gardant que ceux qu'autorise `mode`. Les textes mal
/// écrits sont signalés dans la liste d'erreurs.
fn build_bindings(shortcuts: &Shortcuts, mode: Mode) -> (Vec<Binding>, Vec<String>) {
    // La liste (texte du raccourci, action, nom affiché en cas d'erreur).
    let mut requests: Vec<(String, Action, String)> = Vec::new();
    if mode != Mode::Off {
        requests.push((
            shortcuts.toggle.clone(),
            Action::TogglePause,
            "Interrupteur".into(),
        ));
    }
    if mode == Mode::All {
        requests.push((
            shortcuts.next.clone(),
            Action::Cycle(Direction::Next),
            "Fenêtre suivante".into(),
        ));
        requests.push((
            shortcuts.previous.clone(),
            Action::Cycle(Direction::Previous),
            "Fenêtre précédente".into(),
        ));
        // Parcourir un dictionnaire donne des paires (clé, valeur).
        for (character, text) in &shortcuts.characters {
            requests.push((
                text.clone(),
                Action::Character(character.clone()),
                character.clone(),
            ));
        }
    }

    let mut bindings = Vec::new();
    let mut errors = Vec::new();
    for (text, action, label) in requests {
        if text.trim().is_empty() {
            continue; // pas de raccourci pour cette action
        }
        match Combo::parse(&text) {
            Ok(combo) => bindings.push(Binding {
                combo,
                action,
                label,
            }),
            Err(message) => errors.push(format!("{label} : {message}")),
        }
    }
    (bindings, errors)
}

#[cfg(test)]
mod tests {
    use super::*;

    // `..Default::default()` : les champs non cités prennent leur valeur par
    // défaut (ici `false` et `None`).
    #[test]
    fn nothing_outside_dofus_and_app() {
        let control = Control {
            foreground_allowed: false,
            ..Default::default()
        };
        assert_eq!(control.desired_mode(), Mode::Off);
    }

    #[test]
    fn nothing_while_capturing() {
        let control = Control {
            foreground_allowed: true,
            capturing: true,
            ..Default::default()
        };
        assert_eq!(control.desired_mode(), Mode::Off);
    }

    #[test]
    fn only_toggle_when_paused() {
        let control = Control {
            foreground_allowed: true,
            paused: true,
            ..Default::default()
        };
        assert_eq!(control.desired_mode(), Mode::ToggleOnly);
    }

    #[test]
    fn everything_otherwise() {
        let control = Control {
            foreground_allowed: true,
            ..Default::default()
        };
        assert_eq!(control.desired_mode(), Mode::All);
    }

    #[test]
    fn paused_keeps_only_the_toggle() {
        let shortcuts = Shortcuts {
            toggle: "Control+KeyP".into(),
            ..Default::default()
        };
        let (bindings, errors) = build_bindings(&shortcuts, Mode::ToggleOnly);
        assert_eq!(errors, Vec::<String>::new());
        assert_eq!(bindings.len(), 1);
        assert!(matches!(bindings[0].action, Action::TogglePause));
    }

    #[test]
    fn bad_text_is_reported() {
        let shortcuts = Shortcuts {
            next: "Control+Banane".into(),
            ..Default::default()
        };
        let (_, errors) = build_bindings(&shortcuts, Mode::All);
        assert_eq!(errors.len(), 1);
    }
}
