//! Tout ce qui parle directement à Windows au sujet des fenêtres : trouver
//! les fenêtres Dofus et en mettre une au premier plan.
//!
//! On utilise l'API Win32, la bibliothèque de fonctions fournie par Windows
//! (écrite à l'origine pour le langage C). Quelques notions utiles :
//!
//! - Un `HWND` (« handle of window ») est un numéro qui identifie une fenêtre.
//!   On le convertit en simple entier (`isize`) pour pouvoir le stocker et
//!   l'envoyer à l'interface. Ce n'est qu'un numéro : le garder ne « bloque »
//!   rien et n'a pas besoin d'être libéré.
//! - Les fonctions Win32 sont marquées `unsafe` en Rust : le compilateur ne
//!   peut pas vérifier ce qu'elles font en mémoire, c'est à nous de les
//!   appeler correctement. On regroupe donc ces appels dans de petits blocs
//!   `unsafe { ... }` bien délimités, et le reste du programme n'utilise que
//!   les fonctions « sûres » de ce fichier.
//! - Windows manipule les textes en UTF-16 (des `u16`), alors que Rust utilise
//!   l'UTF-8 : on convertit avec `String::from_utf16_lossy`.
//!
//! Pour ne jamais gêner le jeu :
//! - aucune fonction utilisée ici n'attend de réponse de la fenêtre Dofus :
//!   même si le jeu est figé, l'organizer ne reste pas bloqué ;
//! - le seul objet ouvert (le processus, pour lire son nom) est refermé
//!   aussitôt ; si l'organizer plante, il ne reste rien d'ouvert sur le jeu ;
//! - on ne fait QUE de la gestion de fenêtres : aucune lecture de la mémoire
//!   du jeu, aucune injection, aucune lecture du réseau.

use windows::core::{BOOL, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, TRUE};
use windows::Win32::System::Threading::{
    GetCurrentProcessId, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
    VK_MENU,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetForegroundWindow, GetWindow, GetWindowThreadProcessId, InternalGetWindowText,
    IsIconic, IsWindow, IsWindowVisible, SetForegroundWindow, ShowWindowAsync, GW_OWNER,
    SW_RESTORE,
};

/// Une fenêtre de jeu trouvée sur l'écran (avant tout tri ou filtre).
pub struct RawWindow {
    /// L'identifiant Windows de la fenêtre (le HWND converti en entier).
    pub id: isize,
    /// Le titre complet, par exemple « Joueur1 - Iop - 3.3.10.8 - Release ».
    pub title: String,
}

/// Rend la liste des fenêtres Dofus ouvertes, dans l'ordre donné par Windows.
pub fn list() -> Vec<RawWindow> {
    // 1) On demande à Windows la liste de TOUTES les fenêtres de premier niveau.
    let mut all: Vec<HWND> = Vec::new();
    unsafe {
        // `EnumWindows` appelle notre fonction `collect_window` une fois par
        // fenêtre. Comme elle ne peut transmettre qu'un nombre (`LPARAM`), on
        // lui passe l'adresse de notre vecteur, convertie en nombre.
        // `collect_window` refera la conversion inverse pour remplir le vecteur.
        // `let _ =` : on ignore volontairement le résultat ; en cas d'échec,
        // la liste reste simplement vide.
        let _ = EnumWindows(Some(collect_window), LPARAM((&raw mut all) as isize));
    }

    // 2) On ne garde que les fenêtres qui ressemblent à une fenêtre de jeu Dofus.
    // `into_iter()` parcourt la liste, `filter_map` garde et transforme en même
    // temps : la fonction rend `Some(...)` pour garder, `None` pour jeter.
    let own_process = unsafe { GetCurrentProcessId() };
    all.into_iter()
        .filter_map(|hwnd| {
            if !is_top_level_visible(hwnd) {
                return None;
            }
            let title = title_of(hwnd);
            if title.is_empty() {
                return None;
            }
            let pid = process_of(hwnd);
            // Notre propre exécutable s'appelle aussi « dofus-... » : on l'exclut.
            if pid == own_process || !is_dofus_client(pid) {
                return None;
            }
            Some(RawWindow {
                id: hwnd.0 as isize,
                title,
            })
        })
        .collect()
}

/// L'identifiant de la fenêtre actuellement au premier plan.
pub fn foreground() -> isize {
    unsafe { GetForegroundWindow().0 as isize }
}

/// Vrai si la fenêtre `id` appartient à l'organizer lui-même ou à un client
/// Dofus : c'est seulement dans ces cas que nos raccourcis sont actifs.
pub fn is_allowed_foreground(id: isize) -> bool {
    if id == 0 {
        return false; // 0 = aucune fenêtre (par exemple pendant un Alt+Tab)
    }
    let pid = process_of(HWND(id as *mut _));
    pid == unsafe { GetCurrentProcessId() } || is_dofus_client(pid)
}

/// Met la fenêtre `id` au premier plan.
///
/// Rend `Ok(())` en cas de succès, ou `Err(message)` sinon. `Result` est le
/// type Rust pour « une opération qui peut échouer » : l'appelant est obligé
/// de regarder s'il y a eu une erreur.
pub fn activate(id: isize) -> Result<(), String> {
    let hwnd = HWND(id as *mut _);
    unsafe {
        if !IsWindow(Some(hwnd)).as_bool() {
            return Err("Cette fenêtre n'existe plus.".into());
        }
        // Si la fenêtre est réduite dans la barre des tâches, on la restaure.
        // Version « Async » : on demande sans attendre que le jeu ait fini,
        // pour ne jamais rester bloqué si Dofus ne répond pas.
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindowAsync(hwnd, SW_RESTORE);
        }
        if SetForegroundWindow(hwnd).as_bool() {
            return Ok(());
        }

        // Windows refuse parfois qu'un programme vole le premier plan (pour
        // éviter qu'une fenêtre surgisse pendant qu'on tape ailleurs). Il
        // l'accepte en revanche juste après une action au clavier. Astuce
        // classique : simuler un appui très bref sur Alt, puis réessayer.
        // L'appui et le relâchement partent ensemble, en un seul appel : la
        // touche Alt ne peut pas rester « enfoncée », même en cas de plantage.
        let key = |flags| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: VK_MENU, // VK_MENU = la touche Alt
                    dwFlags: flags,
                    ..Default::default()
                },
            },
        };
        let press_release = [key(KEYBD_EVENT_FLAGS::default()), key(KEYEVENTF_KEYUP)];
        // La taille d'un `INPUT` (quelques dizaines d'octets) tient toujours
        // dans un `i32` : la conversion vérifiée ne peut pas échouer.
        let input_size = i32::try_from(std::mem::size_of::<INPUT>()).unwrap_or(i32::MAX);
        SendInput(&press_release, input_size);

        if SetForegroundWindow(hwnd).as_bool() {
            Ok(())
        } else {
            Err("Windows a refusé de mettre la fenêtre au premier plan.".into())
        }
    }
}

// ---------------------------------------------------------------------------
// Fonctions internes (sans `pub` : invisibles en dehors de ce fichier)
// ---------------------------------------------------------------------------

/// Fonction appelée par Windows pour chaque fenêtre pendant `EnumWindows`.
///
/// `extern "system"` : elle suit la convention d'appel de Windows, sinon
/// Windows ne saurait pas l'appeler. Elle rend `TRUE` pour dire « continue ».
unsafe extern "system" fn collect_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
    // On retransforme le nombre reçu en accès à notre vecteur (voir `list`).
    let all = &mut *(lparam.0 as *mut Vec<HWND>);
    all.push(hwnd);
    TRUE
}

/// Vrai si la fenêtre est visible et n'appartient pas à une autre fenêtre
/// (on écarte ainsi les boîtes de dialogue et les fenêtres cachées).
fn is_top_level_visible(hwnd: HWND) -> bool {
    unsafe {
        IsWindowVisible(hwnd).as_bool()
            // `GetWindow(.., GW_OWNER)` échoue quand la fenêtre n'a pas de
            // propriétaire, ce qui est justement ce qu'on veut.
            && GetWindow(hwnd, GW_OWNER).is_err()
    }
}

/// Le titre de la fenêtre.
///
/// `InternalGetWindowText` lit le titre directement auprès de Windows, sans
/// rien demander à la fenêtre elle-même (contrairement à `GetWindowText`
/// dans certains cas) : impossible de rester bloqué sur un jeu figé.
fn title_of(hwnd: HWND) -> String {
    let mut buffer = [0u16; 256];
    let written = unsafe { InternalGetWindowText(hwnd, &mut buffer) };
    // `written` est un nombre de caractères, négatif seulement en cas d'erreur.
    let len = usize::try_from(written).unwrap_or(0);
    String::from_utf16_lossy(&buffer[..len])
}

/// Le numéro du processus (le programme en cours d'exécution) qui possède la fenêtre.
fn process_of(hwnd: HWND) -> u32 {
    let mut pid = 0u32;
    unsafe {
        GetWindowThreadProcessId(hwnd, Some(&raw mut pid));
    }
    pid
}

/// Vrai si l'exécutable du processus est un client Dofus
/// (« Dofus.exe » pour Unity, « Dofus Retro.exe » pour Retro...).
fn is_dofus_client(pid: u32) -> bool {
    match executable_name(pid) {
        // `to_lowercase` pour ignorer les majuscules.
        Some(name) => name.to_lowercase().starts_with("dofus"),
        None => false,
    }
}

/// Le nom du fichier exécutable d'un processus, par exemple « Dofus.exe ».
fn executable_name(pid: u32) -> Option<String> {
    unsafe {
        // On « ouvre » le processus avec le droit minimal nécessaire pour lire
        // son nom. `.ok()?` : en cas d'échec, la fonction s'arrête et rend `None`.
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;

        let mut buffer = [0u16; 1024];
        let mut size = u32::try_from(buffer.len()).unwrap_or(0);
        let result = QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &raw mut size,
        );
        // Toujours refermer ce qu'on a ouvert, même en cas d'erreur.
        let _ = CloseHandle(process);
        result.ok()?;

        // On obtient un chemin complet (C:\...\Dofus.exe) : on garde la fin.
        let path = String::from_utf16_lossy(&buffer[..usize::try_from(size).unwrap_or(0)]);
        path.rsplit('\\').next().map(str::to_string)
    }
}
