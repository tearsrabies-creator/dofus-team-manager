// Les illustrations de classe : le symbole officiel de chaque classe.
//
// Les images viennent de DofusDB (https://api.dofusdb.fr/img/breeds/symbol_N.png,
// N étant le numéro de la classe dans le jeu), réduites à 64 × 64 pixels et
// rangées dans `public/classes/`. Tout ce qui est dans `public/` est servi tel
// quel à la racine de l'application : `public/classes/iop.png` s'affiche donc
// avec l'adresse `/classes/iop.png`. Elles sont incluses dans l'application :
// aucune connexion à internet n'est nécessaire pour les afficher.
//
// Ces symboles appartiennent à Ankama : ils ne servent ici que pour un usage
// personnel.

// Les 19 classes de Dofus 3 : nom « normalisé » (voir `normalize`), qui est
// aussi le nom du fichier image, → nom affiché au survol.
const CLASSES: Record<string, string> = {
  feca: "Féca",
  osamodas: "Osamodas",
  enutrof: "Enutrof",
  sram: "Sram",
  xelor: "Xélor",
  ecaflip: "Ecaflip",
  eniripsa: "Eniripsa",
  iop: "Iop",
  cra: "Crâ",
  sadida: "Sadida",
  sacrieur: "Sacrieur",
  pandawa: "Pandawa",
  roublard: "Roublard",
  zobal: "Zobal",
  steamer: "Steamer",
  eliotrope: "Eliotrope",
  huppermage: "Huppermage",
  ouginak: "Ouginak",
  forgelance: "Forgelance",
};

// Les noms anglais du jeu, ramenés aux noms français ci-dessus.
const ENGLISH_NAMES: Record<string, string> = {
  sacrier: "sacrieur",
  rogue: "roublard",
  masqueraider: "zobal",
  foggernaut: "steamer",
};

/**
 * « Xélor », « XELOR » ou « xelor » donnent tous « xelor » : on retire les
 * accents (`normalize("NFD")` sépare la lettre de son accent, puis on efface
 * les accents), les majuscules et tout ce qui n'est pas une lettre.
 */
function normalize(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
}

/** Le nom de fichier d'une classe connue (« xelor »), ou `null` si inconnue. */
function findClass(className: string): string | null {
  const key = normalize(className);
  const resolved = ENGLISH_NAMES[key] ?? key;
  return resolved in CLASSES ? resolved : null;
}

/**
 * Fabrique la pastille d'une classe. `className` vaut `null` pour une
 * fenêtre pas encore connectée : pastille grise et neutre.
 */
export function classBadge(className: string | null): HTMLSpanElement {
  const badge = document.createElement("span");
  badge.className = "class-badge";
  const key = className ? findClass(className) : null;
  if (key) {
    const image = document.createElement("img");
    image.src = `/classes/${key}.png`;
    image.alt = ""; // décoratif : le nom de la classe est déjà écrit à côté
    image.draggable = false; // sinon le navigateur permet de « tirer » l'image
    badge.append(image);
    badge.title = CLASSES[key];
  } else {
    // Classe inconnue : sa première lettre ; pas de classe : des points.
    badge.textContent = className ? className[0].toUpperCase() : "…";
    badge.classList.add("unknown");
    badge.title = className ?? "Non connectée";
  }
  badge.setAttribute("aria-hidden", "true");
  return badge;
}
