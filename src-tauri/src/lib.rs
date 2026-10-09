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
//! - `input`        : l'écoute du clavier, sur son propre thread.
//!
//! Légèreté : rien ne tourne en boucle côté Rust. Le programme ne se réveille
//! que pour un raccourci, un changement de premier plan ou une demande de
//! l'interface.

// `mod x;` dit au compilateur d'inclure le fichier `x.rs`.
mod clipboard;
mod combo;
mod config;
mod foreground;
mod game_windows;
mod input;
mod navigation;
mod shortcuts;

use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};

use config::Config;
use shortcuts::{Action, Control};

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
    config: Mutex<Config>,
    config_path: PathBuf,
    /// Ce qui décide quels raccourcis sont actifs (voir shortcuts.rs).
    control: Mutex<Control>,
}

/// Une fenêtre de jeu telle qu'on l'envoie à l'interface.
///
/// `Serialize` la convertit en objet JSON ; `rename_all = "camelCase"` écrit
/// les noms de champs à la façon JavaScript (`class_name` devient `className`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GameWindow {
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
fn collect_game_windows(state: &AppState) -> Vec<GameWindow> {
    let raw = game_windows::list();
    let foreground = game_windows::foreground();

    // Pour chaque fenêtre, on lit le titre et on choisit sa clé.
    let infos: Vec<_> = raw.iter().map(|w| navigation::parse_title(&w.title)).collect();
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
            toggle_pause_internal(app);
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
fn toggle_pause_internal(app: &AppHandle) -> bool {
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
/// dans l'organizer, Windows signale parfois une fenêtre interne du moteur
/// d'affichage (WebView2), qui appartient à un autre processus
/// (msedgewebview2.exe). On redemande donc la vraie fenêtre au premier plan.
pub(crate) fn on_foreground_changed(app: &AppHandle) {
    let allowed = game_windows::is_allowed_foreground(game_windows::foreground());
    app.state::<AppState>().control.lock().unwrap().foreground_allowed = allowed;
    shortcuts::sync(app, false);
    // L'interface met à jour la fenêtre active (si elle est visible).
    let _ = app.emit("foreground-changed", ());
}

// ---------------------------------------------------------------------------
// Les commandes appelables depuis l'interface.
// `#[tauri::command]` fabrique automatiquement le code qui reçoit l'appel
// JavaScript, convertit les arguments depuis le JSON et renvoie le résultat.
// Les paramètres `AppHandle` et `State<AppState>` sont fournis par Tauri : ce
// n'est pas l'interface qui les passe. Ces commandes s'exécutent sur le
// thread principal, comme le reste de la gestion des raccourcis.
// ---------------------------------------------------------------------------

/// Liste les fenêtres de jeu pour l'affichage.
#[tauri::command]
fn list_windows(state: State<AppState>) -> Vec<GameWindow> {
    collect_game_windows(&state)
}

/// Rend la configuration actuelle.
#[tauri::command]
fn read_config(state: State<AppState>) -> Config {
    state.config.lock().unwrap().clone()
}

/// Enregistre une nouvelle configuration et réapplique les raccourcis.
/// Rend la liste des raccourcis qui n'ont pas pu être enregistrés.
#[tauri::command]
fn save_config(app: AppHandle, state: State<AppState>, config: Config) -> Result<Vec<String>, String> {
    config.save(&state.config_path)?;
    *state.config.lock().unwrap() = config;
    Ok(shortcuts::sync(&app, true))
}

/// Donne la couronne à `character` (ou la retire avec `None`), depuis la
/// fenêtre principale ou le bandeau. Prévient ensuite les deux fenêtres
/// (`config-changed`) : chacune relit la configuration, et aucune ne risque
/// d'écraser ce choix avec une copie dépassée.
#[tauri::command]
fn set_leader(app: AppHandle, state: State<AppState>, character: Option<String>) -> Result<(), String> {
    {
        let mut config = state.config.lock().unwrap();
        config.leader = character;
        config.save(&state.config_path)?;
    } // le verrou est relâché ici, avant de prévenir l'interface
    let _ = app.emit("config-changed", ());
    Ok(())
}

/// Libère tous les raccourcis pendant que l'utilisateur en saisit un nouveau.
/// Sans ça, Windows intercepterait la combinaison avant qu'elle n'arrive dans
/// le champ de saisie si elle est déjà utilisée.
#[tauri::command]
fn suspend_shortcuts(app: AppHandle, state: State<AppState>) {
    state.control.lock().unwrap().capturing = true;
    shortcuts::sync(&app, false);
}

/// Réenregistre les raccourcis à la fin d'une saisie.
#[tauri::command]
fn resume_shortcuts(app: AppHandle, state: State<AppState>) -> Vec<String> {
    state.control.lock().unwrap().capturing = false;
    shortcuts::sync(&app, true)
}

/// Coupe ou réactive les raccourcis (boutons de l'interface).
#[tauri::command]
fn toggle_pause(app: AppHandle) -> bool {
    toggle_pause_internal(&app)
}

/// Vrai si les raccourcis sont coupés.
#[tauri::command]
fn is_paused(state: State<AppState>) -> bool {
    state.control.lock().unwrap().paused
}

/// Met une fenêtre de jeu au premier plan (clic sur un pseudo du bandeau).
#[tauri::command]
fn activate_window(id: isize) -> Result<(), String> {
    game_windows::activate(id)
}

/// Met un texte dans le presse-papiers (bouton des invitations de groupe).
#[tauri::command]
fn copy_text(app: AppHandle, text: String) -> Result<(), String> {
    // La fenêtre principale sert de « propriétaire » du contenu copié.
    let owner = app
        .get_webview_window("main")
        .and_then(|window| window.hwnd().ok())
        .map(|hwnd| hwnd.0 as isize)
        .ok_or("Fenêtre principale introuvable.")?;
    clipboard::copy_text(&text, owner)
}

/// Point d'entrée, appelé par main.rs.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // `setup` s'exécute une fois au démarrage, sur le thread principal.
        .setup(|app| {
            let config_path = app.path().app_config_dir()?.join("config.json");
            // `manage` confie l'état à Tauri, qui le fournira aux commandes.
            app.manage(AppState {
                config: Mutex::new(Config::load(&config_path)),
                config_path,
                control: Mutex::new(Control::default()),
            });
            // Le thread qui écoute le clavier (voir input.rs).
            input::start(app.handle().clone());
            // On part de la fenêtre actuellement au premier plan, puis on
            // demande à Windows de nous prévenir de chaque changement.
            on_foreground_changed(app.handle());
            foreground::watch(app.handle().clone());
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
            list_windows,
            read_config,
            save_config,
            set_leader,
            suspend_shortcuts,
            resume_shortcuts,
            toggle_pause,
            is_paused,
            activate_window,
            copy_text
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de l'application");
}
