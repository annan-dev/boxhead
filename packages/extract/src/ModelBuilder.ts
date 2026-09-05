/**
 * Turns the raw decoded AVM1 object graph into a compact, renderer-friendly
 * art pack.
 *
 * The source shape, per animation clip, is:
 *
 *   { mXSIInfo:  { mLight: {mX,mY,mZ}, mTilt: 45 },
 *     mMaterials:{ <name>: {mColor,mAlpha} | {mcLinkID,mSize} },
 *     mRotations:[direction][frame] -> { Models: { <part>: PartData } } }
 *
 * and each PartData carries parallel arrays: `Shape_vList` (one polygon per
 * face), `Shape_Material` (material name per face), `Shape_Brightness` (shading
 * factor per face) and `Shape_Matrix` (texture transform, or 0 for flat fills),
 * plus `Shadow` overlay polygons, a `PEdge` outline and a 3D `vPosition`.
 */
import type { Avm1Object, Avm1Value } from './swf/Avm1Decoder.js';

import type {
  ArtPack,
  Clip,
  Face,
  Material,
  Part,
  Pose,
} from '@boxhead/shared';

export type { ArtPack, Clip, Face, Material, Part, Pose };

const asObject = (v: Avm1Value): Avm1Object | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Avm1Object) : null;
const asArray = (v: Avm1Value): Avm1Value[] => (Array.isArray(v) ? v : []);
const asNumber = (v: Avm1Value, fallback = 0): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/**
 * Flat coordinate list, rounded to whole model units.
 *
 * The source projects "up" along -X, so every polygon is rotated a quarter turn
 * here -- (x, y) -> (-y, x) -- to land in screen orientation with -Y up. Baking
 * it at export time keeps the renderer a straight 2D fill.
 */
function toPolygon(v: Avm1Value): number[] {
  const flat = asArray(v);
  const out: number[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    const x = asNumber(flat[i]);
    const y = asNumber(flat[i + 1]);
    out.push(Math.round(-y), Math.round(x));
  }
  return out;
}

function toPolygonList(v: Avm1Value): number[][] {
  return asArray(v)
    .map(toPolygon)
    .filter((p) => p.length >= 6);
}

function buildMaterials(raw: Avm1Object | null): {
  names: string[];
  materials: Material[];
  index: Map<string, number>;
} {
  const names: string[] = [];
  const materials: Material[] = [];
  const index = new Map<string, number>();
  if (!raw) return { names, materials, index };

  for (const [name, value] of Object.entries(raw)) {
    const def = asObject(value);
    const mat: Material = {};
    if (def) {
      if (typeof def.mColor === 'number') mat.color = def.mColor;
      if (typeof def.mAlpha === 'number') mat.alpha = def.mAlpha / 100;
      if (typeof def.mcLinkID === 'string') mat.clip = def.mcLinkID;
      const size = asObject(def.mSize);
      if (size) mat.size = [asNumber(size.x, 64), asNumber(size.y, 64)];
    }
    index.set(name, names.length);
    names.push(name);
    materials.push(mat);
  }
  return { names, materials, index };
}

function buildPart(name: string, raw: Avm1Object, matIndex: Map<string, number>): Part | null {
  if (raw.Empty === true) return null;

  const polys = asArray(raw.Shape_vList);
  const mats = asArray(raw.Shape_Material);
  const brights = asArray(raw.Shape_Brightness);
  const matrices = asArray(raw.Shape_Matrix);

  const faces: Face[] = [];
  for (let i = 0; i < polys.length; i++) {
    const poly = toPolygon(polys[i]);
    if (poly.length < 6) continue;
    const matName = String(mats[i] ?? '');
    const face: Face = {
      poly,
      mat: matIndex.get(matName) ?? -1,
      bright: Math.round(asNumber(brights[i]) * 100) / 100,
    };
    const m = asObject(matrices[i]);
    if (m) {
      face.matrix = [
        asNumber(m.a),
        asNumber(m.b),
        asNumber(m.c),
        asNumber(m.d),
        asNumber(m.tx),
        asNumber(m.ty),
      ];
    }
    faces.push(face);
  }

  const position = asObject(asObject(raw.XSIInfo)?.vPosition ?? null);
  return {
    name,
    z: Math.round(asNumber(position?.mZ) * 10) / 10,
    faces,
    shadow: toPolygonList(raw.Shadow),
    outline: toPolygonList(raw.PEdge),
  };
}

function buildPose(raw: Avm1Value, matIndex: Map<string, number>): Pose {
  const models = asObject(asObject(raw)?.Models ?? null);
  if (!models) return { parts: [] };

  // AVM1 `for...in` walks properties newest-first, so the original renderer saw
  // these in reverse insertion order -- which is the painter's order here
  // (feet, then body, then head). Preserve that.
  const parts: Part[] = [];
  for (const [name, value] of Object.entries(models).reverse()) {
    const partRaw = asObject(value);
    if (!partRaw) continue;
    const part = buildPart(name, partRaw, matIndex);
    if (part && (part.faces.length > 0 || part.outline.length > 0)) parts.push(part);
  }
  return { parts };
}

export function buildClip(item: Avm1Object): Clip | null {
  const xsi = asObject(item.mXSI);
  if (!xsi) return null;

  const group = String(item.mGroupID ?? 'Unknown');
  const anim = String(item.mAnimID ?? 'Unknown');
  const info = asObject(xsi.mXSIInfo);
  const lightRaw = asObject(info?.mLight ?? null);
  const { names, materials, index } = buildMaterials(asObject(xsi.mMaterials));

  const rotations = asArray(xsi.mRotations);
  const poses: Pose[][] = rotations.map((frames) =>
    asArray(frames).map((pose) => buildPose(pose, index)),
  );

  const sequenceRaw = item.mFrameSquence; // sic -- the original's spelling
  const sequence = Array.isArray(sequenceRaw)
    ? sequenceRaw.map((n) => asNumber(n)).filter((n) => Number.isInteger(n))
    : null;

  return {
    id: `${group}/${anim}`,
    group,
    anim,
    tilt: asNumber(info?.mTilt, 45),
    light: [asNumber(lightRaw?.mX), asNumber(lightRaw?.mY), asNumber(lightRaw?.mZ)],
    sequence: sequence && sequence.length > 0 ? sequence : null,
    materialNames: names,
    materials,
    directions: poses.length,
    frames: poses[0]?.length ?? 0,
    poses,
  };
}

export interface ClipValidation {
  ok: boolean;
  problems: string[];
  stats: { clips: number; poses: number; parts: number; faces: number; vertices: number };
}

/** Structural checks that would catch a misaligned decode. */
export function validate(pack: ArtPack): ClipValidation {
  const problems: string[] = [];
  const stats = { clips: pack.clips.length, poses: 0, parts: 0, faces: 0, vertices: 0 };

  if (pack.clips.length === 0) problems.push('no clips decoded');

  for (const clip of pack.clips) {
    if (clip.directions === 0) problems.push(`${clip.id}: no directions`);
    for (const [d, frames] of clip.poses.entries()) {
      if (frames.length !== clip.frames) {
        problems.push(`${clip.id}: direction ${d} has ${frames.length} frames, expected ${clip.frames}`);
      }
      for (const pose of frames) {
        stats.poses += 1;
        if (pose.parts.length === 0) problems.push(`${clip.id}: empty pose at direction ${d}`);
        for (const part of pose.parts) {
          stats.parts += 1;
          for (const face of part.faces) {
            stats.faces += 1;
            stats.vertices += face.poly.length / 2;
            if (face.poly.length % 2 !== 0) {
              problems.push(`${clip.id}/${part.name}: odd coordinate count`);
            }
            if (face.mat < 0 || face.mat >= clip.materials.length) {
              problems.push(`${clip.id}/${part.name}: unresolved material index ${face.mat}`);
            }
          }
        }
      }
    }
    if (clip.sequence) {
      for (const frame of clip.sequence) {
        if (frame < 0 || frame >= clip.frames) {
          problems.push(`${clip.id}: sequence references frame ${frame} of ${clip.frames}`);
        }
      }
    }
  }

  // Report each distinct problem once; a systematic fault would otherwise
  // produce thousands of identical lines.
  const unique = [...new Set(problems)];
  return { ok: unique.length === 0, problems: unique.slice(0, 25), stats };
}
