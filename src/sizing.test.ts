// Tests des calculs de taille (sizing.ts) : `npm test`.
//
// Ils reproduisent les situations où un bord du bandeau (ou de la fenêtre
// principale) pouvait être coupé, ou une colonne perdue, à cause d'une
// taille de fenêtre légèrement différente de celle du contenu.

import { describe, expect, it } from "vitest";
import {
  clampLines,
  extentOf,
  linesIn,
  matchesAny,
  nextRequest,
  resizeWindow,
  Size,
  SizableWindow,
  toCss,
  toPhysical,
} from "./sizing";

/**
 * Une fausse fenêtre Windows : elle donne `shortBy` pixels de moins que
 * demandé (une bordure invisible mal estimée), sans descendre sous
 * `minimum`. `minimized` : réduite dans la barre des tâches (taille nulle).
 */
function fakeWindow(options: { shortBy?: Size; minimum?: Size; minimized?: boolean } = {}) {
  const shortBy = options.shortBy ?? { width: 0, height: 0 };
  const minimum = options.minimum ?? { width: 1, height: 1 };
  let inner: Size = { width: 240, height: 40 };
  const requests: Size[] = [];
  const win: SizableWindow = {
    setInnerSize: (size) => {
      requests.push(size);
      inner = {
        width: Math.max(minimum.width, size.width - shortBy.width),
        height: Math.max(minimum.height, size.height - shortBy.height),
      };
      return Promise.resolve();
    },
    innerSize: () => Promise.resolve(options.minimized ? { width: 0, height: 0 } : inner),
  };
  return { win, requests, inner: () => inner };
}

describe("toPhysical", () => {
  it("ne perd jamais un pixel du contenu, quel que soit le zoom de l'écran", () => {
    for (const ratio of [1, 1.25, 1.5, 1.75, 2, 2.25]) {
      for (const css of [100, 100.4, 100.5, 100.9, 351.3, 33.6]) {
        const physical = toPhysical({ width: css, height: css }, ratio);
        expect(physical.width / ratio).toBeGreaterThanOrEqual(css);
        // ...et n'en ajoute pas plus d'un.
        expect(physical.width - css * ratio).toBeLessThan(1);
      }
    }
  });

  it("arrondit au-dessus (l'ancien calcul arrondissait au plus proche, parfois en dessous)", () => {
    // 101 pixels logiques × 1.25 = 126.25, arrondi à 126 : 100.8 pixels CSS
    // pour un contenu de 100.9.
    expect(toPhysical({ width: 100.9, height: 33.6 }, 1.25)).toEqual({ width: 127, height: 42 });
  });

  it("ignore les imprécisions de calcul", () => {
    // 33.6 × 1.25 vaut 42.00000000000001 en virgule flottante.
    expect(toPhysical({ width: 33.6, height: 33.6 }, 1.25).height).toBe(42);
  });

  it("revient aux pixels CSS avec toCss", () => {
    expect(toCss({ width: 300, height: 60 }, 1.5)).toEqual({ width: 200, height: 40 });
  });
});

describe("nextRequest", () => {
  it("ne redemande rien quand la taille est atteinte", () => {
    const target = { width: 400, height: 34 };
    expect(nextRequest(target, target, target)).toBeNull();
  });

  it("reporte l'écart quand Windows donne moins que demandé", () => {
    const target = { width: 400, height: 34 };
    const obtained = { width: 384, height: 26 };
    expect(nextRequest(target, target, obtained)).toEqual({ width: 416, height: 42 });
  });

  it("reporte l'écart quand Windows donne plus que demandé", () => {
    const target = { width: 400, height: 34 };
    expect(nextRequest(target, target, { width: 410, height: 34 })).toEqual({
      width: 390,
      height: 34,
    });
  });

  it("ne corrige pas une fenêtre réduite (taille nulle)", () => {
    const target = { width: 400, height: 34 };
    expect(nextRequest(target, target, { width: 0, height: 0 })).toBeNull();
  });
});

describe("resizeWindow", () => {
  it("bandeau horizontal : les derniers boutons restent visibles malgré une bordure mal estimée", async () => {
    // Le cas signalé : Windows donne 16 pixels de moins en largeur (deux
    // bordures invisibles de 8 pixels) et 8 en hauteur.
    const target = { width: 412, height: 34 };
    const fake = fakeWindow({ shortBy: { width: 16, height: 8 } });
    const obtained = await resizeWindow(fake.win, target);
    expect(obtained).toEqual(target);
    expect(fake.inner()).toEqual(target);
  });

  it("bandeau vertical : les boutons du bas restent visibles", async () => {
    const target = { width: 120, height: 260 };
    const fake = fakeWindow({ shortBy: { width: 0, height: 9 } });
    expect(await resizeWindow(fake.win, target)).toEqual(target);
  });

  it("ne fait qu'une demande quand Windows donne la bonne taille", async () => {
    const fake = fakeWindow();
    await resizeWindow(fake.win, { width: 300, height: 34 });
    expect(fake.requests).toHaveLength(1);
  });

  it("abandonne après quelques essais si Windows refuse (taille minimale)", async () => {
    const fake = fakeWindow({ minimum: { width: 1, height: 39 } });
    const obtained = await resizeWindow(fake.win, { width: 300, height: 34 });
    expect(fake.requests.length).toBeLessThanOrEqual(3);
    expect(obtained.height).toBe(39);
  });

  it("ne s'emballe pas sur une fenêtre réduite", async () => {
    const fake = fakeWindow({ minimized: true });
    await resizeWindow(fake.win, { width: 300, height: 34 });
    expect(fake.requests).toEqual([{ width: 300, height: 34 }]);
  });
});

describe("matchesAny", () => {
  it("reconnaît une taille proche à deux pixels près", () => {
    const sizes = [{ width: 400, height: 34 }];
    expect(matchesAny({ width: 401, height: 33 }, sizes)).toBe(true);
    expect(matchesAny({ width: 416, height: 34 }, sizes)).toBe(false);
  });
});

describe("linesIn", () => {
  // Un pseudo de 100.3 pixels de large : deux colonnes et l'écart font 204.6.
  const item = 100.3;
  const twoColumns = extentOf(2, item);

  it("compte les colonnes qui tiennent", () => {
    expect(linesIn(twoColumns, item)).toBe(2);
    expect(linesIn(twoColumns + item + 4, item)).toBe(3);
    expect(linesIn(item, item)).toBe(1);
  });

  it("ne perd pas une colonne quand la largeur de la fenêtre est arrondie en dessous", () => {
    // `innerWidth` ou `offsetWidth` donnent 204 (ou 204.1) au lieu de 204.6 :
    // l'ancien calcul trouvait une seule colonne, et le bandeau (ou son
    // aperçu, d'un simple clic sur la poignée) perdait sa deuxième colonne.
    expect(linesIn(Math.floor(twoColumns), item)).toBe(2);
    expect(linesIn(twoColumns - 0.5, item)).toBe(2);
  });

  it("ne compte pas une colonne qui ne tient clairement pas", () => {
    expect(linesIn(twoColumns - 3, item)).toBe(1);
  });

  it("donne zéro quand rien ne tient (borné ensuite par clampLines)", () => {
    expect(linesIn(10, 24)).toBe(0);
    expect(clampLines(5, linesIn(10, 24))).toBe(1);
  });

  it("bandeau horizontal sur une rangée : les boutons restent sur une rangée", () => {
    // Pseudos de 24 pixels de haut, boutons de 18.8 : une seule rangée de
    // boutons tient à côté d'une rangée de pseudos.
    expect(linesIn(extentOf(1, 24), 18.8)).toBe(1);
    // Deux rangées de pseudos (52 pixels) : deux rangées de boutons.
    expect(linesIn(extentOf(2, 24), 18.8)).toBe(2);
  });
});

describe("clampLines", () => {
  it("borne entre 1 et le nombre d'éléments", () => {
    expect(clampLines(3, 5)).toBe(3);
    expect(clampLines(3, 0)).toBe(1);
    expect(clampLines(0, 2)).toBe(1);
    expect(clampLines(4, 2)).toBe(2);
  });
});
