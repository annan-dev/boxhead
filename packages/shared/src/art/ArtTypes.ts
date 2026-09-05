/**
 * Shape of the art pack produced by @boxhead/extract and consumed by the
 * renderer. Geometry is 2D polygons already projected at the original 45-degree
 * camera tilt, one set per facing direction and animation frame.
 */

export interface Material {
  /** Flat fill colour as 0xRRGGBB, when the face is a solid colour. */
  color?: number;
  /** Opacity, 0-1. */
  alpha?: number;
  /** Exported MovieClip symbol used as a textured face, e.g. "Head_Front_MC". */
  clip?: string;
  size?: [number, number];
}

export interface Face {
  /** Flat polygon: [x0,y0, x1,y1, ...]. Usually a quad or a triangle. */
  poly: number[];
  /** Index into the clip's material table; -1 when unresolved. */
  mat: number;
  /** Flash-style brightness, roughly -1..1, applied to the material colour. */
  bright: number;
  /** Texture transform [a,b,c,d,tx,ty] for clip-backed faces. */
  matrix?: [number, number, number, number, number, number];
}

export interface Part {
  name: string;
  /** Height in model space; more negative is higher up. */
  z: number;
  faces: Face[];
  /** Ambient-occlusion polygons drawn over the faces. */
  shadow: number[][];
  /** Silhouette outline, stroked dark. */
  outline: number[][];
}

export interface Pose {
  /** Already ordered back-to-front. */
  parts: Part[];
}

export interface Clip {
  /** "Group/Anim", e.g. "Player/Walk". */
  id: string;
  group: string;
  anim: string;
  /** Camera tilt in degrees; 45 throughout the original. */
  tilt: number;
  light: [number, number, number];
  /** Playback order, e.g. [1,2,3,4,3,2,1,0] for a ping-pong walk cycle. */
  sequence: number[] | null;
  materialNames: string[];
  materials: Material[];
  directions: number;
  frames: number;
  /** poses[direction][frame] */
  poses: Pose[][];
}

export interface ArtPack {
  version: 1;
  source: { file: string; sha256: string; frameRate: number };
  clips: Clip[];
  /** Face textures keyed by the material's `clip` symbol, e.g. "Head_Front_MC". */
  textures: Record<string, Texture>;
}

/** Path commands in twips, matching canvas semantics. */
export type PathCommand =
  | { op: 'M'; x: number; y: number }
  | { op: 'L'; x: number; y: number }
  | { op: 'Q'; cx: number; cy: number; x: number; y: number };

export interface SubPath {
  /** 0xRRGGBB. */
  color: number;
  alpha: number;
  commands: PathCommand[];
}

export interface TextureLayer {
  /** Affine transform [a,b,c,d,tx,ty] applied to this layer's paths. */
  matrix: [number, number, number, number, number, number];
  paths: SubPath[];
}

/**
 * Printed detail for a character's box face, e.g. the face on Head_Front.
 * Coordinates are in the source clip's own space; `bounds` normalises them.
 */
export interface Texture {
  name: string;
  bounds: { xMin: number; yMin: number; xMax: number; yMax: number };
  layers: TextureLayer[];
}
