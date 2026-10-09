//! Le cœur de l'application : il relie les modules entre eux et expose les
//! « commandes », c'est-à-dire les fonctions Rust que l'interface (TypeScript)
//! peut appeler avec `invoke("nom_de_la_commande", { ...arguments })`.
//!
//! Organisation du code Rust :
//! - `game_windows` : appels à Windows (lister, mettre au premier plan) ;
//! - `foreground`   : être prévenu quand la fenêtre au premier plan change ;
//! - `navigation`   : logique pure et testée (titre, ordre, suivante...) ;
//! - `config`       : lecture et écriture du fichier de configuration ;
//! - `shortcuts`    : quels raccourcis existent et lesquels sont actifs ;
//! - `combo`        : lire une combinaison de touches, logique pure et testée ;
//! - `input`        : l'écoute du clavier, sur son propre thread ;
//! - `clipboard`    : écrire dans le presse-papiers ;
//! - `commands`     : les commandes appelables par l'interface ;
//! - `updater`      : la mise à jour automatique.
//!
//! Légèreté : rien ne tourne en boucle côté Rust. Le programme ne se réveille
//! que pour un raccourci, un changement de premier plan ou une demande de
//! l'interface.

// `mod x;` dit au compilateur d'inclure le fichier `x.rs`.
mod clipboard;
mod combo;
mod commands;
mod config;
mod foreground;
mod game_windows;
mod input;
mod navigation;
mod shortcuts;
mod updater;

use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WindowEvent};

use config::Config;
use shortcuts::{Action, Control};

/// L'identifiant de l'application avant son changement de nom (version
/// 0.1.0, « Dofus Organizer ») : c'est aussi le nom de son ancien dossier de
/// configuration.
const PREVIOUS_IDENTIFIER: &str = "com.dofusorganizer.desktop";

/// L'état partagé de l'application, accessible depuis toutes les commandes.
///
/// Plusieurs morceaux du programme peuvent vouloir lire ou modifier ces
/// données. Un `Mutex` (« exclusion mutuelle ») protège une donnée : pour la
/// lire ou la modifier, il faut d'abord la verrouiller avec `.lock()`, et une
/// seule partie du programme peut la tenir à la fois. Le verrou est relâché
/// automatiquement à la fin du bloc où il a été pris.
/// (`.unwrap()` après `.lock()` arrête le programme si une autre partie a
/// planté en tenant le verrou : ça ne devrait jamais arriver.)
pub struct AppState {
    pub(crate) config: Mutex<Config>,
    pub(crate) config_path: PathBuf,
    /// Ce qui décide quels raccourcis sont actifs (voir shortcuts.rs).
    pub(crate) control: Mutex<Control>,
}

/// Une fenêtre de jeu telle qu'on l'envoie à l'interface.
///
/// `Serialize` la convertit en objet JSON ; `rename_all = "camelCase"` écrit
/// les noms de champs à la façon JavaScript (`class_name` devient `className`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GameWindow {
    /// Identifiant Windows, pour l'activer depuis l'interface.
    id: isize,
    /// La clé qui sert dans la configuration : le nom du personnage, ou un
    /// identifiant provisoire si la fenêtre n'est pas encore connectée.
    key: String,
    character: Option<String>,
    class_name: Option<String>,
    title: String,
    selected: bool,
    /// Vrai si c'est la fenêtre au premier plan.
    active: bool,
    /// Vrai si ce personnage porte la couronne (le chef de groupe).
    leader: bool,
    /// Sa position dans la liste de navigation (1, 2, 3...) si elle est cochée.
    number: Option<usize>,
}

/// Rassemble les fenêtres Dofus ouvertes, triées dans l'ordre choisi, avec
/// leur état (cochée, active, chef, numéro). Ajoute au passage les nouveaux
/// personnages à la configuration (et l'enregistre si elle a changé).
pub(crate) fn collect_game_windows(state: &AppState) -> Vec<GameWindow> {
    let raw = game_windows::list();
    let foreground = game_windows::foreground();

    // Pour chaque fenêtre, on lit le titre et on choisit sa clé.
    let infos: Vec<_> = raw
        .iter()
        .map(|w| navigation::parse_title(&w.title))
        .collect();
    let keys: Vec<String> = raw
        .iter()
        .zip(&infos) // `zip` avance dans deux listes en même temps
        .map(|(w, info)| match &info.character {
            Some(name) => name.clone(),
            None => format!("window-{}", w.id),
        })
        .collect();

    let mut config = state.config.lock().unwrap();
    // On n'enregistre que les vrais personnages, pas les fenêtres non connectées.
    let characters: Vec<String> = infos.iter().filter_map(|i| i.character.clone()).collect();
    if config.add_new_characters(&characters) {
        let _ = config.save(&state.config_path);
    }

    let mut number = 0;
    navigation::sort_by_order(&keys, &config.order)
        .into_iter()
        .map(|i| {
            let selected = config.selection.contains(&keys[i]);
            if selected {
                number += 1;
            }
            GameWindow {
                id: raw[i].id,
                key: keys[i].clone(),
                character: infos[i].character.clone(),
                class_name: infos[i].class_name.clone(),
                title: raw[i].title.clone(),
                selected,
                active: raw[i].id == foreground,
                // Vrai seulement s'il y a un personnage ET que c'est le chef
                // (une fenêtre non connectée n'est jamais chef).
                leader: infos[i].character.is_some() && infos[i].character == config.leader,
                number: selected.then_some(number),
            }
        })
        .collect()
}

/// Exécute l'action d'un raccourci.
pub(crate) fn run_action(app: &AppHandle, action: Action) {
    let state = app.state::<AppState>();

    // On cherche l'identifiant de la fenêtre à afficher.
    let target = match action {
        Action::TogglePause => {
            toggle_pause(app);
            return;
        }
        Action::Cycle(direction) => {
            let all = collect_game_windows(&state);
            // La liste de navigation : seulement les fenêtres cochées, dans l'ordre.
            let list: Vec<&GameWindow> = all.iter().filter(|w| w.selected).collect();
            let current = list.iter().position(|w| w.active);
            navigation::target(direction, list.len(), current).map(|i| list[i].id)
        }
        Action::Character(name) => {
            // On range la liste dans une variable : une valeur « temporaire »
            // serait détruite trop tôt, pendant qu'on la parcourt encore.
            let all = collect_game_windows(&state);
            // `find` rend la première fenêtre qui correspond, ou `None`
            // (personnage pas connecté en ce moment : on ne fait rien).
            all.iter()
                .find(|w| w.character.as_ref() == Some(&name))
                .map(|w| w.id)
        }
    };

    if let Some(id) = target {
        let _ = game_windows::activate(id);
    }
}

/// Coupe ou réactive les raccourcis, et prévient l'interface (les deux
/// fenêtres) du nouvel état. Rend `true` si les raccourcis sont coupés.
pub(crate) fn toggle_pause(app: &AppHandle) -> bool {
    // La « poignée » vers l'état doit vivre aussi longtemps que le verrou pris
    // dessus : on la range dans une variable (sinon, erreur E0716).
    let state = app.state::<AppState>();
    let paused = {
        let mut control = state.control.lock().unwrap();
        control.paused = !control.paused;
        control.paused
    };
    shortcuts::sync(app, false);
    let _ = app.emit("shortcuts-paused-changed", paused);
    paused
}

/// Appelée (par foreground.rs) à chaque changement de premier plan.
///
/// On ne se fie pas à la fenêtre transmise par l'événement : quand on clique
/// dans l'application, Windows signale parfois une fenêtre interne du moteur
/// d'affichage (`WebView2`), qui appartient à un autre processus
/// (`msedgewebview2.exe`). On redemande donc la vraie fenêtre au premier plan.
pub(crate) fn on_foreground_changed(app: &AppHandle) {
    let allowed = game_windows::is_allowed_foreground(game_windows::foreground());
    app.state::<AppState>()
        .control
        .lock()
        .unwrap()
        .foreground_allowed = allowed;
    shortcuts::sync(app, false);
    // L'interface met à jour la fenêtre active (si elle est visible).
    let _ = app.emit("foreground-changed", ());
}

/// Point d'entrée, appelé par main.rs.
///
/// # Panics
///
/// S'arrête avec un message si Tauri ne peut pas démarrer (par exemple si le
/// composant `WebView2` de Windows est absent) : sans lui, rien n'est possible.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Le plugin officiel de mise à jour (voir updater.rs).
        .plugin(tauri_plugin_updater::Builder::new().build())
        // `setup` s'exécute une fois au démarrage, sur le thread principal.
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            let config_path = config_dir.join("config.json");
            // L'application s'appelait « Dofus Organizer » jusqu'à la 0.1.0 :
            // on reprend sa configuration si elle existe (voir config.rs).
            let previous_path = config_dir
                .with_file_name(PREVIOUS_IDENTIFIER)
                .join("config.json");
            // `manage` confie l'état à Tauri, qui le fournira aux commandes.
            app.manage(AppState {
                config: Mutex::new(Config::load_or_migrate(&config_path, &previous_path)),
                config_path,
                control: Mutex::new(Control::default()),
            });
            app.manage(updater::PendingUpdate::default());
            // Le thread qui écoute le clavier (voir input.rs).
            input::start(app.handle().clone());
            // On part de la fenêtre actuellement au premier plan, puis on
            // demande à Windows de nous prévenir de chaque changement.
            on_foreground_changed(app.handle());
            foreground::watch(app.handle().clone());
            // Cherche une nouvelle version en arrière-plan (version installée seulement).
            updater::check_in_background(app.handle());
            Ok(())
        })
        // Fermer la fenêtre principale (croix de l'en-tête, Alt+F4...) quitte
        // l'application, bandeau compris : sinon le bandeau caché garderait
        // le programme en vie sans aucune fenêtre visible.
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, WindowEvent::Destroyed) {
                window.app_handle().exit(0);
            }
        })
        // La liste des commandes que l'interface a le droit d'appeler.
        .invoke_handler(tauri::generate_handler![
            commands::list_windows,
            commands::read_config,
            commands::save_config,
            commands::set_leader,
            commands::suspend_shortcuts,
            commands::resume_shortcuts,
            commands::toggle_pause,
            commands::is_paused,
            commands::activate_window,
            commands::copy_text,
            commands::pending_update,
            commands::install_update
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de l'application");
}
