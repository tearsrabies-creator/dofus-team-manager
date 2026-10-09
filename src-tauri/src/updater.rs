//! La mise à jour automatique, avec le plugin officiel `tauri-plugin-updater`.
//!
//! 1. Au lancement, on demande à GitHub le fichier `latest.json` de la
//!    dernière version publiée (adresse dans tauri.conf.json).
//! 2. S'il annonce une version plus récente, on la télécharge en arrière-plan.
//!    Le plugin vérifie sa signature avec la clé publique de tauri.conf.json :
//!    seule une version signée avec notre clé privée peut être installée.
//! 3. On prévient l'interface (événement `update-ready`), qui propose de
//!    redémarrer. On n'installe jamais sans l'accord de l'utilisateur :
//!    l'installation ferme l'application, ce qui serait gênant en pleine partie.
//!
//! En développement (`npm run tauri dev`), rien n'est vérifié.

use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Une mise à jour téléchargée et vérifiée, prête à être installée.
struct ReadyUpdate {
    update: Update,
    bytes: Vec<u8>,
}

/// La mise à jour en attente, s'il y en a une. Confiée à Tauri avec `manage`.
#[derive(Default)]
pub struct PendingUpdate(Mutex<Option<ReadyUpdate>>);

/// Lance la vérification en arrière-plan, sans bloquer le démarrage.
pub fn check_in_background(app: &AppHandle) {
    // `cfg!(debug_assertions)` est vrai en développement, faux dans la
    // version installée.
    if cfg!(debug_assertions) {
        return;
    }
    let app = app.clone();
    // `async_runtime::spawn` exécute la tâche sur un autre thread : le
    // téléchargement ne ralentit ni l'interface ni le clavier.
    tauri::async_runtime::spawn(async move {
        // Sans réseau ou sans nouvelle version, on ne dit rien : on
        // réessaiera au prochain lancement.
        if let Err(error) = check_and_download(&app).await {
            eprintln!("Mise à jour : {error}");
        }
    });
}

/// Vérifie, télécharge et met de côté la nouvelle version s'il y en a une.
async fn check_and_download(app: &AppHandle) -> tauri_plugin_updater::Result<()> {
    let Some(update) = app.updater()?.check().await? else {
        return Ok(()); // déjà à jour
    };
    // Les deux fonctions vides : on pourrait y suivre l'avancement du
    // téléchargement, inutile ici.
    let bytes = update.download(|_, _| {}, || {}).await?;
    let version = update.version.clone();
    *app.state::<PendingUpdate>().0.lock().unwrap() = Some(ReadyUpdate { update, bytes });
    let _ = app.emit("update-ready", version);
    Ok(())
}

/// Le numéro de la version prête à être installée, s'il y en a une.
pub fn ready_version(app: &AppHandle) -> Option<String> {
    app.state::<PendingUpdate>()
        .0
        .lock()
        .unwrap()
        .as_ref()
        .map(|ready| ready.update.version.clone())
}

/// Installe la version téléchargée. Sous Windows, l'installateur se lance,
/// l'application se ferme, puis elle est relancée une fois la mise à jour
/// installée.
pub fn install(app: &AppHandle) -> Result<(), String> {
    let ready = app
        .state::<PendingUpdate>()
        .0
        .lock()
        .unwrap()
        .take()
        .ok_or("Aucune mise à jour prête.")?;
    ready
        .update
        .install(&ready.bytes)
        .map_err(|e| e.to_string())
}
