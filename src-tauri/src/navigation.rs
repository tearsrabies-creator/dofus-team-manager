//! Logique « pure » de l'organizer : aucune dépendance à Windows ici.
//!
//! Les fonctions de ce fichier prennent des données en entrée et rendent un
//! résultat, sans rien toucher d'autre. C'est ce qui permet de les tester
//! automatiquement (voir le module `tests` en bas, lancé par `cargo test`).
//!
//! Petit rappel de syntaxe Rust :
//! - `//!` documente le fichier entier, `///` documente l'élément qui suit,
//!   `//` est un commentaire ordinaire.
//! - `&str` est un texte qu'on « emprunte » (on le lit sans le posséder),
//!   `String` est un texte qu'on possède (qu'on peut garder ou modifier).
//! - `Option<T>` vaut soit `Some(valeur)`, soit `None` (absence de valeur) :
//!   Rust n'a pas de `null`, il oblige à traiter le cas « rien ».

/// Ce qu'on sait extraire du titre d'une fenêtre Dofus.
///
/// `#[derive(...)]` demande au compilateur d'écrire du code à notre place :
/// `Debug` permet d'afficher la valeur avec `{:?}`, `PartialEq` permet de
/// comparer deux valeurs avec `==` (utile dans les tests).
#[derive(Debug, PartialEq)]
pub struct TitleInfo {
    pub character: Option<String>,
    pub class_name: Option<String>,
}

/// Lit le titre d'une fenêtre Dofus pour en tirer le personnage et la classe.
///
/// Sur Dofus Unity, une fenêtre connectée s'appelle par exemple
/// `"Joueur1 - Iop - 3.3.10.8 - Release"`. Avant la connexion, le titre commence
/// par « Dofus » : on considère alors qu'il n'y a pas encore de personnage.
/// Le numéro de version n'est jamais lu. Si le format change un jour (ou sur
/// Dofus Retro), c'est ici qu'il faut ajuster.
pub fn parse_title(title: &str) -> TitleInfo {
    // `split(" - ")` découpe le texte à chaque " - ", `map(str::trim)` enlève
    // les espaces autour de chaque morceau, `collect()` range le tout dans un
    // vecteur (`Vec`, une liste qui peut grandir).
    let parts: Vec<&str> = title.split(" - ").map(str::trim).collect();

    // `match` compare une valeur à plusieurs formes possibles, un peu comme un
    // `switch` en plus puissant. Ici on regarde le premier morceau.
    let character = match parts.first() {
        // Pas de séparateur " - " : ce n'est pas un titre de personnage.
        _ if parts.len() < 2 => None,
        // Écran de connexion : le titre commence par le nom du jeu.
        Some(name) if name.is_empty() || name.starts_with("Dofus") => None,
        // `to_string()` copie le texte emprunté dans une `String` à nous.
        Some(name) => Some(name.to_string()),
        None => None,
    };

    // La classe n'a de sens que si on a trouvé un personnage, et seulement
    // quand le titre a au moins 3 morceaux (personnage - classe - version...).
    let class_name = if character.is_some() && parts.len() >= 3 {
        Some(parts[1].to_string())
    } else {
        None
    };

    TitleInfo { character, class_name }
}

/// Range les fenêtres présentes dans l'ordre choisi par l'utilisateur.
///
/// - `present` : les clés des fenêtres Dofus ouvertes en ce moment ;
/// - `order` : l'ordre enregistré par l'utilisateur.
///
/// Les fenêtres absentes de `order` sont mises à la fin, dans l'ordre où
/// Windows les a données. On rend des indices dans `present` plutôt que des
/// copies : ça évite de dupliquer les données.
pub fn sort_by_order(present: &[String], order: &[String]) -> Vec<usize> {
    // `(0..n).collect()` fabrique la liste 0, 1, 2, ..., n-1.
    let mut indices: Vec<usize> = (0..present.len()).collect();

    // On trie selon la position de chaque clé dans `order`.
    // `sort_by_key` garde l'ordre d'origine en cas d'égalité (tri « stable »),
    // donc les fenêtres inconnues (toutes à `usize::MAX`) restent dans l'ordre
    // de Windows, après les autres.
    indices.sort_by_key(|&i| {
        order
            .iter()
            .position(|key| *key == present[i])
            .unwrap_or(usize::MAX)
    });
    indices
}

/// Le sens dans lequel on fait défiler les fenêtres.
/// Un `enum` liste toutes les valeurs possibles d'un type : ici, deux.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Direction {
    Next,
    Previous,
}

/// Calcule la position de la fenêtre à activer dans la liste de navigation.
///
/// - `len` : le nombre de fenêtres dans la liste de navigation ;
/// - `current` : la position de la fenêtre au premier plan, si elle fait
///   partie de la liste (`None` sinon, par exemple si on est sur l'organizer).
///
/// Rend `None` quand il n'y a rien à faire (liste vide).
pub fn target(direction: Direction, len: usize, current: Option<usize>) -> Option<usize> {
    if len == 0 {
        return None;
    }
    Some(match (direction, current) {
        // Le `%` (modulo) fait « boucler » : après la dernière, on revient à 0.
        (Direction::Next, Some(i)) => (i + 1) % len,
        (Direction::Next, None) => 0,
        // Pour reculer sans passer sous 0, on ajoute `len` avant le modulo.
        (Direction::Previous, Some(i)) => (i + len - 1) % len,
        (Direction::Previous, None) => len - 1,
    })
}

// `#[cfg(test)]` : ce module n'est compilé que pour `cargo test`,
// il n'alourdit pas l'application finale.
#[cfg(test)]
mod tests {
    // `use super::*` importe tout ce qui est défini au-dessus dans ce fichier.
    use super::*;

    #[test]
    fn unity_title_logged_in() {
        let info = parse_title("Joueur1 - Iop - 3.3.10.8 - Release");
        assert_eq!(info.character.as_deref(), Some("Joueur1"));
        assert_eq!(info.class_name.as_deref(), Some("Iop"));
    }

    #[test]
    fn title_ignores_version() {
        // La version n'est jamais lue : 3.10, une bêta... tout passe.
        let info = parse_title("Joueur1 - Iop - 3.10.0.1 - Beta");
        assert_eq!(info.character.as_deref(), Some("Joueur1"));
        assert_eq!(info.class_name.as_deref(), Some("Iop"));
    }

    #[test]
    fn login_screen_title() {
        assert_eq!(parse_title("Dofus 3.3.10.8 - Release").character, None);
        assert_eq!(parse_title("Dofus").character, None);
    }

    #[test]
    fn two_part_title() {
        let info = parse_title("Joueur-2 - Dofus Retro v1.47");
        assert_eq!(info.character.as_deref(), Some("Joueur-2"));
        assert_eq!(info.class_name, None);
    }

    #[test]
    fn order_kept_and_unknown_last() {
        // `.into()` convertit chaque `&str` en `String`.
        let present: Vec<String> = vec!["C".into(), "A".into(), "X".into(), "B".into()];
        let order: Vec<String> = vec!["A".into(), "B".into(), "C".into()];
        // A (indice 1), B (3), C (0), puis l'inconnue X (2).
        assert_eq!(sort_by_order(&present, &order), vec![1, 3, 0, 2]);
    }

    #[test]
    fn next_and_previous_wrap() {
        assert_eq!(target(Direction::Next, 3, Some(2)), Some(0));
        assert_eq!(target(Direction::Previous, 3, Some(0)), Some(2));
        assert_eq!(target(Direction::Next, 3, None), Some(0));
        assert_eq!(target(Direction::Previous, 3, None), Some(2));
    }

    #[test]
    fn empty_list_does_nothing() {
        assert_eq!(target(Direction::Next, 0, None), None);
    }
}
