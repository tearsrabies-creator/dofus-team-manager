//! L'écoute du clavier, sur un fil d'exécution (« thread ») qui lui est dédié.
//!
//! Deux moteurs possibles, un seul actif à la fois :
//!
//! - **Raccourcis Windows** (`RegisterHotKey`), par défaut : Windows surveille
//!   lui-même les combinaisons et nous prévient. Il ne sait pas distinguer
//!   Ctrl gauche de Ctrl droit.
//! - **Crochet clavier** (`WH_KEYBOARD_LL`), si l'option « distinguer gauche
//!   et droite » est cochée : Windows nous montre chaque touche avant de la
//!   transmettre ; on reconnaît nos combinaisons (en distinguant les côtés)
//!   et on laisse passer tout le reste sans rien retenir.
//!
//! Pourquoi un thread dédié ? Ces deux mécanismes envoient leurs messages au
//! thread qui les a installés. Ce thread ne fait que ça : il attend un
//! message, réagit en quelques microsecondes et se rendort. Ainsi, même si
//! l'interface est occupée, la frappe au clavier n'est jamais ralentie.
//! Quand un raccourci est reconnu, l'action est confiée au thread principal
//! sans l'attendre (`run_on_main_thread`).
//!
//! Si l'application plante, Windows retire le crochet et libère les raccourcis
//! tout seul : rien ne reste bloqué sur le jeu.

use std::cell::RefCell;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::OnceLock;
use tauri::AppHandle;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HINSTANCE, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, MapVirtualKeyW, RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS,
    MAPVK_VSC_TO_VK_EX, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, MOD_WIN, VIRTUAL_KEY,
    VK_LCONTROL, VK_LMENU, VK_LSHIFT, VK_LWIN, VK_RCONTROL, VK_RMENU, VK_RSHIFT, VK_RWIN,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetMessageW, PeekMessageW, PostThreadMessageW, SetWindowsHookExW,
    UnhookWindowsHookEx, HC_ACTION, HHOOK, KBDLLHOOKSTRUCT, LLKHF_EXTENDED, LLKHF_INJECTED, MSG,
    PM_NOREMOVE, WH_KEYBOARD_LL, WM_APP, WM_HOTKEY, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN,
    WM_SYSKEYUP,
};

use crate::combo::{Combo, Modifiers, Side};
use crate::shortcuts::Action;

/// Un raccourci prêt à l'emploi : sa combinaison, son action, et son nom
/// (pour les messages d'erreur).
pub struct Binding {
    pub combo: Combo,
    pub action: Action,
    pub label: String,
}

/// Le moteur à utiliser.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Backend {
    /// Aucun raccourci actif.
    Off,
    /// Raccourcis Windows (`RegisterHotKey`).
    Hotkeys,
    /// Crochet clavier (distingue gauche et droite).
    Hook,
}

/// Une demande envoyée au thread clavier : remplacer les raccourcis.
/// `reply` sert à renvoyer la liste des erreurs à celui qui a demandé.
struct Request {
    bindings: Vec<Binding>,
    backend: Backend,
    reply: Sender<Vec<String>>,
}

/// De quoi joindre le thread clavier : son numéro (pour le réveiller) et
/// l'entrée du « canal » par lequel on lui envoie les demandes.
struct InputThread {
    thread_id: u32,
    requests: Sender<Request>,
}

static INPUT: OnceLock<InputThread> = OnceLock::new();

/// Démarre le thread clavier. À appeler une fois, au lancement.
pub fn start(app: AppHandle) {
    // Un « canal » (channel) est un tuyau entre deux threads : ce qu'on met
    // d'un côté (`Sender`) ressort de l'autre (`Receiver`).
    let (requests, receiver) = channel::<Request>();
    let (id_sender, id_receiver) = channel::<u32>();
    std::thread::spawn(move || run(app, &receiver, &id_sender));
    // On attend que le thread soit prêt et nous donne son numéro.
    if let Ok(thread_id) = id_receiver.recv() {
        let _ = INPUT.set(InputThread {
            thread_id,
            requests,
        });
    }
}

/// Remplace les raccourcis actifs. Rend la liste des problèmes rencontrés.
/// Attend la réponse du thread clavier (quelques microsecondes) ; celui-ci
/// n'attend jamais personne, il ne peut donc pas y avoir de blocage mutuel.
pub fn apply(bindings: Vec<Binding>, backend: Backend) -> Vec<String> {
    let Some(input) = INPUT.get() else {
        return vec!["L'écoute du clavier n'a pas pu démarrer.".into()];
    };
    let (reply, answer) = channel();
    if input
        .requests
        .send(Request {
            bindings,
            backend,
            reply,
        })
        .is_err()
    {
        return vec!["L'écoute du clavier s'est arrêtée.".into()];
    }
    // On réveille le thread clavier, qui dort en attendant un message Windows.
    unsafe {
        let _ = PostThreadMessageW(input.thread_id, WM_APP, WPARAM(0), LPARAM(0));
    }
    answer.recv().unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Tout ce qui suit s'exécute sur le thread clavier.
// ---------------------------------------------------------------------------

/// L'état du thread clavier.
struct State {
    app: AppHandle,
    bindings: Vec<Binding>,
    /// Le crochet installé, s'il y en a un.
    hook: Option<HHOOK>,
    /// Combien de raccourcis Windows sont enregistrés (numérotés 0, 1, 2...,
    /// en `i32` comme l'attend Windows).
    hotkey_count: i32,
    /// Les touches qui ont déclenché un raccourci et sont encore enfoncées :
    /// on ignore leurs répétitions et on retient aussi leur relâchement.
    held: Vec<u32>,
}

// `thread_local!` : une variable propre au thread clavier. La fonction du
// crochet, appelée par Windows sans paramètre à nous, la retrouve ici.
// `RefCell` permet de la modifier en vérifiant à l'exécution qu'une seule
// partie du code y touche à la fois.
thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

/// La boucle du thread clavier : attendre un message, le traiter, recommencer.
fn run(app: AppHandle, requests: &Receiver<Request>, id_sender: &Sender<u32>) {
    let mut msg = MSG::default();
    unsafe {
        // Windows ne crée la file de messages d'un thread qu'à son premier
        // appel de ce genre : on la crée avant d'annoncer qu'on est prêt.
        let _ = PeekMessageW(&raw mut msg, None, 0, 0, PM_NOREMOVE);
        let _ = id_sender.send(GetCurrentThreadId());
    }
    STATE.with(|s| {
        *s.borrow_mut() = Some(State {
            app,
            bindings: Vec::new(),
            hook: None,
            hotkey_count: 0,
            held: Vec::new(),
        });
    });

    // `GetMessageW` endort le thread jusqu'au prochain message. Les appuis
    // vus par le crochet sont traités pendant cette attente (dans
    // `keyboard_proc`) ; ici n'arrivent que nos demandes et les raccourcis
    // Windows.
    while unsafe { GetMessageW(&raw mut msg, None, 0, 0) }.as_bool() {
        match msg.message {
            WM_APP => {
                // `try_recv` : prendre les demandes en attente, sans attendre.
                while let Ok(request) = requests.try_recv() {
                    let errors = STATE.with(|s| match s.borrow_mut().as_mut() {
                        Some(state) => replace_bindings(state, request.bindings, request.backend),
                        None => Vec::new(),
                    });
                    let _ = request.reply.send(errors);
                }
            }
            WM_HOTKEY => {
                // `wParam` contient le numéro du raccourci : sa place dans la liste.
                let index = msg.wParam.0;
                STATE.with(|s| {
                    if let Some(state) = s.borrow().as_ref() {
                        if let Some(binding) = state.bindings.get(index) {
                            dispatch(&state.app, binding.action.clone());
                        }
                    }
                });
            }
            _ => {}
        }
    }
}

/// Retire les anciens raccourcis et installe les nouveaux avec le moteur demandé.
fn replace_bindings(state: &mut State, bindings: Vec<Binding>, backend: Backend) -> Vec<String> {
    unsafe {
        if let Some(hook) = state.hook.take() {
            let _ = UnhookWindowsHookEx(hook);
        }
        for id in 0..state.hotkey_count {
            let _ = UnregisterHotKey(None, id);
        }
    }
    state.hotkey_count = 0;
    state.held.clear();

    let mut errors = Vec::new();
    // Les raccourcis Windows ne voient pas les côtés : on compare donc les
    // combinaisons sans les côtés pour repérer les doublons.
    let comparable = |c: &Combo| match backend {
        Backend::Hook => c.clone(),
        _ => c.without_sides(),
    };
    let mut kept: Vec<Binding> = Vec::new();
    if backend != Backend::Off {
        for binding in bindings {
            if kept
                .iter()
                .any(|k| comparable(&k.combo) == comparable(&binding.combo))
            {
                errors.push(format!(
                    "{} : cette combinaison est déjà utilisée par une autre action.",
                    binding.label
                ));
            } else {
                kept.push(binding);
            }
        }
    }

    match backend {
        Backend::Off => {}
        Backend::Hotkeys => {
            // `zip(0..)` numérote les raccourcis 0, 1, 2... directement en `i32`.
            for (binding, id) in kept.iter().zip(0..) {
                if let Err(message) = register_hotkey(id, &binding.combo) {
                    errors.push(format!("{} : {message}", binding.label));
                }
                state.hotkey_count = id + 1;
            }
        }
        Backend::Hook => {
            if !kept.is_empty() {
                match install_hook() {
                    Ok(hook) => state.hook = Some(hook),
                    Err(message) => errors.push(message),
                }
            }
        }
    }
    state.bindings = kept;
    errors
}

/// Enregistre un raccourci Windows. La touche est traduite selon la
/// disposition actuelle du clavier (AZERTY, QWERTY...) : c'est bien la touche
/// physique saisie par l'utilisateur qui déclenchera le raccourci.
fn register_hotkey(id: i32, combo: &Combo) -> Result<(), String> {
    let vk = unsafe { MapVirtualKeyW(combo.scan, MAPVK_VSC_TO_VK_EX) };
    if vk == 0 {
        return Err("cette touche n'existe pas sur le clavier actuel.".into());
    }
    // Les modificateurs se combinent avec `|` (« ou » bit à bit).
    // MOD_NOREPEAT : un seul déclenchement si on garde la touche enfoncée.
    let mut modifiers: HOT_KEY_MODIFIERS = MOD_NOREPEAT;
    if combo.ctrl != Side::None {
        modifiers |= MOD_CONTROL;
    }
    if combo.shift != Side::None {
        modifiers |= MOD_SHIFT;
    }
    if combo.alt != Side::None {
        modifiers |= MOD_ALT;
    }
    if combo.win != Side::None {
        modifiers |= MOD_WIN;
    }
    // `None` : pas de fenêtre ; Windows envoie WM_HOTKEY à ce thread.
    unsafe { RegisterHotKey(None, id, modifiers, vk) }
        .map_err(|_| "combinaison déjà prise par un autre programme.".into())
}

/// Installe le crochet clavier.
fn install_hook() -> Result<HHOOK, String> {
    unsafe {
        let module = GetModuleHandleW(PCWSTR::null()).map_err(|e| e.to_string())?;
        SetWindowsHookExW(
            WH_KEYBOARD_LL,
            Some(keyboard_proc),
            Some(HINSTANCE(module.0)),
            0,
        )
        .map_err(|e| format!("Le crochet clavier n'a pas pu être installé ({e})."))
    }
}

/// Appelée par Windows pour chaque touche pressée ou relâchée, tant que le
/// crochet est installé. Doit être très rapide : Windows attend notre réponse
/// avant de transmettre la touche. Rendre `LRESULT(1)` « avale » la touche
/// (le jeu ne la reçoit pas) ; `CallNextHookEx` la laisse passer.
unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if u32::try_from(code) == Ok(HC_ACTION) {
        let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        // On ignore les touches simulées par des programmes (y compris les
        // nôtres) : seules les vraies frappes comptent.
        if info.flags.0 & LLKHF_INJECTED.0 == 0 {
            let extended = info.flags.0 & LLKHF_EXTENDED.0 != 0;
            let scan = info.scanCode | if extended { 0xE000 } else { 0 };
            let message = u32::try_from(wparam.0).unwrap_or(0);
            let down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
            let up = message == WM_KEYUP || message == WM_SYSKEYUP;
            // `try_borrow_mut` plutôt que `borrow_mut` : si l'état est déjà
            // utilisé (cas qui ne devrait pas arriver), on laisse passer la
            // touche au lieu de planter. Et `catch_unwind` : une panique ne
            // doit jamais sortir d'une fonction appelée par Windows (voir
            // foreground.rs) ; en cas de problème, la touche passe normalement.
            let swallow = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                STATE.with(|s| match s.try_borrow_mut() {
                    Ok(mut guard) => guard
                        .as_mut()
                        .is_some_and(|state| on_key(state, scan, down, up)),
                    Err(_) => false,
                })
            }))
            .unwrap_or(false);
            if swallow {
                return LRESULT(1);
            }
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

/// Décide quoi faire d'une touche. Rend `true` pour l'avaler.
fn on_key(state: &mut State, scan: u32, down: bool, up: bool) -> bool {
    if up {
        // Relâchement d'une touche qui avait déclenché un raccourci : on
        // l'avale aussi, pour que le jeu ne voie ni l'appui ni le relâchement.
        if let Some(position) = state.held.iter().position(|&s| s == scan) {
            state.held.remove(position);
            return true;
        }
        return false;
    }
    if !down {
        return false;
    }
    if state.held.contains(&scan) {
        return true; // répétition automatique d'une touche maintenue
    }
    let mods = current_modifiers();
    if let Some(binding) = state.bindings.iter().find(|b| b.combo.matches(mods, scan)) {
        state.held.push(scan);
        dispatch(&state.app, binding.action.clone());
        return true;
    }
    false
}

/// L'état actuel des huit touches de modification.
fn current_modifiers() -> Modifiers {
    // Le bit de poids fort (valeur négative) indique une touche enfoncée.
    let pressed = |key: VIRTUAL_KEY| unsafe { GetAsyncKeyState(i32::from(key.0)) } < 0;
    Modifiers {
        lctrl: pressed(VK_LCONTROL),
        rctrl: pressed(VK_RCONTROL),
        lshift: pressed(VK_LSHIFT),
        rshift: pressed(VK_RSHIFT),
        lalt: pressed(VK_LMENU),
        ralt: pressed(VK_RMENU),
        lwin: pressed(VK_LWIN),
        rwin: pressed(VK_RWIN),
    }
}

/// Confie l'action au thread principal, sans attendre qu'elle soit faite.
fn dispatch(app: &AppHandle, action: Action) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || crate::run_action(&handle, action));
}
