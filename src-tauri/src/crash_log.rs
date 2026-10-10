//! Le journal des problèmes : quand quelque chose se passe mal, on l'écrit
//! dans un fichier, pour pouvoir comprendre après coup ce qui est arrivé.
//!
//! La version installée n'a pas de console : sans ce journal, un plantage ne
//! laisse aucune trace. Le fichier est
//! `%LOCALAPPDATA%\com.dofusteammanager.desktop\logs\crash.log`.
//!
//! On y écrit :
//! - les « paniques » : une erreur imprévue dans le code Rust (le programme
//!   s'arrête alors, ou seulement la tâche en cours) ;
//! - les erreurs qui ne méritent pas d'interrompre l'utilisateur (mise à
//!   jour impossible faute de réseau...).

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use windows::Win32::System::SystemInformation::GetLocalTime;

/// Au-delà de cette taille, l'ancien journal est mis de côté (`crash.old.log`)
/// et on repart d'un fichier vide : le journal ne grossit jamais sans fin.
const MAX_LOG_BYTES: u64 = 256 * 1024;

/// L'emplacement du journal, choisi une fois au démarrage.
static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Prépare le journal dans `folder` et y fait écrire toutes les paniques.
/// À appeler le plus tôt possible au démarrage.
pub fn install(folder: &Path) {
    let _ = fs::create_dir_all(folder);
    let _ = LOG_PATH.set(folder.join("crash.log"));

    // `set_hook` remplace ce que Rust fait quand une panique survient. On
    // garde le comportement d'origine (message dans la console, utile en
    // développement) et on ajoute l'écriture dans le journal.
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let place = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_default();
        // Le message d'une panique est un texte, de l'un de ces deux types.
        let message = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| (*s).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_default();
        write(&format!(
            "PANIQUE dans le thread « {} » ({place}) : {message}",
            thread.name().unwrap_or("sans nom")
        ));
        default_hook(info);
    }));
}

/// Ajoute une ligne datée au journal. N'échoue jamais : si le fichier ne
/// peut pas être écrit, tant pis, on ne va pas planter pour ça.
pub fn write(message: &str) {
    let Some(path) = LOG_PATH.get() else { return };
    if fs::metadata(path).is_ok_and(|m| m.len() > MAX_LOG_BYTES) {
        let _ = fs::rename(path, path.with_file_name("crash.old.log"));
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(
            file,
            "[{}] v{} — {message}",
            now(),
            env!("CARGO_PKG_VERSION")
        );
    }
}

/// La date et l'heure locales, par exemple « 2026-10-10 14:03:27 ».
fn now() -> String {
    // `GetLocalTime` ne peut pas échouer et ne bloque jamais.
    let t = unsafe { GetLocalTime() };
    format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond
    )
}
