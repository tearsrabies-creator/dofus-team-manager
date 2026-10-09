//! La configuration enregistrée sur le disque : ordre des fenêtres, fenêtres
//! cochées, chef de groupe et raccourcis clavier.
//!
//! Elle est stockée en JSON dans le dossier de configuration de l'application,
//! sous Windows : `%APPDATA%\com.dofusteammanager.desktop\config.json`.
//! On peut l'ouvrir avec un éditeur de texte pour voir à quoi elle ressemble.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

/// `Serialize` / `Deserialize` (fournis par serde) savent convertir cette
/// structure en JSON et inversement, champ par champ.
/// `#[serde(default)]` : si un champ manque dans le fichier (ancienne version
/// par exemple), on prend sa valeur par défaut au lieu de tout refuser.
/// `#[serde(alias = "...")]` : accepte aussi l'ancien nom (français) du champ,
/// pour relire les fichiers écrits par les premières versions.
/// `Clone` permet de faire une copie complète avec `.clone()`.
/// `Default` : la configuration vide, quand il n'y a pas encore de fichier ;
/// chaque champ prend sa propre valeur par défaut.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// Tous les personnages déjà vus, dans l'ordre choisi par l'utilisateur.
    /// On garde aussi ceux qui ne sont pas connectés en ce moment, pour
    /// retrouver le même ordre à la prochaine session.
    #[serde(alias = "ordre")]
    pub order: Vec<String>,
    /// Les personnages cochés, entre lesquels on navigue avec les raccourcis.
    pub selection: Vec<String>,
    /// Le personnage qui porte la couronne : le chef de groupe, celui qui
    /// invite les autres. Il n'y en a qu'un : `None` tant qu'aucune couronne
    /// n'est posée.
    #[serde(alias = "chef")]
    pub leader: Option<String>,
    #[serde(alias = "raccourcis")]
    pub shortcuts: Shortcuts,
    pub advanced: Advanced,
}

/// Les réglages avancés.
/// `rename_all = "camelCase"` : en JSON, `distinguish_sides` s'écrit
/// `distinguishSides`, à la façon JavaScript.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Advanced {
    /// Distinguer les touches gauche et droite (Ctrl, Maj, Alt, Win) dans les
    /// raccourcis. Utilise un crochet clavier au lieu des raccourcis Windows.
    pub distinguish_sides: bool,
}

/// Les raccourcis, écrits comme « Control+Tab » ou « Alt+Digit1 ».
/// Un texte vide veut dire « pas de raccourci ».
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Shortcuts {
    #[serde(alias = "suivante")]
    pub next: String,
    #[serde(alias = "precedente")]
    pub previous: String,
    /// L'interrupteur : coupe ou réactive tous les autres raccourcis.
    pub toggle: String,
    /// Raccourci optionnel propre à chaque personnage : nom → raccourci.
    /// Un `BTreeMap` est un dictionnaire (clé → valeur) dont les clés restent
    /// triées : le fichier JSON garde ainsi toujours le même ordre.
    /// En JSON, il s'écrit comme un objet : `{ "Joueur1": "Alt+Digit1" }`.
    #[serde(alias = "personnages")]
    pub characters: BTreeMap<String, String>,
}

// `impl Default for ...` écrit à la main : contrairement aux autres
// structures, les raccourcis par défaut ne sont pas vides.
impl Default for Shortcuts {
    fn default() -> Self {
        Shortcuts {
            next: "Control+Tab".into(),
            previous: "Control+Shift+Tab".into(),
            toggle: String::new(),
            characters: BTreeMap::new(),
        }
    }
}

impl Config {
    /// Lit la configuration depuis `path`. Si le fichier n'existe pas ou est
    /// illisible, on repart de la configuration par défaut.
    /// Les champs inconnus (venant d'une ancienne version) sont ignorés.
    pub fn load(path: &Path) -> Config {
        // `and_then` enchaîne une 2e opération seulement si la 1re a réussi ;
        // `unwrap_or_default` prend la valeur par défaut en cas d'échec.
        fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default()
    }

    /// Lit la configuration depuis `path` ; si elle n'existe pas encore,
    /// reprend celle de `previous` (le fichier d'un ancien nom de
    /// l'application) et l'enregistre au nouvel emplacement. Ainsi, un
    /// changement de nom ne fait perdre aucun réglage.
    pub fn load_or_migrate(path: &Path, previous: &Path) -> Config {
        if !path.exists() && previous.exists() {
            let config = Config::load(previous);
            // En cas d'échec, on garde quand même la configuration lue : elle
            // sera écrite au nouvel emplacement à la prochaine modification.
            let _ = config.save(path);
            return config;
        }
        Config::load(path)
    }

    /// Écrit la configuration dans `path` (en créant le dossier si besoin).
    /// L'opérateur `?` arrête la fonction et renvoie l'erreur si une étape échoue.
    pub fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(folder) = path.parent() {
            fs::create_dir_all(folder).map_err(|e| e.to_string())?;
        }
        let text = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        fs::write(path, text).map_err(|e| e.to_string())
    }

    /// Ajoute à l'ordre et à la sélection les personnages jamais vus.
    /// Un nouveau personnage est donc coché par défaut ; on peut le décocher.
    /// Rend `true` si quelque chose a changé (il faudra alors enregistrer).
    pub fn add_new_characters(&mut self, characters: &[String]) -> bool {
        let mut changed = false;
        for name in characters {
            if !self.order.contains(name) {
                self.order.push(name.clone());
                self.selection.push(name.clone());
                changed = true;
            }
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_characters_added_and_selected() {
        let mut config = Config {
            order: vec!["Joueur1".into()],
            ..Default::default()
        };
        let changed = config.add_new_characters(&["Joueur1".into(), "Joueur-2".into()]);
        assert!(changed);
        assert_eq!(
            config.order,
            vec!["Joueur1".to_string(), "Joueur-2".to_string()]
        );
        assert_eq!(config.selection, vec!["Joueur-2".to_string()]);
        // Une deuxième fois, rien ne change.
        assert!(!config.add_new_characters(&["Joueur-2".into()]));
    }

    #[test]
    fn previous_config_migrated_once() {
        // Un dossier de travail temporaire, propre à ce test.
        let folder = std::env::temp_dir().join(format!("dtm-test-{}", std::process::id()));
        let previous = folder.join("ancien").join("config.json");
        let path = folder.join("nouveau").join("config.json");
        let old = Config {
            leader: Some("Joueur1".into()),
            ..Default::default()
        };
        old.save(&previous).unwrap();

        // Pas encore de nouvelle configuration : on reprend l'ancienne...
        let migrated = Config::load_or_migrate(&path, &previous);
        assert_eq!(migrated.leader.as_deref(), Some("Joueur1"));
        assert!(path.exists());
        // ... puis, la fois suivante, c'est la nouvelle qui compte.
        let newer = Config {
            leader: Some("Joueur-2".into()),
            ..Default::default()
        };
        newer.save(&path).unwrap();
        let reloaded = Config::load_or_migrate(&path, &previous);
        assert_eq!(reloaded.leader.as_deref(), Some("Joueur-2"));

        let _ = fs::remove_dir_all(folder);
    }

    #[test]
    fn partial_json_filled_with_defaults() {
        let config: Config = serde_json::from_str(r#"{ "order": ["Joueur1"] }"#).unwrap();
        assert_eq!(config.order, vec!["Joueur1".to_string()]);
        assert_eq!(config.shortcuts.next, "Control+Tab");
    }

    #[test]
    fn french_keys_from_older_versions_accepted() {
        let text = r#"{
            "ordre": ["Joueur1"], "chef": "Joueur1",
            "raccourcis": { "suivante": "F2", "personnages": { "Joueur1": "F5" }, "numeros": ["F9"] }
        }"#;
        let config: Config = serde_json::from_str(text).unwrap();
        assert_eq!(config.order, vec!["Joueur1".to_string()]);
        assert_eq!(config.leader.as_deref(), Some("Joueur1"));
        assert_eq!(config.shortcuts.next, "F2");
        assert_eq!(
            config
                .shortcuts
                .characters
                .get("Joueur1")
                .map(String::as_str),
            Some("F5")
        );
    }
}
