//! Écrire un texte dans le presse-papiers de Windows.
//!
//! Le navigateur intégré sait le faire, mais seulement depuis une page qui a
//! le focus. Or le bandeau ne prend jamais le focus (pour que le jeu le
//! garde) : on passe donc directement par l'API Windows.
//!
//! Le principe : on réserve un bloc de mémoire « global » (que Windows peut
//! confier à d'autres programmes), on y recopie le texte en UTF-16, puis on
//! le donne au presse-papiers, qui en devient propriétaire.

use windows::Win32::Foundation::{GlobalFree, HANDLE, HWND};
use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::CF_UNICODETEXT;

/// Met `text` dans le presse-papiers. `owner` est une fenêtre de
/// l'application (Windows demande un « propriétaire » pour le contenu).
pub fn copy_text(text: &str, owner: isize) -> Result<(), String> {
    // Le texte en UTF-16, terminé par un 0 comme l'attend Windows.
    // `chain(once(0))` ajoute ce 0 à la fin de la suite de caractères.
    let utf16: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
    let bytes = utf16.len() * std::mem::size_of::<u16>();

    unsafe {
        // Un autre programme peut être en train d'utiliser le presse-papiers :
        // on réessaie quelques fois, à 10 ms d'intervalle.
        let mut opened = false;
        for _ in 0..10 {
            if OpenClipboard(Some(HWND(owner as *mut _))).is_ok() {
                opened = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        if !opened {
            return Err("Le presse-papiers est occupé par un autre programme.".into());
        }

        // Le bloc `(|| { ... })()` est une petite fonction appelée aussitôt :
        // elle permet d'utiliser `?` pour sortir à la première erreur, tout
        // en refermant toujours le presse-papiers juste après.
        let result = (|| -> Result<(), String> {
            EmptyClipboard().map_err(|e| e.to_string())?;
            let memory = GlobalAlloc(GMEM_MOVEABLE, bytes).map_err(|e| e.to_string())?;
            let target = GlobalLock(memory) as *mut u16;
            if target.is_null() {
                let _ = GlobalFree(Some(memory));
                return Err("Mémoire indisponible pour le presse-papiers.".into());
            }
            std::ptr::copy_nonoverlapping(utf16.as_ptr(), target, utf16.len());
            let _ = GlobalUnlock(memory);
            // En cas de succès, le presse-papiers devient propriétaire de la
            // mémoire : on ne doit plus la libérer nous-mêmes.
            if let Err(e) = SetClipboardData(CF_UNICODETEXT.0 as u32, Some(HANDLE(memory.0))) {
                let _ = GlobalFree(Some(memory));
                return Err(e.to_string());
            }
            Ok(())
        })();

        let _ = CloseClipboard();
        result
    }
}
