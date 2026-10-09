# Dofus Organizer

Petit organizer multicompte pour Dofus (Windows), inspiré du module Organizer de nAiO :

- détecte les fenêtres Dofus ouvertes et reconnaît le personnage et sa classe grâce au titre de la fenêtre, avec le symbole de la classe ;
- permet de **cocher** les fenêtres entre lesquelles on navigue, et de choisir leur **ordre** en glissant les lignes par leur poignée ⠿ (gardé d'une session à l'autre) ;
- **raccourcis clavier globaux**, avec n'importe quelle combinaison (Ctrl + Alt + P…) : fenêtre suivante et précédente (parmi les fenêtres cochées), un raccourci facultatif par personnage, et un **interrupteur** qui coupe ou réactive tous les autres. Ils ne sont actifs que quand une fenêtre Dofus ou l'organizer est au premier plan. Une option avancée permet de **distinguer gauche et droite** (Alt G / Alt D, Ctrl G / Ctrl D…) ;
- une **couronne 👑** unique à donner au chef de groupe ;
- bouton **« Copier les invitations »** : met dans le presse-papiers `/invite Perso2; /invite Perso3…` (toutes les fenêtres cochées sauf le chef) pour former le groupe ;
- un **bandeau** toujours au premier plan, à placer dans un coin : un clic sur un pseudo affiche sa fenêtre, la couronne (au survol) en fait le chef, 👥 copie les invitations de groupe, ⏸ coupe les raccourcis, ⤢ fait revenir l'organizer. Il peut s'ouvrir automatiquement quand on masque l'organizer ;
- une fenêtre sans cadre Windows qui prend juste la taille de son contenu (on la déplace par son en-tête), des textes d'aide qu'on peut masquer (?), un thème clair ou sombre.

Ce que l'outil ne fait **pas**, volontairement : pas de connexion des comptes, pas de lecture de la mémoire du jeu, pas d'injection, pas de lecture du réseau. Il gère seulement des fenêtres Windows, comme nAiO.

## Ne pas gêner le jeu

- **Rien ne tourne en boucle** côté Rust : Windows prévient l'organizer quand la fenêtre au premier plan change (`SetWinEventHook`), et il ne fait rien d'autre entre deux événements.
- L'interface ne relit la liste des fenêtres **que si elle est visible** : réduite ou cachée, elle ne fait rien.
- **Aucun appel ne peut rester bloqué** sur une fenêtre Dofus figée : on lit les titres avec `InternalGetWindowText` et on restaure une fenêtre avec `ShowWindowAsync`, qui n'attendent pas de réponse du jeu.
- **En cas de plantage**, il ne reste rien d'ouvert : le seul objet ouvert (pour lire le nom d'un processus) est refermé aussitôt, et Windows libère seul les raccourcis, le crochet clavier et la surveillance du premier plan.
- Le clavier est écouté sur **son propre thread** : même si l'interface est occupée, la frappe n'est jamais ralentie. Par défaut, ce sont les raccourcis Windows (`RegisterHotKey`). Avec l'option « distinguer gauche et droite », c'est un crochet clavier (`WH_KEYBOARD_LL`), installé seulement quand Dofus ou l'organizer est au premier plan, et qui laisse passer toutes les touches sauf nos combinaisons.

## Lancer le projet

Il faut [Rust](https://rustup.rs/), [Node.js](https://nodejs.org/) et les « Build Tools » C++ de Visual Studio.

```sh
npm install          # une seule fois : installe les outils de l'interface
npm run tauri dev    # lance l'application en mode développement
```

En mode dev, une modification de l'interface (`src/`, `index.html`, `pip.html`) s'affiche tout de suite. Une modification du code Rust (`src-tauri/src/`) relance automatiquement l'application après une recompilation.

Autres commandes utiles :

```sh
cd src-tauri && cargo test   # lance les tests automatiques de la partie Rust
npm run tauri build          # fabrique l'installateur final (src-tauri/target/release/bundle/)
```

## Comment c'est construit

L'application est en deux parties qui discutent entre elles :

```
┌────────────────────────────┐   invoke("commande", {...})   ┌───────────────────────────┐
│  Interface (TypeScript)    │ ────────────────────────────▶ │  Cœur (Rust)              │
│  index.html, pip.html,     │ ◀──────────────────────────── │  src-tauri/src/*.rs       │
│  src/*.ts                  │   réponse JSON, événements     │  Windows, config, touches │
└────────────────────────────┘                                └───────────────────────────┘
```

**Tauri** affiche l'interface (une page web) dans des fenêtres Windows et laisse le JavaScript appeler des fonctions Rust, appelées « commandes ». Rust fait tout ce qu'une page web n'a pas le droit de faire : lister les fenêtres des autres programmes, les mettre au premier plan, réserver des raccourcis pour tout le système. Dans l'autre sens, Rust envoie des **événements** à l'interface (`foreground-changed`, `shortcuts-paused-changed`).

Le code (noms de fichiers, de variables, de fonctions) est en anglais ; les commentaires et les textes affichés sont en français.

### Les fichiers, dans l'ordre où les lire

| Fichier | Rôle |
|---|---|
| `src-tauri/src/navigation.rs` | Logique pure : lire un titre de fenêtre, trier, choisir la fenêtre suivante. Le plus simple pour commencer, avec ses tests en bas. |
| `src-tauri/src/config.rs` | Le fichier de configuration JSON (ordre, sélection, chef, raccourcis). |
| `src-tauri/src/game_windows.rs` | Les appels à l'API Windows sur les fenêtres (code `unsafe` isolé ici). |
| `src-tauri/src/foreground.rs` | Être prévenu des changements de premier plan. |
| `src-tauri/src/combo.rs` | Lire une combinaison (« ControlLeft+Alt+KeyP ») et la comparer à l'état du clavier. Logique pure, testée. |
| `src-tauri/src/shortcuts.rs` | Les actions des raccourcis et la règle qui décide lesquels sont actifs. |
| `src-tauri/src/input.rs` | L'écoute du clavier sur son propre thread : raccourcis Windows ou crochet clavier. |
| `src-tauri/src/clipboard.rs` | Écrire dans le presse-papiers (marche aussi depuis le bandeau, qui n'a jamais le focus). |
| `src-tauri/src/lib.rs` | Relie le tout et définit les commandes appelables par l'interface. |
| `src/common.ts` | Ce qui sert aux deux fenêtres : types, préférences (thème, aide), taille automatique. |
| `src/classes.ts` | Les symboles de classe (images dans `public/classes/`). |
| `src/main.ts` | La fenêtre principale : liste, glisser-déposer, couronne, invitations, raccourcis, masquage. |
| `src/pip.ts` | Le bandeau : les pseudos cliquables. |
| `index.html`, `pip.html`, `src/styles.css` | La structure des deux fenêtres et leur apparence. |
| `src-tauri/tauri.conf.json` | Réglages de Tauri (fenêtres, nom, installateur). |
| `src-tauri/capabilities/default.json` | Les fonctions de Tauri que l'interface a le droit d'utiliser. |
| `src-tauri/Cargo.toml`, `package.json` | Les dépendances côté Rust et côté interface. |

### Notions Rust croisées dans le code

- **Possession et emprunt** : `String` (texte possédé) contre `&str` (texte emprunté), `&` pour prêter une valeur sans la donner. L'erreur E0716 (une valeur temporaire détruite trop tôt) se corrige en rangeant la valeur dans une variable : voir `toggle_pause_internal` dans `lib.rs`.
- **`Option` et `Result`** : Rust n'a ni `null` ni exceptions ; une valeur absente est `None`, une erreur est `Err(...)`, et le compilateur oblige à traiter ces cas.
- **`match`** et **`enum`** avec données : `Action::Character(String)` dans `shortcuts.rs`.
- **Itérateurs** : `iter().filter(...).map(...).collect()` pour transformer des listes.
- **`Mutex`** et **`OnceLock`** : partager une donnée entre plusieurs parties du programme sans conflit.
- **`unsafe`** et **`extern "system"`** : appeler Windows et être appelé par lui (`foreground.rs`).
- **`#[derive(...)]`** et **serde** : le compilateur écrit pour nous la conversion vers et depuis le JSON, y compris les anciens noms de champs (`alias`).

## Symboles de classe

Les images de `public/classes/` sont les symboles des classes de Dofus, récupérés sur DofusDB (`https://api.dofusdb.fr/img/breeds/symbol_N.png`, où N est le numéro de la classe dans le jeu) et réduits à 64 × 64 pixels. Ils sont inclus dans l'application : rien n'est téléchargé pendant qu'on joue. Ces symboles appartiennent à Ankama et ne sont utilisés ici que pour un usage personnel : ne pas redistribuer l'application telle quelle.

## Configuration

Fichier : `%APPDATA%\com.dofusorganizer.desktop\config.json` (ordre, cases cochées, chef, raccourcis). On peut le lire et le modifier à la main, application fermée. Les fichiers des premières versions (clés en français) sont toujours relus.

Les préférences d'affichage (thème, aide, position du bandeau, ouverture automatique du bandeau) sont gardées à part, dans le stockage du navigateur intégré.

Les raccourcis s'écrivent avec les noms de touches du web, séparés par `+` : des modificateurs (`Control`, `Alt`, `Shift`, `Super`, ou avec un côté : `ControlLeft`, `AltRight`, `ShiftLeft`, `MetaRight`…), puis une touche (`Tab`, `KeyP`, `Digit1`, `F2`, `ArrowRight`, `Backquote` pour la touche ²…). Exemple : `ControlLeft+Alt+KeyP`.

La touche est désignée par sa **position physique** (nom QWERTY) : `KeyQ` est la touche qui porte un A sur un clavier AZERTY. L'organizer la traduit selon la disposition active, et l'interface affiche ce qui est écrit sur la touche.

## Points à vérifier en jeu

- **Commande chaînée** : il reste à vérifier que le chat de Dofus accepte plusieurs `/invite` séparés par `; ` dans un seul message. Sinon, on changera `INVITE_SEPARATOR` dans `src/common.ts`, ou le fonctionnement du bouton.
- **Format des titres** : la détection suppose des titres comme `Perso - Classe - Version - Release`. Le numéro de version n'est jamais lu, donc une 3.10 ou une bêta passent sans changement. Si Dofus change le format lui-même, il faut ajuster `parse_title` dans `navigation.rs`.
- **Conflits de touches** : quand Dofus est au premier plan, un raccourci enregistré n'arrive plus au jeu. Choisissez des combinaisons que vous n'utilisez pas dans Dofus, ou coupez-les avec l'interrupteur.
