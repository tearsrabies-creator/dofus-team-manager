//! Les combinaisons de touches : les lire depuis leur texte (« Control+Alt+KeyP »)
//! et décider si l'état du clavier y correspond. Logique pure, testée en bas.
//!
//! Une combinaison = des modificateurs (Ctrl, Maj, Alt, Win) + une touche.
//!
//! La touche est désignée par sa **position physique** sur le clavier, avec
//! les noms du web (`KeyQ` = la touche à la place du Q sur un clavier QWERTY,
//! qui porte un A sur un clavier AZERTY). On la convertit en « code de
//! balayage » (scan code) : le numéro que le clavier envoie pour cette
//! position, identique quelle que soit la disposition. C'est ce qui permet de
//! déclencher le raccourci sur la touche que l'utilisateur a réellement
//! pressée, en AZERTY comme en QWERTY.
//!
//! Pour chaque modificateur, la combinaison peut exiger :
//! - rien (`Control` absent) : ce modificateur ne doit pas être enfoncé ;
//! - n'importe quel côté (`Control`) ;
//! - un côté précis (`ControlLeft` ou `ControlRight`), seulement quand
//!   l'option « distinguer gauche et droite » est active.

/// Ce qu'une combinaison exige pour un modificateur.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Side {
    /// Le modificateur ne doit pas être enfoncé.
    #[default]
    None,
    /// Gauche ou droite, peu importe.
    Any,
    Left,
    Right,
}

impl Side {
    /// Vrai si l'état (gauche enfoncé ?, droit enfoncé ?) respecte l'exigence.
    fn accepts(self, left: bool, right: bool) -> bool {
        match self {
            Side::None => !left && !right,
            Side::Any => left || right,
            Side::Left => left && !right,
            Side::Right => right && !left,
        }
    }

    /// Ce que devient l'exigence quand on ne sait pas distinguer les côtés.
    pub fn without_side(self) -> Side {
        match self {
            Side::None => Side::None,
            _ => Side::Any,
        }
    }
}

/// Une combinaison de touches.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Combo {
    pub ctrl: Side,
    pub shift: Side,
    pub alt: Side,
    pub win: Side,
    /// Le code de balayage de la touche principale. Les touches « étendues »
    /// (flèches, Inser, Suppr...) ont un préfixe 0xE0 : 0xE04D = flèche droite.
    pub scan: u32,
}

impl Combo {
    /// Lit une combinaison écrite comme « Control+Alt+KeyP ». Rend un message
    /// d'erreur en français si le texte n'est pas compris.
    pub fn parse(text: &str) -> Result<Combo, String> {
        let mut combo = Combo { ctrl: Side::None, shift: Side::None, alt: Side::None, win: Side::None, scan: 0 };
        let mut key: Option<u32> = None;

        for part in text.split('+').map(str::trim).filter(|p| !p.is_empty()) {
            // Chaque morceau est soit un modificateur, soit la touche principale.
            // `match part` compare le texte à chaque nom possible.
            let (slot, side) = match part {
                "Control" | "Ctrl" => (&mut combo.ctrl, Side::Any),
                "ControlLeft" => (&mut combo.ctrl, Side::Left),
                "ControlRight" => (&mut combo.ctrl, Side::Right),
                "Shift" => (&mut combo.shift, Side::Any),
                "ShiftLeft" => (&mut combo.shift, Side::Left),
                "ShiftRight" => (&mut combo.shift, Side::Right),
                "Alt" => (&mut combo.alt, Side::Any),
                "AltLeft" => (&mut combo.alt, Side::Left),
                "AltRight" => (&mut combo.alt, Side::Right),
                "Super" | "Meta" | "Win" => (&mut combo.win, Side::Any),
                "MetaLeft" => (&mut combo.win, Side::Left),
                "MetaRight" => (&mut combo.win, Side::Right),
                _ => {
                    if key.is_some() {
                        return Err(format!("« {text} » contient plusieurs touches principales."));
                    }
                    key = Some(scan_code(part).ok_or_else(|| format!("la touche « {part} » n'est pas prise en charge."))?);
                    continue;
                }
            };
            // `*slot = side` écrit dans le champ choisi plus haut (Ctrl, Maj...).
            *slot = side;
        }

        combo.scan = key.ok_or_else(|| format!("« {text} » n'a pas de touche principale."))?;
        Ok(combo)
    }

    /// Vrai si l'état du clavier correspond à la combinaison.
    pub fn matches(&self, mods: &Modifiers, scan: u32) -> bool {
        // AltGr (Alt droit sur les claviers français) : Windows simule en plus
        // un appui sur Ctrl gauche. Si Alt droit est enfoncé et que la
        // combinaison ne parle pas de Ctrl, on ignore ce faux Ctrl gauche.
        let fake_ctrl = mods.ralt && self.ctrl == Side::None && !mods.rctrl;
        let lctrl = mods.lctrl && !fake_ctrl;

        scan == self.scan
            && self.ctrl.accepts(lctrl, mods.rctrl)
            && self.shift.accepts(mods.lshift, mods.rshift)
            && self.alt.accepts(mods.lalt, mods.ralt)
            && self.win.accepts(mods.lwin, mods.rwin)
    }

    /// Vrai si la combinaison exige un côté précis pour au moins un modificateur.
    pub fn has_sides(&self) -> bool {
        [self.ctrl, self.shift, self.alt, self.win]
            .iter()
            .any(|s| matches!(s, Side::Left | Side::Right))
    }
}

/// L'état des huit touches de modification au moment d'un appui.
#[derive(Debug, Clone, Copy, Default)]
pub struct Modifiers {
    pub lctrl: bool,
    pub rctrl: bool,
    pub lshift: bool,
    pub rshift: bool,
    pub lalt: bool,
    pub ralt: bool,
    pub lwin: bool,
    pub rwin: bool,
}

/// Le code de balayage d'une touche désignée par son nom du web.
/// `None` si la touche n'est pas dans la table.
pub fn scan_code(code: &str) -> Option<u32> {
    // Les lettres, rangée par rangée, dans l'ordre du clavier QWERTY.
    const LETTERS: [(&str, u32); 26] = [
        ("KeyQ", 0x10), ("KeyW", 0x11), ("KeyE", 0x12), ("KeyR", 0x13), ("KeyT", 0x14),
        ("KeyY", 0x15), ("KeyU", 0x16), ("KeyI", 0x17), ("KeyO", 0x18), ("KeyP", 0x19),
        ("KeyA", 0x1E), ("KeyS", 0x1F), ("KeyD", 0x20), ("KeyF", 0x21), ("KeyG", 0x22),
        ("KeyH", 0x23), ("KeyJ", 0x24), ("KeyK", 0x25), ("KeyL", 0x26),
        ("KeyZ", 0x2C), ("KeyX", 0x2D), ("KeyC", 0x2E), ("KeyV", 0x2F), ("KeyB", 0x30),
        ("KeyN", 0x31), ("KeyM", 0x32),
    ];
    if let Some((_, scan)) = LETTERS.iter().find(|(name, _)| *name == code) {
        return Some(*scan);
    }
    // `strip_prefix` rend le reste du texte s'il commence par le préfixe donné.
    if let Some(digit) = code.strip_prefix("Digit") {
        // Digit1 = 0x02 ... Digit9 = 0x0A, Digit0 = 0x0B.
        return match digit.parse::<u32>().ok()? {
            0 => Some(0x0B),
            n @ 1..=9 => Some(0x01 + n),
            _ => None,
        };
    }
    if let Some(number) = code.strip_prefix('F') {
        if let Ok(n) = number.parse::<u32>() {
            return match n {
                1..=10 => Some(0x3A + n),   // F1 = 0x3B ... F10 = 0x44
                11 => Some(0x57),
                12 => Some(0x58),
                13..=23 => Some(0x57 + n),  // F13 = 0x64 ... F23 = 0x6E
                24 => Some(0x76),
                _ => None,
            };
        }
    }
    Some(match code {
        "Escape" => 0x01,
        "Minus" => 0x0C,
        "Equal" => 0x0D,
        "Backspace" => 0x0E,
        "Tab" => 0x0F,
        "BracketLeft" => 0x1A,
        "BracketRight" => 0x1B,
        "Enter" => 0x1C,
        "Semicolon" => 0x27,
        "Quote" => 0x28,
        "Backquote" => 0x29, // la touche ² en AZERTY
        "Backslash" => 0x2B,
        "Comma" => 0x33,
        "Period" => 0x34,
        "Slash" => 0x35,
        "Space" => 0x39,
        "CapsLock" => 0x3A,
        "ScrollLock" => 0x46,
        "IntlBackslash" => 0x56, // la touche < > en AZERTY
        "Numpad7" => 0x47,
        "Numpad8" => 0x48,
        "Numpad9" => 0x49,
        "NumpadSubtract" => 0x4A,
        "Numpad4" => 0x4B,
        "Numpad5" => 0x4C,
        "Numpad6" => 0x4D,
        "NumpadAdd" => 0x4E,
        "Numpad1" => 0x4F,
        "Numpad2" => 0x50,
        "Numpad3" => 0x51,
        "Numpad0" => 0x52,
        "NumpadDecimal" => 0x53,
        "NumpadMultiply" => 0x37,
        "NumpadEnter" => 0xE01C,
        "NumpadDivide" => 0xE035,
        "PrintScreen" => 0xE037,
        "Home" => 0xE047,
        "ArrowUp" => 0xE048,
        "PageUp" => 0xE049,
        "ArrowLeft" => 0xE04B,
        "ArrowRight" => 0xE04D,
        "End" => 0xE04F,
        "ArrowDown" => 0xE050,
        "PageDown" => 0xE051,
        "Insert" => 0xE052,
        "Delete" => 0xE053,
        "ContextMenu" => 0xE05D,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_modifiers_and_key() {
        let combo = Combo::parse("Control+Alt+KeyP").unwrap();
        assert_eq!(combo.ctrl, Side::Any);
        assert_eq!(combo.alt, Side::Any);
        assert_eq!(combo.shift, Side::None);
        assert_eq!(combo.scan, 0x19);
        assert!(!combo.has_sides());
    }

    #[test]
    fn parses_sides_and_extended_keys() {
        let combo = Combo::parse("ControlLeft+AltRight+ArrowRight").unwrap();
        assert_eq!(combo.ctrl, Side::Left);
        assert_eq!(combo.alt, Side::Right);
        assert_eq!(combo.scan, 0xE04D);
        assert!(combo.has_sides());
    }

    #[test]
    fn digits_and_function_keys() {
        assert_eq!(scan_code("Digit1"), Some(0x02));
        assert_eq!(scan_code("Digit0"), Some(0x0B));
        assert_eq!(scan_code("F1"), Some(0x3B));
        assert_eq!(scan_code("F12"), Some(0x58));
        assert_eq!(scan_code("F13"), Some(0x64));
    }

    #[test]
    fn rejects_bad_text() {
        assert!(Combo::parse("Control+Alt").is_err()); // pas de touche principale
        assert!(Combo::parse("KeyA+KeyB").is_err()); // deux touches principales
        assert!(Combo::parse("Control+Banane").is_err()); // touche inconnue
    }

    #[test]
    fn exact_modifiers_required() {
        let combo = Combo::parse("Control+KeyG").unwrap();
        let ctrl = Modifiers { lctrl: true, ..Default::default() };
        let ctrl_shift = Modifiers { lctrl: true, lshift: true, ..Default::default() };
        assert!(combo.matches(&ctrl, 0x22));
        assert!(!combo.matches(&ctrl_shift, 0x22)); // Maj en trop
        assert!(!combo.matches(&ctrl, 0x23)); // autre touche
    }

    #[test]
    fn left_and_right_are_distinguished() {
        let left = Combo::parse("AltLeft+KeyP").unwrap();
        let right = Combo::parse("AltRight+KeyP").unwrap();
        let lalt = Modifiers { lalt: true, ..Default::default() };
        let ralt = Modifiers { ralt: true, ..Default::default() };
        assert!(left.matches(&lalt, 0x19) && !left.matches(&ralt, 0x19));
        assert!(right.matches(&ralt, 0x19) && !right.matches(&lalt, 0x19));
    }

    #[test]
    fn altgr_fake_ctrl_is_ignored() {
        // AltGr = Alt droit + un faux Ctrl gauche simulé par Windows.
        let altgr = Modifiers { ralt: true, lctrl: true, ..Default::default() };
        assert!(Combo::parse("AltRight+KeyP").unwrap().matches(&altgr, 0x19));
        // Si la combinaison demande vraiment Ctrl gauche, il compte.
        assert!(Combo::parse("ControlLeft+AltRight+KeyP").unwrap().matches(&altgr, 0x19));
    }
}
