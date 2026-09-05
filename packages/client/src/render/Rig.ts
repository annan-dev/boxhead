/**
 * Character composition.
 *
 * The original does not ship one model per character type. It ships a base body
 * rig ("Player") plus overlays that replace parts of it:
 *
 *   Player              feet, arms, hands, body, head  (the base)
 *   Zombie / Devil      a Head that replaces the base head
 *   Player_Alternate1   an alternate head and feet
 *   Player_<Weapon>     right arm, hand and the weapon itself
 *
 * Composing them means merging part lists by name while preserving each
 * layer's own back-to-front ordering, so a shotgun's barrel still sorts between
 * the hand and the forearm.
 */
import type { Clip, Part, Pose } from '@boxhead/shared';
import { getPose } from './VectorModel.js';

/** A marker part, not drawn: its centroid is where shots leave the weapon. */
export const MUZZLE_PART = 'GunPosition_Right';

export interface Layer {
  clip: Clip;
  direction: number;
  frame: number;
}

export interface ComposedPart {
  part: Part;
  /** The clip the part came from; materials are resolved against it. */
  clip: Clip;
}

export interface ComposedPose {
  parts: ComposedPart[];
  /** Muzzle position in model units, when a weapon layer supplied one. */
  muzzle: { x: number; y: number } | null;
}

function centroid(part: Part): { x: number; y: number } | null {
  let sumX = 0;
  let sumY = 0;
  let count = 0;
  for (const face of part.faces) {
    for (let i = 0; i < face.poly.length - 1; i += 2) {
      sumX += face.poly[i]!;
      sumY += face.poly[i + 1]!;
      count += 1;
    }
  }
  return count === 0 ? null : { x: sumX / count, y: sumY / count };
}

/**
 * Merge layers into a single ordered part list.
 *
 * Overlay parts that exist in the base replace it in place; parts that do not
 * (a weapon, a muzzle marker) are inserted around them so the overlay's
 * internal ordering survives the merge.
 */
export function composePose(layers: Layer[]): ComposedPose {
  const parts: ComposedPart[] = [];
  const indexOf = new Map<string, number>();
  let muzzle: { x: number; y: number } | null = null;

  for (const layer of layers) {
    const pose: Pose | null = getPose(layer.clip, layer.direction, layer.frame);
    if (!pose) continue;

    // Anchor the insertion cursor at the first part this layer shares with what
    // is already composed, so brand-new parts land beside their own limbs
    // rather than at the front of the character.
    let cursor = parts.length;
    for (const part of pose.parts) {
      const existing = indexOf.get(part.name);
      if (existing !== undefined) {
        cursor = existing;
        break;
      }
    }

    for (const part of pose.parts) {
      if (part.name === MUZZLE_PART) {
        muzzle = centroid(part) ?? muzzle;
        continue; // an anchor, never drawn
      }
      const existing = indexOf.get(part.name);
      if (existing !== undefined) {
        parts[existing] = { part, clip: layer.clip };
        cursor = existing + 1;
      } else {
        parts.splice(cursor, 0, { part, clip: layer.clip });
        cursor += 1;
        // Splicing shifts everything after the insertion point.
        indexOf.clear();
        for (const [i, entry] of parts.entries()) indexOf.set(entry.part.name, i);
      }
    }
    for (const [i, entry] of parts.entries()) indexOf.set(entry.part.name, i);
  }

  return { parts, muzzle };
}

/** Named lookup over the art pack, e.g. clipOf("Player", "Walk"). */
export class ClipIndex {
  private readonly byId = new Map<string, Clip>();

  constructor(clips: Clip[]) {
    for (const clip of clips) this.byId.set(clip.id, clip);
  }

  get(group: string, anim: string): Clip | null {
    return this.byId.get(`${group}/${anim}`) ?? null;
  }

  /** First matching animation for a group, trying each name in order. */
  first(group: string, anims: string[]): Clip | null {
    for (const anim of anims) {
      const clip = this.get(group, anim);
      if (clip) return clip;
    }
    return null;
  }
}
