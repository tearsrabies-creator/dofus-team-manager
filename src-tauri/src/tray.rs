//! L'icône dans la zone de notification de Windows (à droite de la barre des
//! tâches, près de l'horloge, du volume et de la langue du clavier).
//!
//! Quand on masque l'application (bouton —), sa fenêtre disparaît, y compris
//! de la barre des tâches : seule cette icône reste. Un clic gauche la fait
//! revenir ; un clic droit ouvre un petit menu.
//!
//! Windows range les nouvelles icônes dans le menu « ^ » des icônes cachées :
//! pour qu'elle reste toujours visible près de l'horloge, il faut la faire
//! glisser une fois de ce menu vers la barre des tâches (ou l'activer dans
//! Paramètres > Personnalisation > Barre des tâches).

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{App, AppHandle, Manager};

/// Crée l'icône et son menu. À appeler une fois, au démarrage.
pub fn create(app: &App) -> tauri::Result<()> {
    // Les entrées du menu (clic droit). L'identifiant (« show »...) permet
    // de savoir laquelle a été choisie.
    let show = MenuItem::with_id(
        app,
        "show",
        "Afficher Dofus Team Manager",
        true,
        None::<&str>,
    )?;
    let pip = MenuItem::with_id(
        app,
        "pip",
        "Afficher / cacher le bandeau",
        true,
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &pip, &quit])?;

    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Dofus Team Manager")
        .menu(&menu)
        // Le menu s'ouvre au clic droit ; le clic gauche affiche la fenêtre.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "pip" => toggle_pip(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // On réagit au relâchement du bouton gauche (un clic complet).
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    // L'icône de l'application (celle de l'exécutable), si elle est connue.
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// Affiche la fenêtre principale et la met au premier plan.
pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Affiche le bandeau s'il est caché, le cache sinon.
fn toggle_pip(app: &AppHandle) {
    if let Some(pip) = app.get_webview_window("pip") {
        if pip.is_visible().unwrap_or(false) {
            let _ = pip.hide();
        } else {
            let _ = pip.show();
        }
    }
}
