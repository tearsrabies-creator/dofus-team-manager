//! Les commandes appelables depuis l'interface (TypeScript), avec
//! `invoke("nom_de_la_commande", { ...arguments })`.
//!
//! `#[tauri::command]` fabrique automatiquement le code qui reçoit l'appel
//! JavaScript, convertit les arguments depuis le JSON et renvoie le résultat.
//! Les paramètres `AppHandle` et `State<AppState>` sont fournis par Tauri : ce
//! n'est pas l'interface qui les passe. Ces commandes s'exécutent sur le
//! thread principal, comme le reste de la gestion des raccourcis.
//!
//! Elles restent volontairement courtes : elles traduisent l'appel puis
//! délèguent aux autres modules.

// Tauri impose de recevoir `AppHandle`, `State` et les arguments par valeur :
// l'avertissement de clippy (« argument passé par valeur mais pas consommé »)
// ne s'applique pas ici.
#![allow(clippy::needless_pass_by_value)]

use tauri::{AppHandle, Emitter, Manager, State};

use crate::config::Config;
use crate::{clipboard, game_windows, shortcuts, AppState, GameWindow};

/// Liste les fenêtres de jeu pour l'affichage.
#[tauri::command]
pub fn list_windows(state: State<AppState>) -> Vec<GameWindow> {
    crate::collect_game_windows(&state)
}

/// Rend la configuration actuelle.
#[tauri::command]
pub fn read_config(state: State<AppState>) -> Config {
    state.config.lock().unwrap().clone()
}

/// Enregistre une nouvelle configuration et réapplique les raccourcis.
/// Rend la liste des raccourcis qui n'ont pas pu être enregistrés.
#[tauri::command]
pub fn save_config(
    app: AppHandle,
    state: State<AppState>,
    config: Config,
) -> Result<Vec<String>, String> {
    config.save(&state.config_path)?;
    *state.config.lock().unwrap() = config;
    Ok(shortcuts::sync(&app, true))
}

/// Donne la couronne à `character` (ou la retire avec `None`), depuis la
/// fenêtre principale ou le bandeau. Prévient ensuite les deux fenêtres
/// (`config-changed`) : chacune relit la configuration, et aucune ne risque
/// d'écraser ce choix avec une copie dépassée.
#[tauri::command]
pub fn set_leader(
    app: AppHandle,
    state: State<AppState>,
    character: Option<String>,
) -> Result<(), String> {
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
pub fn suspend_shortcuts(app: AppHandle, state: State<AppState>) {
    state.control.lock().unwrap().capturing = true;
    shortcuts::sync(&app, false);
}

/// Réenregistre les raccourcis à la fin d'une saisie.
#[tauri::command]
pub fn resume_shortcuts(app: AppHandle, state: State<AppState>) -> Vec<String> {
    state.control.lock().unwrap().capturing = false;
    shortcuts::sync(&app, true)
}

/// Coupe ou réactive les raccourcis (boutons ⏸ / ▶ de l'interface).
#[tauri::command]
pub fn toggle_pause(app: AppHandle) -> bool {
    crate::toggle_pause(&app)
}

/// Vrai si les raccourcis sont coupés.
#[tauri::command]
pub fn is_paused(state: State<AppState>) -> bool {
    state.control.lock().unwrap().paused
}

/// Met une fenêtre de jeu au premier plan (clic sur un pseudo du bandeau).
#[tauri::command]
pub fn activate_window(id: isize) -> Result<(), String> {
    game_windows::activate(id)
}

/// Met un texte dans le presse-papiers (bouton des invitations de groupe).
#[tauri::command]
pub fn copy_text(app: AppHandle, text: String) -> Result<(), String> {
    // La fenêtre principale sert de « propriétaire » du contenu copié.
    let owner = app
        .get_webview_window("main")
        .and_then(|window| window.hwnd().ok())
        .map(|hwnd| hwnd.0 as isize)
        .ok_or("Fenêtre principale introuvable.")?;
    clipboard::copy_text(&text, owner)
}
