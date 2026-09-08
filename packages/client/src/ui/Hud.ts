/**
 * Heads-up display, drawn in screen space over the world.
 *
 * Laid out the way the original's HUD is: the score and multiplier sit in a
 * panel at the top, with the multiplier's drain bar under them, and each
 * player's health is a small bar just above their head rather than a gauge
 * in a corner. The weapon strip along the bottom is this port's own addition,
 * kept light. The look is the menus': dark slabs with a brass hairline, bone
 * type, blood red for anything that matters.
 *
 * A few things here are animated for the eye only -- the multiplier pops
 * when it climbs, the drain bar flickers before it drops, the screen beats
 * red when health is low -- and all of it is derived from the world each
 * frame, never written back.
 */
import {
  WEAPONS,
  WEAPON_ORDER,
  levelDef,
  nextAward,
  statsFor,
  type Player,
  type World,
} from '@boxhead/shared';
import type { Camera } from '../render/Camera.js';

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

export class Hud {
  private lastMultiplier = 1;
  private pop = 0;
  private lastLevel = 0;
  /** Player's HUD size preference, 0.8-1.4. */
  sizeScale = 1;
  /** Seats driven from this screen, each of which gets a weapon strip. */
  localSeats = 1;
  /** Outlined markers and a framed heartbeat, so nothing rests on colour alone. */
  highContrast = false;
  /** Where the weapon strips ended up this frame, so markers can keep clear. */
  private stripExtents: Array<{ left: number; right: number; top: number }> = [];

  /**
   * Lay a strip out for a seat: how wide each slot can be so the whole
   * arsenal fits its half of the screen (or the whole of it), and where it
   * sits. One place, so the drawing and the tests agree.
   */
  static layoutStrip(
    canvasWidth: number,
    s: number,
    slots: number,
    side: number,
  ): { slotWidth: number; gap: number; left: number; width: number; centre: number } {
    const centre = side === 0 ? canvasWidth / 2 : canvasWidth * (side < 0 ? 0.27 : 0.73);
    // The room a strip has: twice the distance to whichever is nearer, the
    // screen edge or the middle line, less a margin, so two never cross.
    const room = side === 0
      ? canvasWidth - 24 * s
      : 2 * Math.min(centre, Math.abs(canvasWidth / 2 - centre)) - 16 * s;
    const natural = (side === 0 ? 64 : 52) * s;
    const gap = 5 * s;
    const slotWidth = Math.max(30 * s, Math.min(natural, (room - (slots - 1) * gap) / Math.max(1, slots)));
    const width = slots * slotWidth + (slots - 1) * gap;
    return { slotWidth, gap, left: centre - width / 2, width, centre };
  }

  constructor(
    private readonly world: World,
    /** Whose weapons and ammo the strip along the bottom shows. */
    private readonly localPlayerIndex = 0,
    /** Name over a seat, for networked play; null draws nothing. */
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
    // The heartbeat answers whichever seat on this screen is worst off.
    let worst: Player | null = null;
    for (let seat = 0; seat < Math.max(1, this.localSeats); seat++) {
      const local = world.players[seat === 0 ? this.localPlayerIndex : seat];
      if (!local || local.state !== 'alive') continue;
      if (!worst || local.life / local.maxLife < worst.life / worst.maxLife) worst = local;
    }
    if (worst) this.drawLowHealth(ctx, worst, this.localSeats >= 2 ? camera.worldToScreen(worst.x, worst.y).x : null);

    this.stripExtents.length = 0;
    this.drawPopups(ctx, camera, scale);
    for (const other of world.players) {
      if (!other.connected) continue;
      this.drawHealth(ctx, camera, other, scale);
      if (other.index !== this.localPlayerIndex) this.drawName(ctx, camera, other, scale);
    }
    for (let seat = 0; seat < Math.max(1, this.localSeats); seat++) {
      const local = world.players[seat === 0 ? this.localPlayerIndex : seat];
      if (local && local.state === 'alive') this.drawThreatMarkers(ctx, camera, local, scale);
    }
    if (player && pointer) this.drawReticle(ctx, player, pointer, scale);
    if (this.localSeats >= 2) {
      const second = world.players[1];
      if (second && second.state === 'alive') this.drawFacing(ctx, camera, second, scale);
    }
    if (this.localSeats >= 2) {
      const second = world.players[1];
      if (player) this.drawWeapons(ctx, player, scale, -1, 'P1');
      if (second) this.drawWeapons(ctx, second, scale, 1, 'P2');
    } else if (player) {
      this.drawWeapons(ctx, player, scale);
    }
    this.drawScore(ctx, scale);
    this.drawMessages(ctx, scale);
    this.lastStripExtents = this.stripExtents.map((e) => ({ ...e }));
  }

  private lastStripExtents: Array<{ left: number; right: number; top: number }> = [];

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

  /**
   * The second seat aims the way it walks and has no pointer, so a short
   * bone tick past the gun says where its shots will go.
   */
  private drawFacing(ctx: CanvasRenderingContext2D, camera: Camera, player: Player, s: number): void {
    const at = camera.worldToScreen(player.x, player.y - 10);
    const reach = 26 * camera.zoom;
    const cos = Math.cos(player.angle);
    const sin = Math.sin(player.angle);
    ctx.save();
    ctx.lineCap = 'round';
    for (const pass of [0, 1]) {
      ctx.lineWidth = (pass === 0 ? 4 : 2) * s;
      ctx.strokeStyle = pass === 0 ? 'rgba(0,0,0,0.5)' : 'rgba(233,226,208,0.85)';
      ctx.beginPath();
      ctx.moveTo(at.x + cos * reach, at.y + sin * reach);
      ctx.lineTo(at.x + cos * (reach + 9 * s), at.y + sin * (reach + 9 * s));
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * A heartbeat of red from the edges once health is low. The world's own
   * hurt vignette answers a hit; this one keeps nagging until the player
   * has healed, which is the thing they would otherwise not notice.
   */
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

  private drawLowHealth(ctx: CanvasRenderingContext2D, player: Player, seatX: number | null = null): void {
    const ratio = player.life / player.maxLife;
    if (ratio > 0.3) return;
    const urgency = 1 - ratio / 0.3;
    const beat = this.heartbeat(ratio);
    const strength = (0.3 + urgency * 0.3) * beat;
    if (strength <= 0.01) return;
    const { width, height } = ctx.canvas;
    // On a shared screen the beat centres on the hurt seat's side, so the
    // other player knows it is not theirs.
    const cx = seatX === null ? width / 2 : Math.max(width * 0.25, Math.min(width * 0.75, seatX));
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
      // With two seats the frame covers the hurt seat's half only.
      const left = seatX === null ? 0 : seatX < width / 2 ? 0 : width / 2;
      const span = seatX === null ? width : width / 2;
      ctx.fillRect(left, 0, span, border);
      ctx.fillRect(left, height - border, span, border);
      ctx.fillRect(0, 0, border, height);
      ctx.fillRect(width - border, 0, border, height);
    }
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
    // A teammate out of view is worth a marker too, in bone, so a pair can find each other.
    const partners: Array<{ angle: number; d: number }> = [];
    for (const other of this.world.players) {
      if (other === player || !other.connected || other.state === 'dead') continue;
      const screen = camera.worldToScreen(other.x, other.y);
      if (screen.x > -10 && screen.x < width + 10 && screen.y > -10 && screen.y < height + 10) continue;
      partners.push({ angle: Math.atan2(other.y - player.y, other.x - player.x), d: Math.hypot(other.x - player.x, other.y - player.y) });
    }
    if (!any && partners.length === 0) return;

    ctx.save();
    ctx.lineJoin = 'round';
    for (const partner of partners) {
      const cos = Math.cos(partner.angle);
      const sin = Math.sin(partner.angle);
      const tx = cos > 0 ? (width - margin - at.x) / cos : cos < 0 ? (margin - at.x) / cos : Infinity;
      const ty = sin > 0 ? (height - margin - at.y) / sin : sin < 0 ? (margin - at.y) / sin : Infinity;
      const t = Math.max(0, Math.min(tx, ty));
      const x = Math.max(margin, Math.min(width - margin, at.x + cos * t));
      const y = Math.max(margin, Math.min(height - margin, at.y + sin * t));
      // A ring with a dot, nothing like a threat's chevron: a friend that way.
      ctx.translate(x, y);
      ctx.beginPath();
      ctx.arc(0, 0, 7 * s, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 4 * s;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(233,226,208,0.9)';
      ctx.lineWidth = 2 * s;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(Math.cos(partner.angle) * 4 * s, Math.sin(partner.angle) * 4 * s, 1.8 * s, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(233,226,208,0.95)';
      ctx.fill();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    for (const marker of nearest) {
      if (!marker) continue;
      // Slide the marker along the ray from the player until it meets the
      // inset screen rectangle.
      const cos = Math.cos(marker.angle);
      const sin = Math.sin(marker.angle);
      const tx = cos > 0 ? (width - margin - at.x) / cos : cos < 0 ? (margin - at.x) / cos : Infinity;
      const ty = sin > 0 ? (height - margin - at.y) / sin : sin < 0 ? (margin - at.y) / sin : Infinity;
      const t = Math.max(0, Math.min(tx, ty));
      let x = at.x + cos * t;
      let y = at.y + sin * t;
      // Keep out of the score panel (top right) and the weapon strip (bottom
      // centre): a marker that lands in either is pushed to the panel's edge.
      if (x > width - 240 * s && y < 84 * s) y = 84 * s;
      for (const strip of this.lastStripExtents) {
        if (x > strip.left - 8 * s && x < strip.right + 8 * s && y > strip.top) y = strip.top;
      }
      x = Math.max(margin, Math.min(width - margin, x));
      y = Math.max(margin, Math.min(height - margin, y));
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

  /** Another player's name under their health bar. */
  private drawName(ctx: CanvasRenderingContext2D, camera: Camera, player: Player, s: number): void {
    const name = this.nameOf(player.index);
    if (!name || player.state === 'dead') return;
    const at = camera.worldToScreen(player.x, player.y);
    ctx.font = `800 ${11 * s}px ${BODY}`;
    ctx.textAlign = 'center';
    this.text(ctx, name, at.x, at.y - 34 * s, BONE, s);
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

  private drawWeapons(
    ctx: CanvasRenderingContext2D,
    player: Player,
    s: number,
    /** -1 left half, 1 right half, 0 centred: where a shared screen's strips go. */
    side = 0,
    label = '',
  ): void {
    const slots = WEAPON_ORDER.filter((id) => player.weapons.get(id)?.unlocked);
    // A full arsenal must still fit a narrow window, or half of one.
    const layout = Hud.layoutStrip(ctx.canvas.width, s, slots.length, side);
    const { slotWidth, gap, centre } = layout;
    const slotHeight = 34 * s;
    let x = layout.left;
    const y = ctx.canvas.height - 16 * s - slotHeight;
    this.stripExtents.push({ left: layout.left, right: layout.left + layout.width, top: y - 12 * s });
    if (label) {
      ctx.font = `700 ${9 * s}px ${BODY}`;
      ctx.textAlign = 'center';
      this.text(ctx, label, centre, y - 6 * s, BRASS_BRIGHT, s);
      ctx.textAlign = 'left';
    }

    for (const id of slots) {
      const slot = player.weapons.get(id)!;
      const def = WEAPONS[id];
      const stats = statsFor(player.stats, id);
      const infinite = def.infiniteAmmo || stats.infiniteAmmo;
      const active = player.current === id;
      const empty = !infinite && slot.ammo <= 0;
      const low = !infinite && !empty && slot.ammo <= Math.max(2, Math.round(def.totalAmmo * 0.15));

      if (active) {
        ctx.fillStyle = SLAB_EDGE;
        ctx.fillRect(x, y + 3 * s, slotWidth, slotHeight);
        ctx.fillStyle = 'rgba(122,8,16,0.92)';
        ctx.fillRect(x, y - 3 * s, slotWidth, slotHeight + 3 * s);
        ctx.fillStyle = RED;
        ctx.fillRect(x, y - 3 * s, slotWidth, 2 * s);
        ctx.strokeStyle = 'rgba(255,90,100,0.7)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y - 3 * s + 0.5, slotWidth - 1, slotHeight + 3 * s - 1);
      } else {
        this.slab(ctx, x, y, slotWidth, slotHeight, s, empty ? 'rgba(120,30,30,0.5)' : BRASS);
      }
      const top = active ? y - 3 * s : y;

      ctx.font = `700 ${9 * s}px ${BODY}`;
      this.text(ctx, String(def.slot), x + 7 * s, top + 13 * s, active ? '#ffb3b8' : BRASS_BRIGHT, s);

      ctx.font = `400 ${(slotWidth < 50 * s ? 11 : 13) * s}px ${DISPLAY}`;
      this.text(ctx, def.shortName, x + 17 * s, top + 14 * s, active ? '#ffffff' : empty ? MUTED : BONE, s);

      ctx.font = `700 ${10 * s}px ${BODY}`;
      const ammoColor = active ? 'rgba(255,255,255,0.9)' : empty ? RED_HI : low ? AMBER : BONE_DIM;
      this.text(ctx, infinite ? '∞' : String(slot.ammo), x + 7 * s, top + 27 * s, ammoColor, s);

      x += slotWidth + gap;
    }
  }

  /** The score panel, tucked into the top-right corner, out of the play area. */
  private drawScore(ctx: CanvasRenderingContext2D, s: number): void {
    const world = this.world;
    const width = 204 * s;
    const height = 48 * s;
    const x = ctx.canvas.width - width - 12 * s;
    const y = 10 * s;

    this.slab(ctx, x, y, width, height, s);

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
