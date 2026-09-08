/**
 * Heads-up display, drawn in screen space over the world.
 *
 * Laid out the way a modern shooter lays it out: the loadout in the bottom
 * right (the two weapon slots and the grenade), the squad's health bars in
 * the bottom left, a minimap in the top left, and the original's score and
 * multiplier panel in the top right with the multiplier's drain bar under
 * it. Each player's health is also a small bar just above their head, as the
 * original drew it. The look is the menus': dark slabs with a brass
 * hairline, bone type, blood red for anything that matters.
 *
 * A few things here are animated for the eye only -- the multiplier pops
 * when it climbs, the drain bar flickers before it drops, the screen beats
 * red when health is low -- and all of it is derived from the world each
 * frame, never written back.
 */
import {
  CHARACTERS,
  WEAPONS,
  levelDef,
  nextAward,
  statsFor,
  Tile,
  type Player,
  type WeaponId,
  type World,
} from '@boxhead/shared';
import type { Camera } from '../render/Camera.js';
import type { HoldAction } from '../input/Input.js';
import { PING_LIFE, PING_STYLES, drawGlyph, squadColour, type Ping } from './Pings.js';
import { drawWeaponIcon } from './WeaponIcons.js';

/** How much arena the minimap shows across its width, in world pixels. */
const MINIMAP_SPAN = 560;

const DISPLAY = '"Anton", Impact, "Arial Black", "Segoe UI Black", sans-serif';
const BODY = '"Segoe UI", system-ui, -apple-system, Roboto, Helvetica, Arial, sans-serif';

const SLAB = 'rgba(12,12,15,0.86)';
const SLAB_EDGE = 'rgba(0,0,0,0.75)';
const BRASS = 'rgba(201,167,90,0.55)';
const BRASS_BRIGHT = '#e6cf94';
const BONE = '#e9e2d0';
const BONE_DIM = '#a39c8c';
const MUTED = '#6f6a5f';
const RED = '#e0111f';
const RED_HI = '#ff3040';
const AMBER = '#f0b21a';
const INK_SHADOW = 'rgba(0,0,0,0.85)';

/** Frames the multiplier stays swollen after climbing. */
const POP_FRAMES = 14;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One choice on a wheel. */
export interface WheelOption {
  id: string;
  label: string;
  /** A second line: ammo, or a key. */
  sub: string;
  colour?: string;
  /** Shown but not choosable: an empty gun, say. */
  disabled?: boolean;
}

export interface WheelView {
  kind: HoldAction;
  title: string;
  options: WheelOption[];
  /** Index the pointer points at, or -1 in the dead zone. */
  hovered: number;
}

export interface Loadout {
  primary: WeaponId;
  secondary: WeaponId | null;
}

export class Hud {
  private lastMultiplier = 1;
  private pop = 0;
  private lastLevel = 0;
  /** Player's HUD size preference, 0.8-1.4. */
  sizeScale = 1;
  /** Outlined markers and a framed heartbeat, so nothing rests on colour alone. */
  highContrast = false;
  /** Partner rings drawn on the last frame, for the harness. */
  partnerMarkers = 0;
  /** The two slots as the player has them; the world only knows what is in hand. */
  loadout: Loadout = { primary: 'pistol', secondary: null };
  /** Marks on the arena, newest last. */
  pings: Ping[] = [];
  /** The wheel that is up, if any. */
  wheel: WheelView | null = null;
  /** A character's head at a size, for the squad bars; null draws an initial instead. */
  portraitOf: (characterId: string, size: number) => HTMLCanvasElement | null = () => null;
  /** The key caps to show on the loadout and wheel. */
  keys: { primary: string; secondary: string; grenade: string; ping: string } = { primary: '1', secondary: '2', grenade: 'G', ping: 'F' };
  /** Panels drawn this frame, so the threat markers keep clear of them. */
  private reserved: Rect[] = [];
  private lastReserved: Rect[] = [];
  /** The minimap's picture of the arena, redrawn when the arena changes. */
  private minimapCanvas: HTMLCanvasElement | null = null;
  private minimapRevision = -1;
  private minimapScale = 0;

  /**
   * Where the panels go at a canvas size: the loadout's two cards and the
   * grenade chip in the bottom right, the squad in the bottom left, the
   * minimap in the top left. One place, so the drawing and the tests agree.
   */
  static layout(width: number, height: number, s: number): { primary: Rect; secondary: Rect; grenade: Rect; squad: Rect; minimap: Rect } {
    const margin = 14 * s;
    const cardH = 56 * s;
    const primaryW = Math.min(158 * s, width * 0.22);
    const secondaryW = Math.min(122 * s, width * 0.18);
    const gap = 6 * s;
    const secondary = { x: width - margin - secondaryW, y: height - margin - cardH, w: secondaryW, h: cardH };
    const primary = { x: secondary.x - gap - primaryW, y: secondary.y, w: primaryW, h: cardH };
    const grenade = { x: primary.x - gap - 54 * s, y: secondary.y + 10 * s, w: 54 * s, h: cardH - 10 * s };
    const squadW = Math.min(196 * s, width * 0.26);
    const squad = { x: margin, y: height - margin - 30 * s, w: squadW, h: 30 * s };
    const minimap = { x: 12 * s, y: 10 * s, w: Math.min(172 * s, width * 0.24), h: Math.min(118 * s, height * 0.24) };
    return { primary, secondary, grenade, squad, minimap };
  }

  constructor(
    private readonly world: World,
    /** Whose loadout and health the corners show. */
    private readonly localPlayerIndex = 0,
    /** Name over a player, for networked play; null draws nothing. */
    private readonly nameOf: (playerIndex: number) => string | null = () => null,
  ) {
    this.lastMultiplier = world.multiplier;
    this.lastLevel = world.level;
  }

  draw(
    ctx: CanvasRenderingContext2D,
    camera: Camera,
    /** Pointer in canvas pixels while the mouse aims; null when a pad does. */
    pointer: { x: number; y: number } | null = null,
  ): void {
    const world = this.world;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';

    // Screen-space UI is laid out against a nominal height so it stays the same
    // apparent size whatever the device pixel ratio.
    const scale = Math.max(1, Math.min(2, ctx.canvas.height / 620)) * this.sizeScale;

    if (world.multiplier > this.lastMultiplier) this.pop = POP_FRAMES;
    else if (this.pop > 0) this.pop -= 1;
    this.lastMultiplier = world.multiplier;
    this.lastLevel = world.level;

    const player = world.players[this.localPlayerIndex];
    if (player && player.state === 'alive') this.drawLowHealth(ctx, player);

    this.reserved = [];
    this.drawPopups(ctx, camera, scale);
    for (const other of world.players) {
      if (!other.connected) continue;
      this.drawHealth(ctx, camera, other, scale);
      if (other.index !== this.localPlayerIndex) this.drawName(ctx, camera, other, scale);
    }
    this.drawPings(ctx, camera, player ?? null, scale);
    if (player && player.state === 'alive') this.drawThreatMarkers(ctx, camera, player, scale);
    if (player && pointer && !this.wheel) this.drawReticle(ctx, player, pointer, scale);
    if (player) this.drawLoadout(ctx, player, scale);
    this.drawSquad(ctx, scale);
    this.drawMinimap(ctx, camera, scale);
    this.drawScore(ctx, scale);
    this.drawMessages(ctx, scale);
    if (this.wheel) this.drawWheel(ctx, this.wheel, scale);
    this.lastReserved = this.reserved;
  }

  /** A slab with a hairline of brass, the way the menu panels are framed. */
  private slab(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, s: number, accent = BRASS): void {
    ctx.fillStyle = SLAB_EDGE;
    ctx.fillRect(x, y + 3 * s, w, h);
    ctx.fillStyle = SLAB;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }

  /** Text with a hard shadow under it, legible over blood and floor alike. */
  private text(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, color: string, s: number): void {
    ctx.fillStyle = INK_SHADOW;
    ctx.fillText(value, x + 1 * s, y + 1.5 * s);
    ctx.fillStyle = color;
    ctx.fillText(value, x, y);
  }

  /** A key cap: a small dark square with the key's name. */
  private keycap(ctx: CanvasRenderingContext2D, key: string, x: number, y: number, s: number, lit = false): void {
    const size = 13 * s;
    ctx.fillStyle = lit ? 'rgba(230,207,148,0.95)' : 'rgba(0,0,0,0.7)';
    ctx.fillRect(x, y, size, size);
    ctx.strokeStyle = lit ? '#fff2cf' : BRASS;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
    ctx.font = `800 ${(key.length > 2 ? 6.5 : 8) * s}px ${BODY}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = lit ? '#1a1408' : BRASS_BRIGHT;
    ctx.fillText(key, x + size / 2, y + size * 0.74);
    ctx.textAlign = 'left';
  }

  /** The heartbeat's strength this tick at a life ratio: two quick beats then a rest, faster as it gets worse. */
  heartbeat(ratio: number): number {
    return Hud.heartbeatAt(this.world.tick, ratio);
  }

  /**
   * The beat at a tick and a life ratio: a lub then a softer dub a quarter
   * period on, then rest; the period shortens from 60 ticks at 30% life to
   * 35 at none. Zero above 30%.
   */
  static heartbeatAt(tick: number, ratio: number): number {
    if (ratio > 0.3) return 0;
    const urgency = 1 - ratio / 0.3;
    const period = 60 - urgency * 25;
    const phase = ((tick % period) + period) % period / period;
    // Each beat is a half-sine an eighth of the period wide.
    const pulse = (at: number, strength: number): number => {
      const t = (phase - at) / 0.125;
      return t >= 0 && t <= 1 ? Math.sin(t * Math.PI) * strength : 0;
    };
    return Math.max(pulse(0, 1), pulse(0.25, 0.55));
  }

  /**
   * A heartbeat of red from the edges once health is low. The world's own
   * hurt vignette answers a hit; this one keeps nagging until the player
   * has healed, which is the thing they would otherwise not notice.
   */
  private drawLowHealth(ctx: CanvasRenderingContext2D, player: Player): void {
    const ratio = player.life / player.maxLife;
    if (ratio > 0.3) return;
    const urgency = 1 - ratio / 0.3;
    const beat = this.heartbeat(ratio);
    const strength = (0.3 + urgency * 0.3) * beat;
    if (strength <= 0.01) return;
    const { width, height } = ctx.canvas;
    const cx = width / 2;
    const gradient = ctx.createRadialGradient(
      cx, height / 2, Math.min(width, height) * 0.28,
      cx, height / 2, Math.max(width, height) * 0.58,
    );
    gradient.addColorStop(0, 'rgba(160,0,0,0)');
    gradient.addColorStop(0.6, `rgba(160,0,0,${strength * 0.45})`);
    gradient.addColorStop(1, `rgba(160,0,0,${Math.min(0.85, strength * 1.4)})`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    if (this.highContrast) {
      // A frame that thickens with the beat: a shape, for eyes the red alone does not reach.
      const border = (4 + beat * 8) * Math.max(1, height / 620);
      ctx.fillStyle = `rgba(255,255,255,${0.35 + beat * 0.45})`;
      ctx.fillRect(0, 0, width, border);
      ctx.fillRect(0, height - border, width, border);
      ctx.fillRect(0, 0, border, height);
      ctx.fillRect(width - border, 0, border, height);
    }
  }

  /** Slide a point out of any panel it landed in, toward the middle of the screen. */
  private keepClear(x: number, y: number, s: number, height: number): { x: number; y: number } {
    for (const r of this.lastReserved) {
      const pad = 6 * s;
      if (x < r.x - pad || x > r.x + r.w + pad || y < r.y - pad || y > r.y + r.h + pad) continue;
      // A panel in the top half pushes down, one in the bottom half pushes up.
      y = r.y + r.h / 2 < height / 2 ? r.y + r.h + pad : r.y - pad;
    }
    return { x, y };
  }

  /**
   * Chevrons along the screen edge pointing at enemies that are out of view,
   * so a large arena cannot hide where the wave is coming from. One marker
   * per direction, sized by how near the closest thing that way is, and a
   * devil's marker burns orange because it is the one to deal with first.
   */
  private drawThreatMarkers(ctx: CanvasRenderingContext2D, camera: Camera, player: Player, s: number): void {
    const { width, height } = ctx.canvas;
    const buckets = 24;
    const nearest: Array<{ d: number; angle: number; devil: boolean } | null> = new Array(buckets).fill(null);
    const at = camera.worldToScreen(player.x, player.y);
    const margin = 26 * s;
    let any = false;
    for (const enemy of this.world.enemies) {
      if (enemy.state !== 'alive') continue;
      const screen = camera.worldToScreen(enemy.x, enemy.y);
      if (screen.x > -10 && screen.x < width + 10 && screen.y > -10 && screen.y < height + 10) continue;
      const dx = enemy.x - player.x;
      const dy = enemy.y - player.y;
      const d = Math.hypot(dx, dy);
      const angle = Math.atan2(dy, dx);
      const bucket = ((Math.round((angle / (Math.PI * 2)) * buckets) % buckets) + buckets) % buckets;
      const devil = enemy.defId === 'devil';
      const current = nearest[bucket];
      if (!current || d < current.d || (devil && !current.devil)) nearest[bucket] = { d, angle, devil };
      any = true;
    }
    // A teammate out of view is worth a marker too, in their colour, so a squad can find each other.
    const partners: Array<{ angle: number; d: number; colour: string }> = [];
    for (const other of this.world.players) {
      if (other === player || !other.connected || other.state === 'dead') continue;
      const screen = camera.worldToScreen(other.x, other.y);
      if (screen.x > -10 && screen.x < width + 10 && screen.y > -10 && screen.y < height + 10) continue;
      partners.push({
        angle: Math.atan2(other.y - player.y, other.x - player.x),
        d: Math.hypot(other.x - player.x, other.y - player.y),
        colour: squadColour(other.index),
      });
    }
    this.partnerMarkers = partners.length;
    if (!any && partners.length === 0) return;

    ctx.save();
    ctx.lineJoin = 'round';
    for (const partner of partners) {
      const cos = Math.cos(partner.angle);
      const sin = Math.sin(partner.angle);
      const tx = cos > 0 ? (width - margin - at.x) / cos : cos < 0 ? (margin - at.x) / cos : Infinity;
      const ty = sin > 0 ? (height - margin - at.y) / sin : sin < 0 ? (margin - at.y) / sin : Infinity;
      const t = Math.max(0, Math.min(tx, ty));
      const clear = this.keepClear(at.x + cos * t, at.y + sin * t, s, height);
      const x = Math.max(margin, Math.min(width - margin, clear.x));
      const y = Math.max(margin, Math.min(height - margin, clear.y));
      // A ring with a dot, nothing like a threat's chevron: a friend that way.
      ctx.translate(x, y);
      ctx.beginPath();
      ctx.arc(0, 0, 7 * s, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 4 * s;
      ctx.stroke();
      ctx.strokeStyle = partner.colour;
      ctx.lineWidth = 2 * s;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(Math.cos(partner.angle) * 4 * s, Math.sin(partner.angle) * 4 * s, 1.8 * s, 0, Math.PI * 2);
      ctx.fillStyle = partner.colour;
      ctx.fill();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    for (const marker of nearest) {
      if (!marker) continue;
      // Slide the marker along the ray from the player until it meets the
      // inset screen rectangle, then out of any panel it landed in.
      const cos = Math.cos(marker.angle);
      const sin = Math.sin(marker.angle);
      const tx = cos > 0 ? (width - margin - at.x) / cos : cos < 0 ? (margin - at.x) / cos : Infinity;
      const ty = sin > 0 ? (height - margin - at.y) / sin : sin < 0 ? (margin - at.y) / sin : Infinity;
      const t = Math.max(0, Math.min(tx, ty));
      const clear = this.keepClear(at.x + cos * t, at.y + sin * t, s, height);
      const x = Math.max(margin, Math.min(width - margin, clear.x));
      const y = Math.max(margin, Math.min(height - margin, clear.y));
      // Close threats draw bigger and brighter; far ones fade toward the edge.
      const near = Math.max(0, Math.min(1, 1 - (marker.d - 200) / 900));
      const size = (7 + near * 6) * s;
      const alpha = 0.35 + near * 0.55;
      ctx.translate(x, y);
      ctx.rotate(marker.angle);
      ctx.beginPath();
      if (marker.devil) {
        // A devil's marker is horned: a point on the way and two spikes
        // behind, so it is told apart by shape as well as colour.
        ctx.moveTo(size * 1.15, 0);
        ctx.lineTo(0, -size * 0.55);
        ctx.lineTo(-size * 0.9, -size * 1.0);
        ctx.lineTo(-size * 0.45, 0);
        ctx.lineTo(-size * 0.9, size * 1.0);
        ctx.lineTo(0, size * 0.55);
      } else {
        ctx.moveTo(size, 0);
        ctx.lineTo(-size * 0.7, -size * 0.75);
        ctx.lineTo(-size * 0.3, 0);
        ctx.lineTo(-size * 0.7, size * 0.75);
      }
      ctx.closePath();
      ctx.fillStyle = marker.devil ? `rgba(255,140,40,${alpha})` : `rgba(224,17,31,${alpha})`;
      ctx.strokeStyle = this.highContrast ? `rgba(255,255,255,${Math.min(1, alpha + 0.3)})` : `rgba(0,0,0,${alpha * 0.8})`;
      ctx.lineWidth = (this.highContrast ? 2.5 : 1.5) * s;
      ctx.fill();
      ctx.stroke();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    ctx.restore();
  }

  /**
   * The aim: four ticks around a gap, which spring outward on each shot and
   * settle as the weapon cools. It replaces the browser's crosshair so the
   * feel of the gun reaches the hand that aims it.
   */
  private drawReticle(
    ctx: CanvasRenderingContext2D,
    player: Player,
    pointer: { x: number; y: number },
    s: number,
  ): void {
    const def = WEAPONS[player.current];
    const cooling = def.fireRate > 0 ? Math.max(0, Math.min(1, player.fireCooldown / def.fireRate)) : 0;
    const kick = cooling * cooling * (6 + def.shake * 2) * s;
    const gap = 5 * s + kick;
    const tick = 6 * s;
    const dead = player.state !== 'alive';
    ctx.save();
    ctx.translate(pointer.x, pointer.y);
    ctx.lineCap = 'round';
    for (const pass of [0, 1]) {
      ctx.lineWidth = (pass === 0 ? 4 : 2) * s;
      ctx.strokeStyle = pass === 0 ? 'rgba(0,0,0,0.55)' : dead ? 'rgba(233,226,208,0.35)' : 'rgba(233,226,208,0.95)';
      ctx.beginPath();
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        ctx.moveTo(dx * gap, dy * gap);
        ctx.lineTo(dx * (gap + tick), dy * (gap + tick));
      }
      ctx.stroke();
    }
    ctx.fillStyle = dead ? 'rgba(255,48,64,0.35)' : 'rgba(255,48,64,0.95)';
    ctx.beginPath();
    ctx.arc(0, 0, 1.6 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** Another player's name under their health bar, in their squad colour. */
  private drawName(ctx: CanvasRenderingContext2D, camera: Camera, player: Player, s: number): void {
    const name = this.nameOf(player.index);
    if (!name || player.state === 'dead') return;
    const at = camera.worldToScreen(player.x, player.y);
    ctx.font = `800 ${11 * s}px ${BODY}`;
    ctx.textAlign = 'center';
    this.text(ctx, name, at.x, at.y - 34 * s, squadColour(player.index), s);
    ctx.textAlign = 'left';
  }

  /** A small bar floating over the player's head, as the original drew it. */
  private drawHealth(ctx: CanvasRenderingContext2D, camera: Camera, player: Player, s: number): void {
    if (player.state === 'dead') return;
    const at = camera.worldToScreen(player.x, player.y);
    const width = 30 * s;
    const height = 5 * s;
    const x = at.x - width / 2;
    // Just clear of the top of the head.
    const y = at.y - (player.height + 9) * camera.zoom;
    const ratio = Math.max(0, Math.min(1, player.life / player.maxLife));

    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(x - 1.5 * s, y - 1.5 * s, width + 3 * s, height + 3 * s);
    ctx.fillStyle = '#2a2a2e';
    ctx.fillRect(x, y, width, height);
    // Green through amber to red, so low health is readable at a glance.
    ctx.fillStyle = ratio > 0.5 ? '#3ec04a' : ratio > 0.25 ? AMBER : RED;
    ctx.fillRect(x, y, width * ratio, height);
    if (ratio <= 0.3) {
      // The bar itself beats with the heart, a second place the same pulse shows.
      const beat = this.heartbeat(ratio);
      ctx.strokeStyle = `rgba(255,255,255,${0.25 + beat * 0.65})`;
      ctx.lineWidth = (1 + beat * 1.5) * s;
      ctx.strokeRect(x - 1.5 * s, y - 1.5 * s, width + 3 * s, height + 3 * s);
    }

    if (player.invincible > 0) {
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 1 * s;
      ctx.strokeRect(x - 0.5, y - 0.5, width + 1, height + 1);
    }
  }

  // ---- loadout, bottom right ----------------------------------------------

  /** The ammo a weapon shows: a count, the infinity sign, or a dash when the slot is empty. */
  private ammoLabel(player: Player, id: WeaponId): { text: string; colour: string; empty: boolean } {
    const def = WEAPONS[id];
    const slot = player.weapons.get(id);
    const stats = statsFor(player.stats, id);
    const infinite = def.infiniteAmmo || stats.infiniteAmmo;
    if (!slot?.unlocked) return { text: '—', colour: MUTED, empty: true };
    const empty = !infinite && slot.ammo <= 0;
    const low = !infinite && !empty && slot.ammo <= Math.max(2, Math.round(def.totalAmmo * 0.15));
    return { text: infinite ? '∞' : String(slot.ammo), colour: empty ? RED_HI : low ? AMBER : BONE, empty };
  }

  /** One weapon card: the key, the name, and the ammo large on the right. */
  private card(ctx: CanvasRenderingContext2D, rect: Rect, key: string, id: WeaponId | null, active: boolean, player: Player, s: number): void {
    const { x, y, w, h } = rect;
    if (active) {
      ctx.fillStyle = SLAB_EDGE;
      ctx.fillRect(x, y + 3 * s, w, h);
      ctx.fillStyle = 'rgba(28,20,22,0.94)';
      ctx.fillRect(x, y - 4 * s, w, h + 4 * s);
      ctx.fillStyle = RED;
      ctx.fillRect(x, y - 4 * s, w, 2 * s);
      ctx.strokeStyle = 'rgba(255,90,100,0.7)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y - 4 * s + 0.5, w - 1, h + 4 * s - 1);
    } else {
      this.slab(ctx, x, y, w, h, s, id ? BRASS : 'rgba(201,167,90,0.25)');
    }
    const top = active ? y - 4 * s : y;
    this.keycap(ctx, key, x + 6 * s, top + 6 * s, s, active);
    if (!id) {
      ctx.font = `700 ${7.5 * s}px ${BODY}`;
      this.text(ctx, 'NONE YET', x + 24 * s, top + 16 * s, MUTED, s);
      return;
    }
    const def = WEAPONS[id];
    const ammo = this.ammoLabel(player, id);
    // The icon carries the name; the ammo sits large beside it.
    const icon = Math.min(h - 8 * s, 40 * s);
    drawWeaponIcon(ctx, id, x + 24 * s + icon / 2, top + h / 2 + 1 * s, icon, active ? '#ffffff' : ammo.empty ? MUTED : BONE);
    ctx.font = `400 ${(w < 130 * s ? 20 : 24) * s}px ${DISPLAY}`;
    ctx.textAlign = 'right';
    this.text(ctx, ammo.text, x + w - 9 * s, top + h - 9 * s, active ? ammo.colour : ammo.empty ? ammo.colour : BONE_DIM, s);
    ctx.textAlign = 'left';
    if (def.places === 'chargepack' && player.detonateMode && active) {
      ctx.font = `700 ${6.5 * s}px ${BODY}`;
      ctx.textAlign = 'right';
      this.text(ctx, 'DETONATE', x + w - 9 * s, top + 13 * s, RED_HI, s);
      ctx.textAlign = 'left';
    }
  }

  private drawLoadout(ctx: CanvasRenderingContext2D, player: Player, s: number): void {
    const { width, height } = ctx.canvas;
    const lay = Hud.layout(width, height, s);
    const { primary, secondary } = this.loadout;
    const primaryActive = player.current === primary;
    const secondaryActive = secondary !== null && player.current === secondary;

    this.card(ctx, lay.primary, this.keys.primary, primary, primaryActive, player, s);
    this.card(ctx, lay.secondary, this.keys.secondary, secondary, secondaryActive, player, s);

    // The grenade chip: the key, a grenade, and how many are left.
    const g = lay.grenade;
    const grenades = player.weapons.get('grenade');
    const has = !!grenades?.unlocked;
    const charge = this.world.grenadeCharge(player);
    this.slab(ctx, g.x, g.y, g.w, g.h, s, has ? (charge > 0 ? '#ff3040' : BRASS) : 'rgba(201,167,90,0.25)');
    this.keycap(ctx, this.keys.grenade, g.x + 5 * s, g.y + 5 * s, s, charge > 0);
    drawWeaponIcon(ctx, 'grenade', g.x + g.w / 2 + 5 * s, g.y + g.h / 2 + 1 * s, 26 * s, has ? (charge > 0 ? RED_HI : BONE) : MUTED);
    ctx.font = `400 ${13 * s}px ${DISPLAY}`;
    ctx.textAlign = 'right';
    this.text(ctx, has ? String(grenades!.ammo) : '—', g.x + g.w - 5 * s, g.y + g.h - 5 * s, has ? (grenades!.ammo > 0 ? BONE : RED_HI) : MUTED, s);
    ctx.textAlign = 'left';
    if (charge > 0) {
      // The throw's power, a bar that fills while the key is held.
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(g.x + 4 * s, g.y + g.h - 3 * s, g.w - 8 * s, 2 * s);
      ctx.fillStyle = RED_HI;
      ctx.fillRect(g.x + 4 * s, g.y + g.h - 3 * s, (g.w - 8 * s) * charge, 2 * s);
    }

    this.reserved.push({
      x: g.x,
      y: Math.min(g.y, lay.primary.y) - 4 * s,
      w: lay.secondary.x + lay.secondary.w - g.x,
      h: height - Math.min(g.y, lay.primary.y),
    });
  }

  // ---- squad, bottom left --------------------------------------------------

  /** The squad's health, one row each, the local player first. */
  private drawSquad(ctx: CanvasRenderingContext2D, s: number): void {
    const { width, height } = ctx.canvas;
    const lay = Hud.layout(width, height, s);
    const players = this.world.players.filter((p) => p.connected);
    players.sort((a, b) => (a.index === this.localPlayerIndex ? -1 : b.index === this.localPlayerIndex ? 1 : a.index - b.index));
    const rowH = lay.squad.h;
    const gap = 5 * s;
    let y = lay.squad.y;
    for (const p of players) {
      const me = p.index === this.localPlayerIndex;
      const colour = squadColour(p.index);
      const x = lay.squad.x;
      const w = lay.squad.w;
      this.slab(ctx, x, y, w, rowH, s, me ? BRASS : 'rgba(201,167,90,0.3)');
      // A portrait tile: the character's own head on their squad colour.
      const tile = rowH - 8 * s;
      ctx.fillStyle = p.state === 'dead' ? '#3a2326' : colour;
      ctx.fillRect(x + 4 * s, y + 4 * s, tile, tile);
      const head = this.portraitOf(p.characterId, Math.round(tile));
      if (head) {
        if (p.state === 'dead') ctx.globalAlpha = 0.45;
        ctx.drawImage(head, x + 4 * s, y + 4 * s, tile, tile);
        ctx.globalAlpha = 1;
      } else {
        ctx.font = `400 ${13 * s}px ${DISPLAY}`;
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(0,0,0,0.85)';
        const character = CHARACTERS.find((c) => c.id === p.characterId);
        ctx.fillText((character?.name ?? p.characterId).slice(0, 1).toUpperCase(), x + 4 * s + tile / 2, y + 4 * s + tile * 0.74);
        ctx.textAlign = 'left';
      }
      const name = this.nameOf(p.index) ?? (me ? 'YOU' : `P${p.index + 1}`);
      ctx.font = `800 ${9 * s}px ${BODY}`;
      this.text(ctx, name.toUpperCase().slice(0, 14), x + tile + 10 * s, y + 12 * s, p.state === 'dead' ? MUTED : me ? BONE : colour, s);
      // The bar, and the number beside it.
      const barX = x + tile + 10 * s;
      const barW = w - tile - 44 * s;
      const barY = y + rowH - 11 * s;
      const ratio = p.state === 'dead' ? 0 : Math.max(0, Math.min(1, p.life / p.maxLife));
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      ctx.fillRect(barX, barY, barW, 5 * s);
      ctx.fillStyle = ratio > 0.5 ? '#3ec04a' : ratio > 0.25 ? AMBER : RED;
      ctx.fillRect(barX, barY, barW * ratio, 5 * s);
      if (ratio > 0 && ratio <= 0.3) {
        const beat = this.heartbeat(ratio);
        ctx.strokeStyle = `rgba(255,255,255,${0.2 + beat * 0.6})`;
        ctx.lineWidth = 1 * s;
        ctx.strokeRect(barX - 0.5, barY - 0.5, barW + 1, 5 * s + 1);
      }
      ctx.font = `700 ${8 * s}px ${BODY}`;
      ctx.textAlign = 'right';
      this.text(ctx, p.state === 'dead' ? 'DOWN' : String(Math.ceil(p.life)), x + w - 6 * s, barY + 5 * s, p.state === 'dead' ? RED_HI : BONE_DIM, s);
      ctx.textAlign = 'left';
      if (p.invincible > 0 && p.state === 'alive') {
        ctx.strokeStyle = 'rgba(255,255,255,0.7)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 4 * s + 0.5, y + 4 * s + 0.5, tile - 1, tile - 1);
      }
      y -= rowH + gap;
    }
    const top = y + rowH + gap;
    this.reserved.push({ x: lay.squad.x, y: top, w: lay.squad.w, h: height - top });
  }

  // ---- minimap, top left ---------------------------------------------------

  /** The whole arena at the minimap's scale, cached until the arena changes. */
  private minimapPicture(scale: number): HTMLCanvasElement {
    const map = this.world.map;
    const pw = Math.max(1, Math.round(map.width * scale));
    const ph = Math.max(1, Math.round(map.height * scale));
    if (!this.minimapCanvas || this.minimapRevision !== map.revision || this.minimapScale !== scale) {
      const canvas = this.minimapCanvas ?? document.createElement('canvas');
      canvas.width = pw;
      canvas.height = ph;
      const c = canvas.getContext('2d')!;
      c.fillStyle = '#34363e';
      c.fillRect(0, 0, pw, ph);
      const cell = map.cell * scale;
      for (let cy = 0; cy < map.rows; cy++) {
        for (let cx = 0; cx < map.cols; cx++) {
          const tile = map.tileAt(cx, cy);
          if (tile === Tile.Floor) continue;
          c.fillStyle = tile === Tile.Breakable ? '#b08a40' : '#8c8270';
          c.fillRect(cx * cell, cy * cell, Math.ceil(cell), Math.ceil(cell));
        }
      }
      this.minimapCanvas = canvas;
      this.minimapRevision = map.revision;
      this.minimapScale = scale;
    }
    return this.minimapCanvas;
  }

  /**
   * A window of the arena around the player, the way a shooter's minimap
   * follows them, rather than the whole map at once: beyond the arena's
   * edge is the dark.
   */
  private drawMinimap(ctx: CanvasRenderingContext2D, camera: Camera, s: number): void {
    const { width, height } = ctx.canvas;
    const lay = Hud.layout(width, height, s);
    const r = lay.minimap;
    this.slab(ctx, r.x, r.y, r.w, r.h, s);
    const inset = 3;
    const view = { x: r.x + inset, y: r.y + inset, w: r.w - inset * 2, h: r.h - inset * 2 };
    const k = view.w / MINIMAP_SPAN;
    const picture = this.minimapPicture(k);
    const me = this.world.players[this.localPlayerIndex];
    const centre = me ? { x: me.x, y: me.y } : { x: camera.x, y: camera.y };
    // World origin of the window, in world pixels, and where it lands on screen.
    const worldX = centre.x - view.w / 2 / k;
    const worldY = centre.y - view.h / 2 / k;
    const ox = view.x - worldX * k;
    const oy = view.y - worldY * k;
    ctx.save();
    ctx.beginPath();
    ctx.rect(view.x, view.y, view.w, view.h);
    ctx.clip();
    ctx.fillStyle = '#121317';
    ctx.fillRect(view.x, view.y, view.w, view.h);
    ctx.drawImage(picture, ox, oy);
    // What the screen shows, as a faint frame.
    ctx.strokeStyle = 'rgba(233,226,208,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(ox + camera.originX * k + 0.5, oy + camera.originY * k + 0.5, camera.viewWidth * k, camera.viewHeight * k);
    // Marks, then the squad over them.
    for (const ping of this.pings) {
      const style = PING_STYLES[ping.kind];
      ctx.save();
      ctx.translate(ox + ping.x * k, oy + ping.y * k);
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      drawGlyph(ctx, style.glyph, 4.2 * s);
      ctx.fillStyle = style.colour;
      drawGlyph(ctx, style.glyph, 3 * s);
      ctx.restore();
    }
    for (const p of this.world.players) {
      if (!p.connected || p.state === 'dead') continue;
      const px = ox + p.x * k;
      const py = oy + p.y * k;
      const me = p.index === this.localPlayerIndex;
      ctx.fillStyle = 'rgba(0,0,0,0.8)';
      ctx.beginPath();
      ctx.arc(px, py, (me ? 4 : 3.2) * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = squadColour(p.index);
      ctx.beginPath();
      ctx.arc(px, py, (me ? 2.8 : 2.2) * s, 0, Math.PI * 2);
      ctx.fill();
      if (me) {
        // A wedge the way the player faces.
        ctx.strokeStyle = 'rgba(233,226,208,0.9)';
        ctx.lineWidth = 1.5 * s;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px + Math.cos(p.angle) * 7 * s, py + Math.sin(p.angle) * 7 * s);
        ctx.stroke();
      }
    }
    ctx.restore();
    ctx.font = `700 ${7 * s}px ${BODY}`;
    ctx.textAlign = 'right';
    this.text(ctx, this.world.map.name.toUpperCase(), r.x + r.w - 5 * s, r.y + r.h - 4 * s, BRASS_BRIGHT, s);
    ctx.textAlign = 'left';
    this.reserved.push({ x: 0, y: 0, w: r.x + r.w, h: r.y + r.h });
  }

  // ---- pings -----------------------------------------------------------------

  /** Marks where they lie, with the owner's line, and at the edge when out of view. */
  private drawPings(ctx: CanvasRenderingContext2D, camera: Camera, player: Player | null, s: number): void {
    const { width, height } = ctx.canvas;
    const tick = this.world.tick;
    for (const ping of this.pings) {
      const age = tick - ping.born;
      const alpha = Math.max(0, Math.min(1, (PING_LIFE - age) / 60));
      if (alpha <= 0) continue;
      const style = PING_STYLES[ping.kind];
      const at = camera.worldToScreen(ping.x, ping.y);
      const onScreen = at.x > 0 && at.x < width && at.y > 0 && at.y < height;
      const owner = this.nameOf(ping.owner) ?? (ping.owner === this.localPlayerIndex ? 'You' : `P${ping.owner + 1}`);
      const colour = style.colour;
      ctx.save();
      ctx.globalAlpha = alpha;
      if (onScreen) {
        // A stem to the spot, a ring with the glyph above it, and the line under.
        const pop = age < 12 ? 1 + (1 - age / 12) * 0.6 : 1;
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        ctx.lineWidth = 3 * s;
        ctx.beginPath();
        ctx.moveTo(at.x, at.y);
        ctx.lineTo(at.x, at.y - 22 * s);
        ctx.stroke();
        ctx.strokeStyle = colour;
        ctx.lineWidth = 1.5 * s;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(at.x, at.y, 3 * s, 0, Math.PI * 2);
        ctx.fillStyle = colour;
        ctx.fill();
        ctx.translate(at.x, at.y - 32 * s);
        ctx.scale(pop, pop);
        ctx.beginPath();
        ctx.arc(0, 0, 11 * s, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(8,8,10,0.85)';
        ctx.fill();
        ctx.strokeStyle = colour;
        ctx.lineWidth = 1.5 * s;
        ctx.stroke();
        ctx.fillStyle = colour;
        drawGlyph(ctx, style.glyph, 5.5 * s);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = alpha;
        ctx.font = `700 ${8 * s}px ${BODY}`;
        ctx.textAlign = 'center';
        const metres = player ? Math.round(Math.hypot(ping.x - player.x, ping.y - player.y) / this.world.map.cell) : null;
        const line = `${owner.toUpperCase()}: ${style.line.toUpperCase()}${metres !== null ? `  ·  ${metres}m` : ''}`;
        this.text(ctx, line, at.x, at.y - 48 * s, BONE, s);
        ctx.textAlign = 'left';
      } else if (player) {
        // Off screen: a ring at the edge in the mark's colour, the glyph inside.
        const from = camera.worldToScreen(player.x, player.y);
        const angle = Math.atan2(at.y - from.y, at.x - from.x);
        const margin = 30 * s;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const tx = cos > 0 ? (width - margin - from.x) / cos : cos < 0 ? (margin - from.x) / cos : Infinity;
        const ty = sin > 0 ? (height - margin - from.y) / sin : sin < 0 ? (margin - from.y) / sin : Infinity;
        const t = Math.max(0, Math.min(tx, ty));
        const clear = this.keepClear(from.x + cos * t, from.y + sin * t, s, height);
        const x = Math.max(margin, Math.min(width - margin, clear.x));
        const y = Math.max(margin, Math.min(height - margin, clear.y));
        ctx.translate(x, y);
        ctx.beginPath();
        ctx.arc(0, 0, 9 * s, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(8,8,10,0.85)';
        ctx.fill();
        ctx.strokeStyle = colour;
        ctx.lineWidth = 1.5 * s;
        ctx.stroke();
        ctx.fillStyle = colour;
        drawGlyph(ctx, style.glyph, 4.5 * s);
        // A point on the ring the way it lies.
        ctx.beginPath();
        ctx.moveTo(cos * 13 * s, sin * 13 * s);
        ctx.lineTo(cos * 9 * s - sin * 3 * s, sin * 9 * s + cos * 3 * s);
        ctx.lineTo(cos * 9 * s + sin * 3 * s, sin * 9 * s - cos * 3 * s);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();
    }
  }

  // ---- wheel ---------------------------------------------------------------

  /** A radial menu at the centre of the screen: sectors, the pointed one lit. */
  private drawWheel(ctx: CanvasRenderingContext2D, wheel: WheelView, s: number): void {
    const { width, height } = ctx.canvas;
    const cx = width / 2;
    const cy = height / 2;
    const outer = 122 * s;
    const inner = 46 * s;
    const n = wheel.options.length;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fillRect(0, 0, width, height);
    ctx.translate(cx, cy);
    if (n === 0) {
      ctx.beginPath();
      ctx.arc(0, 0, outer, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(12,12,15,0.8)';
      ctx.fill();
    }
    for (let i = 0; i < n; i++) {
      const option = wheel.options[i]!;
      const lit = i === wheel.hovered && !option.disabled;
      const step = (Math.PI * 2) / n;
      const mid = -Math.PI / 2 + i * step;
      const from = mid - step / 2 + 0.02;
      const to = mid + step / 2 - 0.02;
      ctx.beginPath();
      ctx.arc(0, 0, outer, from, to);
      ctx.arc(0, 0, inner, to, from, true);
      ctx.closePath();
      ctx.fillStyle = lit ? 'rgba(122,8,16,0.92)' : option.disabled ? 'rgba(12,12,15,0.6)' : 'rgba(12,12,15,0.86)';
      ctx.fill();
      ctx.strokeStyle = lit ? '#ff5a64' : 'rgba(201,167,90,0.45)';
      ctx.lineWidth = lit ? 2 * s : 1;
      ctx.stroke();
      // The label along the sector's middle.
      const r = (outer + inner) / 2;
      const lx = Math.cos(mid) * r;
      const ly = Math.sin(mid) * r;
      ctx.textAlign = 'center';
      if (wheel.kind === 'ping') {
        const style = PING_STYLES[option.id as keyof typeof PING_STYLES];
        if (style) {
          ctx.save();
          ctx.translate(lx, ly - 10 * s);
          ctx.fillStyle = 'rgba(0,0,0,0.8)';
          drawGlyph(ctx, style.glyph, 8.5 * s);
          ctx.fillStyle = lit ? '#ffffff' : style.colour;
          drawGlyph(ctx, style.glyph, 7 * s);
          ctx.restore();
        }
        ctx.font = `400 ${11 * s}px ${DISPLAY}`;
        this.text(ctx, option.label.toUpperCase(), lx, ly + 14 * s, lit ? '#ffffff' : BONE, s);
      } else {
        // A weapon is its icon; the ammo sits under it and the hub names it.
        drawWeaponIcon(ctx, option.id as WeaponId, lx, ly - 5 * s, 34 * s, lit ? '#ffffff' : option.disabled ? MUTED : BONE);
        ctx.font = `700 ${7.5 * s}px ${BODY}`;
        this.text(ctx, option.sub.toUpperCase(), lx, ly + 20 * s, lit ? '#ffb3b8' : option.disabled ? MUTED : BONE_DIM, s);
      }
    }
    // The hub: the wheel's name and what the pointer is on.
    ctx.beginPath();
    ctx.arc(0, 0, inner - 4 * s, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(12,12,15,0.92)';
    ctx.fill();
    ctx.strokeStyle = BRASS;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.font = `700 ${7.5 * s}px ${BODY}`;
    this.text(ctx, wheel.title.toUpperCase(), 0, -6 * s, BRASS_BRIGHT, s);
    const chosen = wheel.hovered >= 0 ? wheel.options[wheel.hovered] : null;
    ctx.font = `400 ${10 * s}px ${DISPLAY}`;
    this.text(ctx, chosen ? chosen.label.toUpperCase() : n === 0 ? 'NOTHING YET' : 'RELEASE TO KEEP', 0, 8 * s, chosen ? BONE : MUTED, s);
    ctx.textAlign = 'left';
    ctx.restore();
  }

  /** The score panel, tucked into the top-right corner, out of the play area. */
  private drawScore(ctx: CanvasRenderingContext2D, s: number): void {
    const world = this.world;
    const width = 204 * s;
    const height = 48 * s;
    const x = ctx.canvas.width - width - 12 * s;
    const y = 10 * s;

    this.slab(ctx, x, y, width, height, s);
    this.reserved.push({ x, y: 0, w: ctx.canvas.width - x, h: y + height + 24 * s });

    if (world.mode === 'deathmatch') {
      // Frags per seat instead of a shared score, as the original's HUD did.
      const seats = world.players.filter((p) => p.connected);
      ctx.font = `400 ${14 * s}px ${DISPLAY}`;
      ctx.textAlign = 'left';
      seats.forEach((p, i) => {
        const name = this.nameOf(p.index) ?? (p.index === this.localPlayerIndex ? 'you' : `P${p.index + 1}`);
        this.text(
          ctx,
          `${name} ${p.score}`,
          x + 10 * s + (i % 2) * (width / 2),
          y + 18 * s + Math.floor(i / 2) * 16 * s,
          p.index === this.localPlayerIndex ? RED_HI : BONE,
          s,
        );
      });
      ctx.font = `700 ${8 * s}px ${BODY}`;
      if (world.gameOver && world.winnerIndex >= 0) {
        this.text(ctx, `${this.nameOf(world.winnerIndex) ?? `P${world.winnerIndex + 1}`} WINS`, x + 10 * s, y + height - 6 * s, BRASS_BRIGHT, s);
      } else if (world.killTarget !== null) {
        this.text(ctx, `FIRST TO ${world.killTarget}`, x + 10 * s, y + height - 6 * s, BRASS_BRIGHT, s);
      }
      return;
    }

    // Score on the left, multiplier on the right, the way the original's
    // score panel pairs them.
    ctx.font = `400 ${20 * s}px ${DISPLAY}`;
    ctx.textAlign = 'left';
    this.text(ctx, world.score.toLocaleString(), x + 10 * s, y + 23 * s, BONE, s);

    ctx.font = `700 ${8 * s}px ${BODY}`;
    const left = world.waveRemaining;
    this.text(
      ctx,
      `LEVEL ${world.level}   ·   ${left} LEFT   ·   ${world.kills} KILLS`,
      x + 10 * s,
      y + 34 * s,
      BRASS_BRIGHT,
      s,
    );

    // The multiplier swells for a few frames each time it climbs.
    const ease = this.pop > 0 ? Math.sin((this.pop / POP_FRAMES) * Math.PI) : 0;
    const size = 22 * s * (1 + ease * 0.35);
    ctx.textAlign = 'right';
    ctx.font = `400 ${size}px ${DISPLAY}`;
    const multiplierColor = world.multiplier > 1 ? (ease > 0.5 ? '#ffffff' : RED_HI) : MUTED;
    this.text(ctx, `x${world.multiplier}`, x + width - 10 * s, y + 25 * s + ease * 2 * s, multiplierColor, s);
    ctx.textAlign = 'left';

    // The drain bar: how long the current multiplier step has left. It turns
    // amber and flickers in its last third, which is when a kill matters.
    const barX = x + 10 * s;
    const barY = y + 40 * s;
    const barWidth = width - 20 * s;
    const ratio = world.multiplier > 1
      ? Math.max(0, Math.min(1, world.multiplierTicksLeft / world.multiplierWindow))
      : 0;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(barX, barY, barWidth, 3 * s);
    if (ratio > 0) {
      const urgent = ratio < 0.34;
      const flicker = urgent && world.tick % 10 < 5;
      ctx.fillStyle = urgent ? (flicker ? AMBER : RED_HI) : RED;
      ctx.fillRect(barX, barY, barWidth * ratio, 3 * s);
    }

    // The next award still unclaimed this run. It moves only when one is
    // earned, so it reads as a goal rather than a ticker.
    const next = nextAward(world.awardsBankedUpTo);
    if (next) {
      const label = next.kind === 'weapon' ? WEAPONS[next.weapon].name : next.message.replace('+: ', ': ');
      const text = `NEXT  x${next.multiplier}   ${label.toUpperCase()}`;
      ctx.font = `700 ${8 * s}px ${BODY}`;
      const pillWidth = ctx.measureText(text).width + 18 * s;
      const pillY = y + height + 6 * s;
      ctx.fillStyle = 'rgba(12,12,15,0.8)';
      ctx.fillRect(x + width - pillWidth, pillY, pillWidth, 15 * s);
      ctx.strokeStyle = 'rgba(201,167,90,0.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + width - pillWidth + 0.5, pillY + 0.5, pillWidth - 1, 15 * s - 1);
      ctx.textAlign = 'right';
      this.text(ctx, text, x + width - 9 * s, pillY + 10.5 * s, BONE_DIM, s);
      ctx.textAlign = 'left';
    }
  }

  private drawMessages(ctx: CanvasRenderingContext2D, s: number): void {
    const world = this.world;
    ctx.textAlign = 'center';
    const centre = ctx.canvas.width / 2;
    let y = 120 * s;

    for (const message of world.messages) {
      // Fade over the last second, so banners do not pop out of existence.
      const alpha = Math.min(1, message.life / 40);
      ctx.lineWidth = 5 * s;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = `rgba(0,0,0,${alpha * 0.85})`;
      if (message.kind === 'level') {
        ctx.font = `400 ${34 * s}px ${DISPLAY}`;
        ctx.fillStyle = `rgba(233,226,208,${alpha})`;
      } else if (message.kind === 'upgrade') {
        ctx.font = `400 ${18 * s}px ${DISPLAY}`;
        ctx.fillStyle = `rgba(230,207,148,${alpha})`;
      } else if (message.kind === 'critical') {
        ctx.font = `400 ${18 * s}px ${DISPLAY}`;
        ctx.fillStyle = `rgba(255,48,64,${alpha})`;
      } else {
        ctx.font = `700 ${13 * s}px ${BODY}`;
        ctx.fillStyle = `rgba(233,226,208,${alpha * 0.9})`;
      }
      const text = message.kind === 'level' || message.kind === 'upgrade' ? message.text.toUpperCase() : message.text;
      ctx.strokeText(text, centre, y);
      ctx.fillText(text, centre, y);
      if (message.kind === 'level') {
        // The menus' blood-red rule under a heading, and what the wave holds.
        const ruleWidth = Math.min(160 * s, ctx.measureText(text).width * 0.5);
        ctx.fillStyle = `rgba(224,17,31,${alpha})`;
        ctx.fillRect(centre - ruleWidth / 2, y + 7 * s, ruleWidth, 3 * s);
        if (world.mode !== 'deathmatch') {
          const def = levelDef(world.level);
          const devils = world.devilsEnabled ? def.devilTotal : 0;
          const line = `${def.zombieTotal} ZOMBIES${devils > 0 ? `   ·   ${devils} ${devils === 1 ? 'DEVIL' : 'DEVILS'}` : ''}`;
          ctx.font = `700 ${10 * s}px ${BODY}`;
          ctx.lineWidth = 3 * s;
          ctx.strokeStyle = `rgba(0,0,0,${alpha * 0.85})`;
          ctx.fillStyle = `rgba(230,207,148,${alpha})`;
          ctx.strokeText(line, centre, y + 24 * s);
          ctx.fillText(line, centre, y + 24 * s);
        }
      }
      y += (message.kind === 'level' ? 52 : 24) * s;
    }
    ctx.textAlign = 'left';
  }

  private drawPopups(ctx: CanvasRenderingContext2D, camera: Camera, s: number): void {
    const world = this.world;
    ctx.textAlign = 'center';
    for (const popup of world.popups) {
      const screen = camera.worldToScreen(popup.x, popup.y);
      if (
        screen.x < -60 || screen.y < -60 ||
        screen.x > ctx.canvas.width + 60 || screen.y > ctx.canvas.height + 60
      ) {
        continue;
      }
      const alpha = Math.min(1, popup.life / 20);
      ctx.font = `400 ${13 * s}px ${DISPLAY}`;
      ctx.fillStyle = `rgba(255,236,190,${alpha})`;
      // A dark outline keeps popups legible over blood and pale floor alike.
      ctx.lineWidth = 3 * s;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = `rgba(0,0,0,${alpha * 0.8})`;
      ctx.strokeText(popup.text, screen.x, screen.y);
      ctx.fillText(popup.text, screen.x, screen.y);
    }
    ctx.textAlign = 'left';
  }
}
