//! Être prévenu quand la fenêtre au premier plan change.
//!
//! Plutôt que de demander « quelle fenêtre est devant ? » en boucle (ce qui
//! consommerait un peu de processeur en permanence), on demande à Windows de
//! nous appeler à chaque changement, avec `SetWinEventHook`. Entre deux
//! changements, l'application ne fait strictement rien.
//!
//! Le mode « hors contexte » (`WINEVENT_OUTOFCONTEXT`) est le plus sûr : rien
//! n'est injecté dans les autres programmes, Windows nous envoie simplement
//! un message. Il arrive sur le thread qui a installé la surveillance (le
//! thread principal), via sa boucle de messages. Si l'application s'arrête ou
//! plante, Windows retire la surveillance tout seul.

use std::sync::OnceLock;
use tauri::AppHandle;
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
use windows::Win32::UI::WindowsAndMessaging::{EVENT_SYSTEM_FOREGROUND, WINEVENT_OUTOFCONTEXT};

/// La fonction appelée par Windows ne peut pas recevoir de paramètre à nous :
/// on range donc la « poignée » de l'application dans une variable globale.
/// `OnceLock` est une case qu'on ne peut remplir qu'une seule fois, puis lire
/// sans risque depuis n'importe où.
static APP: OnceLock<AppHandle> = OnceLock::new();

/// Démarre la surveillance. À appeler une fois, depuis le thread principal.
pub fn watch(app: AppHandle) {
    let _ = APP.set(app);
    unsafe {
        // Événements surveillés : de EVENT_SYSTEM_FOREGROUND à lui-même,
        // donc uniquement les changements de premier plan, pour tous les
        // processus (0) et tous les threads (0).
        SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            None,
            Some(on_foreground),
            0,
            0,
            WINEVENT_OUTOFCONTEXT,
        );
    }
}

/// Appelée par Windows à chaque changement de premier plan.
/// La signature (les paramètres) est imposée par Windows ; on n'en utilise
/// aucun (voir `on_foreground_changed` dans lib.rs). Les paramètres
/// inutilisés commencent par `_` pour que le compilateur ne s'en plaigne pas.
unsafe extern "system" fn on_foreground(
    _hook: HWINEVENTHOOK,
    _event: u32,
    _hwnd: HWND,
    _id_object: i32,
    _id_child: i32,
    _thread: u32,
    _time: u32,
) {
    // Une « panique » (erreur imprévue) ne doit jamais sortir d'une fonction
    // appelée par Windows : Rust tuerait alors tout le programme, sans
    // message. `catch_unwind` l'arrête ici ; elle est déjà notée dans le
    // journal (crash_log.rs) et le programme continue.
    // `AssertUnwindSafe` : on garantit au compilateur que c'est sans danger
    // ici (l'état partagé reste utilisable, voir `lock` dans lib.rs).
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if let Some(app) = APP.get() {
            crate::on_foreground_changed(app);
        }
    }));
}
