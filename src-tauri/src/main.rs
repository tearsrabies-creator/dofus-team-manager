// Empêche l'ouverture d'une console noire en plus de la fenêtre, une fois
// l'application compilée en version finale (« release »). Ne pas supprimer.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Le vrai code est dans lib.rs ; `main` se contente de le lancer.
fn main() {
    dofus_team_manager_lib::run();
}
