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
  /** World art keyed by its exported symbol, e.g. "Piece.Wall1". */
  sprites: Record<string, SpriteArt>;
  /** The original arenas, in order. */
  rooms: ExtractedRoom[];
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

export interface SpriteFrame {
  layers: TextureLayer[];
}

/**
 * World art extracted from an exported MovieClip: wall blocks, barrels,
 * pickups, explosions. Multi-frame symbols keep every frame, which is where
 * the explosion animation and the wall damage states come from.
 */
export interface SpriteArt {
  name: string;
  bounds: { xMin: number; yMin: number; xMax: number; yMax: number };
  frames: SpriteFrame[];
}

/** A solid block in an arena: a footprint on the ground plus its height. */
export interface RoomBlock {
  /** Source symbol, e.g. "Piece.WallPost". */
  symbol: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** How far the block rises off the floor, in world pixels. */
  rise: number;
}

/** An arena extracted from the original, with real geometry and spawn points. */
export interface ExtractedRoom {
  id: string;
  index: number;
  name: string;
  /** Collision grid size in world pixels. */
  cell: number;
  width: number;
  height: number;
  cols: number;
  rows: number;
  /** Row-major; 0 floor, 1 solid. */
  tiles: number[];
  blocks: RoomBlock[];
  /** Ground art, already positioned in world space. */
  floor: SpriteFrame;
  /**
   * Extent of the painted floor in world pixels. Play happens inside it, the
   * camera never looks past it, and anything outside is void.
   */
  floorBounds: { x: number; y: number; w: number; h: number };
  spawns: {
    players: Array<{ x: number; y: number }>;
    zombies: Array<{ x: number; y: number }>;
    devils: Array<{ x: number; y: number }>;
    barrels: Array<{ x: number; y: number }>;
    pickups: Array<{ x: number; y: number }>;
    walls: Array<{ x: number; y: number }>;
  };
}
