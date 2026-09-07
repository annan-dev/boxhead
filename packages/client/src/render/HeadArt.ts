/**
 * Heads for the characters the original art gives none.
 *
 * The SWF carries one head for every player (a skin box with a black hair
 * shape) and a separate clip for Bambo's bandana. Swat, Bond and GI Joe only
 * differ below the neck. These give each a head in the same idiom: flat
 * fills on a 1280-unit box face, no eyes, drawn as the box textures the rig
 * already swaps by name (`<Skin>_Head_<Face>`).
 *
 * Face layout, as the original's textures use it: `Front` is what the
 * character looks out of, `Side` shows the back of the head at x = 0 and
 * the face at x = 1280, and `Back` is the rear. y = 0 is the crown.
 */
import type { PathCommand, SubPath, Texture, TextureLayer } from '@boxhead/shared';

const SIZE = 1280;
const SKIN = 0xffcc99;

function poly(color: number, points: ReadonlyArray<readonly [number, number]>, alpha = 1): SubPath {
  const commands: PathCommand[] = points.map(([x, y], i) => ({ op: i === 0 ? 'M' : 'L', x, y }));
  const [x0, y0] = points[0]!;
  commands.push({ op: 'L', x: x0, y: y0 });
  return { color, alpha, commands };
}

function rect(color: number, x: number, y: number, w: number, h: number, alpha = 1): SubPath {
  return poly(color, [[x, y], [x + w, y], [x + w, y + h], [x, y + h]], alpha);
}

function texture(name: string, paths: SubPath[]): Texture {
  const layers: TextureLayer[] = [
    { matrix: [1, 0, 0, 1, 0, 0], paths: [rect(SKIN, 0, 0, SIZE, SIZE)] },
    { matrix: [1, 0, 0, 1, 0, 0], paths },
  ];
  return { name, bounds: { xMin: 0, yMin: 0, xMax: SIZE, yMax: SIZE }, layers };
}

// ---- Swat: navy helmet and a black visor ----------------------------------

const NAVY = 0x000033;
const VISOR = 0x101014;
const LENS = 0x2a3a4a;

const swat = {
  Swat_Head_Front: texture('Swat_Head_Front', [
    rect(NAVY, 0, 0, SIZE, 400),
    rect(VISOR, 0, 440, SIZE, 220),
    rect(LENS, 120, 490, 400, 120),
    rect(LENS, 760, 490, 400, 120),
    // Chin strap.
    rect(NAVY, 0, 1120, SIZE, 60),
  ]),
  Swat_Head_Side: texture('Swat_Head_Side', [
    rect(NAVY, 0, 0, SIZE, 400),
    // The helmet comes down over the back of the head.
    poly(NAVY, [[0, 400], [520, 400], [360, 900], [0, 960]]),
    rect(VISOR, 700, 440, 580, 220),
    rect(NAVY, 640, 1120, 640, 60),
  ]),
  Swat_Head_Back: texture('Swat_Head_Back', [
    rect(NAVY, 0, 0, SIZE, 960),
    rect(VISOR, 0, 440, SIZE, 80),
  ]),
};

// ---- Bond: black hair, slicked, with a parting -----------------------------

const HAIR = 0x0a0a0a;

const bond = {
  Bond_Head_Front: texture('Bond_Head_Front', [
    // Hairline with a parting on the character's right and a swept fringe.
    poly(HAIR, [[0, 0], [SIZE, 0], [SIZE, 200], [860, 200], [760, 300], [700, 200], [420, 200], [340, 280], [0, 240]]),
    // Sideburns.
    rect(HAIR, 0, 240, 100, 320),
    rect(HAIR, 1180, 200, 100, 320),
  ]),
  Bond_Head_Side: texture('Bond_Head_Side', [
    poly(HAIR, [[0, 0], [SIZE, 0], [SIZE, 200], [980, 200], [860, 560], [700, 560], [0, 900]]),
    // Sideburn in front of the ear.
    rect(HAIR, 1180, 200, 100, 340),
  ]),
  Bond_Head_Back: texture('Bond_Head_Back', [rect(HAIR, 0, 0, SIZE, 900)]),
};

// ---- GI Joe: camouflage helmet with a brim and strap -----------------------

const OLIVE = 0x4b5a2a;
const OLIVE_DARK = 0x33401c;
const TAN = 0x8a7a48;
const STRAP = 0x2a2a20;

function camo(x0: number, y0: number, x1: number, y1: number): SubPath[] {
  // A few blotches inside the helmet area, the same on every face so the
  // pattern wraps without a seam catching the eye.
  const w = x1 - x0;
  const h = y1 - y0;
  return [
    poly(OLIVE_DARK, [[x0 + w * 0.08, y0 + h * 0.15], [x0 + w * 0.34, y0 + h * 0.05], [x0 + w * 0.42, y0 + h * 0.5], [x0 + w * 0.18, y0 + h * 0.62]]),
    poly(TAN, [[x0 + w * 0.5, y0 + h * 0.2], [x0 + w * 0.8, y0 + h * 0.1], [x0 + w * 0.92, y0 + h * 0.45], [x0 + w * 0.62, y0 + h * 0.58]]),
    poly(OLIVE_DARK, [[x0 + w * 0.55, y0 + h * 0.62], [x0 + w * 0.82, y0 + h * 0.7], [x0 + w * 0.72, y0 + h * 0.95], [x0 + w * 0.48, y0 + h * 0.88]]),
    poly(TAN, [[x0 + w * 0.05, y0 + h * 0.72], [x0 + w * 0.3, y0 + h * 0.7], [x0 + w * 0.26, y0 + h * 0.96], [x0 + w * 0.02, y0 + h * 0.92]]),
  ];
}

const gijoe = {
  GIJOE_Head_Front: texture('GIJOE_Head_Front', [
    rect(OLIVE, 0, 0, SIZE, 400),
    ...camo(0, 0, SIZE, 400),
    // Brim.
    rect(OLIVE_DARK, 0, 380, SIZE, 70),
    // Chin strap down both cheeks and under the chin.
    rect(STRAP, 60, 450, 70, 700),
    rect(STRAP, 1150, 450, 70, 700),
    rect(STRAP, 60, 1120, 1160, 60),
  ]),
  GIJOE_Head_Side: texture('GIJOE_Head_Side', [
    rect(OLIVE, 0, 0, SIZE, 400),
    ...camo(0, 0, SIZE, 400),
    // The helmet shell covers the back of the head.
    poly(OLIVE, [[0, 400], [560, 400], [420, 760], [0, 800]]),
    ...camo(0, 400, 480, 780),
    rect(OLIVE_DARK, 0, 380, SIZE, 70),
    // Strap from the brim, past the ear, to the chin.
    poly(STRAP, [[820, 450], [900, 450], [960, 1160], [880, 1160]]),
    rect(STRAP, 880, 1120, 400, 60),
  ]),
  GIJOE_Head_Back: texture('GIJOE_Head_Back', [
    rect(OLIVE, 0, 0, SIZE, 800),
    ...camo(0, 0, SIZE, 760),
    rect(OLIVE_DARK, 0, 380, SIZE, 70),
    rect(STRAP, 0, 1120, SIZE, 60),
  ]),
};

/**
 * The rig also carries flat-coloured hair and headband geometry over the head
 * box, so a helmet or hairstyle needs those recoloured to match, or the
 * brown hair cap sits on top of it. Keyed by the rig's material names.
 */
export const CHARACTER_PALETTES: Record<string, Record<string, number>> = {
  swat: { Hair: NAVY, Bandana: VISOR },
  bond: { Hair: HAIR, Bandana: HAIR },
  gijoe: { Hair: OLIVE, Bandana: STRAP },
};

/** Textures to add to the art pack, keyed by name, where the pack has none. */
export const CHARACTER_HEADS: Record<string, Texture> = { ...swat, ...bond, ...gijoe };

/** Add the drawn heads to a pack that lacks them. */
export function addCharacterHeads(textures: Record<string, Texture>): void {
  for (const [name, art] of Object.entries(CHARACTER_HEADS)) {
    if (!textures[name]) textures[name] = art;
  }
}
