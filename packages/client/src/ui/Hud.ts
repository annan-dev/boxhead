/**
 * Heads-up display, drawn in screen space over the world.
 *
 * Laid out the way the original's HUD is: the score and multiplier sit top
 * centre with the multiplier's drain bar under them, and each player's health
 * is a small bar just above their head rather than a gauge in a corner. The
 * weapon strip along the bottom is this port's own addition, kept light. The
 * look matches the menus: white paper, heavy black type, red for anything
 * that matters.
 *
 * Everything here reads from the simulation and writes nothing back.
 */
import {
  WEAPONS,
  WEAPON_ORDER,
  nextAward,
  statsFor,
  type Player,
  type World,
} from '@boxhead/shared';
import type { Camera } from '../render/Camera.js';

const DISPLAY = '"Arial Black", Impact, "Segoe UI Black", "Helvetica Neue", Arial, sans-serif';
const BODY = '"Segoe UI", system-ui, -apple-system, Roboto, Helvetica, Arial, sans-serif';

const PAPER = 'rgba(255,255,255,0.92)';
const INK = '#141414';
const RED = '#e2001a';
const GREY = '#7b7b7b';
const SHADOW = 'rgba(0,0,0,0.18)';

export class Hud {
  constructor(
    private readonly world: World,
    /** Whose weapons and ammo the strip along the bottom shows. */
    private readonly localPlayerIndex = 0,
    /** Name over a seat, for networked play; null draws nothing. */
    private readonly nameOf: (playerIndex: number) => string | null = () => null,
  ) {}

  draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    const world = this.world;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';

    // Screen-space UI is laid out against a nominal height so it stays the same
    // apparent size whatever the device pixel ratio.
    const scale = Math.max(1, Math.min(2, ctx.canvas.height / 620));

    this.drawPopups(ctx, camera, scale);
    for (const player of world.players) {
      if (!player.connected) continue;
      this.drawHealth(ctx, camera, player, scale);
      if (player.index !== this.localPlayerIndex) this.drawName(ctx, camera, player, scale);
    }
    const player = world.players[this.localPlayerIndex];
    if (player) this.drawWeapons(ctx, player, scale);
    this.drawScore(ctx, scale);
    this.drawMessages(ctx, scale);
  }

  /** Another player's name under their health bar. */
  private drawName(ctx: CanvasRenderingContext2D, camera: Camera, player: Player, s: number): void {
    const name = this.nameOf(player.index);
    if (!name || player.state === 'dead') return;
    const at = camera.worldToScreen(player.x, player.y);
    ctx.font = `800 ${11 * s}px ${BODY}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = SHADOW;
    ctx.fillText(name, at.x + 1, at.y - 34 * s + 1);
    ctx.fillStyle = PAPER;
    ctx.fillText(name, at.x, at.y - 34 * s);
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

    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    this.roundRect(ctx, x - 1.5 * s, y - 1.5 * s, width + 3 * s, height + 3 * s, 2 * s);
    ctx.fill();
    ctx.fillStyle = '#3a3a3a';
    ctx.fillRect(x, y, width, height);
    // Green through amber to red, so low health is readable at a glance.
    ctx.fillStyle = ratio > 0.5 ? '#3ec04a' : ratio > 0.25 ? '#f0b21a' : RED;
    ctx.fillRect(x, y, width * ratio, height);

    if (player.invincible > 0) {
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 1 * s;
      ctx.strokeRect(x - 0.5, y - 0.5, width + 1, height + 1);
    }
  }

  private drawWeapons(ctx: CanvasRenderingContext2D, player: Player, s: number): void {
    const slots = WEAPON_ORDER.filter((id) => player.weapons.get(id)?.unlocked);
    const slotWidth = 64 * s;
    const slotHeight = 32 * s;
    const gap = 6 * s;
    const totalWidth = slots.length * slotWidth + (slots.length - 1) * gap;
    let x = (ctx.canvas.width - totalWidth) / 2;
    const y = ctx.canvas.height - 18 * s - slotHeight;

    for (const id of slots) {
      const slot = player.weapons.get(id)!;
      const def = WEAPONS[id];
      const stats = statsFor(player.stats, id);
      const infinite = def.infiniteAmmo || stats.infiniteAmmo;
      const active = player.current === id;
      const empty = !infinite && slot.ammo <= 0;

      ctx.fillStyle = SHADOW;
      this.roundRect(ctx, x, y + 3 * s, slotWidth, slotHeight, 4 * s);
      ctx.fill();
      ctx.fillStyle = active ? RED : PAPER;
      this.roundRect(ctx, x, y, slotWidth, slotHeight, 4 * s);
      ctx.fill();

      ctx.font = `900 ${9 * s}px ${DISPLAY}`;
      ctx.fillStyle = active ? 'rgba(255,255,255,0.75)' : GREY;
      ctx.fillText(String(def.slot), x + 7 * s, y + 12 * s);

      ctx.font = `900 ${11 * s}px ${DISPLAY}`;
      ctx.fillStyle = active ? '#ffffff' : empty ? '#b0b0b0' : INK;
      ctx.fillText(def.shortName, x + 17 * s, y + 12 * s);

      ctx.font = `700 ${10 * s}px ${BODY}`;
      ctx.fillStyle = active ? 'rgba(255,255,255,0.9)' : empty ? RED : GREY;
      ctx.fillText(infinite ? '∞' : String(slot.ammo), x + 7 * s, y + 25 * s);

      x += slotWidth + gap;
    }
  }

  /** A compact score panel tucked into the top-right corner, out of the play area. */
  private drawScore(ctx: CanvasRenderingContext2D, s: number): void {
    const world = this.world;
    const width = 196 * s;
    const height = 44 * s;
    const x = ctx.canvas.width - width - 12 * s;
    const y = 10 * s;

    ctx.fillStyle = SHADOW;
    this.roundRect(ctx, x, y + 3 * s, width, height, 5 * s);
    ctx.fill();
    ctx.fillStyle = PAPER;
    this.roundRect(ctx, x, y, width, height, 5 * s);
    ctx.fill();

    if (world.mode === 'deathmatch') {
      // Frags per seat instead of a shared score, as the original's HUD did.
      const seats = world.players.filter((p) => p.connected);
      ctx.font = `900 ${13 * s}px ${DISPLAY}`;
      ctx.textAlign = 'left';
      seats.forEach((p, i) => {
        const name = this.nameOf(p.index) ?? (p.index === this.localPlayerIndex ? 'you' : `P${p.index + 1}`);
        ctx.fillStyle = p.index === this.localPlayerIndex ? RED : INK;
        ctx.fillText(`${name} ${p.score}`, x + 10 * s + (i % 2) * (width / 2), y + 17 * s + Math.floor(i / 2) * 16 * s);
      });
      if (world.gameOver && world.winnerIndex >= 0) {
        ctx.font = `700 ${8 * s}px ${BODY}`;
        ctx.fillStyle = GREY;
        ctx.fillText(`${this.nameOf(world.winnerIndex) ?? `P${world.winnerIndex + 1}`} WINS`, x + 10 * s, y + height - 6 * s);
      }
      return;
    }

    // Score on the left, multiplier on the right, the way the original's
    // score panel pairs them.
    ctx.font = `900 ${17 * s}px ${DISPLAY}`;
    ctx.fillStyle = INK;
    ctx.textAlign = 'left';
    ctx.fillText(world.score.toLocaleString(), x + 10 * s, y + 21 * s);

    ctx.font = `700 ${8 * s}px ${BODY}`;
    ctx.fillStyle = GREY;
    ctx.fillText(`LEVEL ${world.level}  ·  ${world.kills} KILLS`, x + 10 * s, y + 32 * s);

    ctx.textAlign = 'right';
    ctx.font = `900 ${20 * s}px ${DISPLAY}`;
    ctx.fillStyle = world.multiplier > 1 ? RED : GREY;
    ctx.fillText(`x${world.multiplier}`, x + width - 10 * s, y + 22 * s);
    ctx.textAlign = 'left';

    // The drain bar: how long the current multiplier step has left.
    const barX = x + 10 * s;
    const barY = y + 37 * s;
    const barWidth = width - 20 * s;
    const ratio = world.multiplier > 1
      ? Math.max(0, Math.min(1, world.multiplierTicksLeft / world.multiplierWindow))
      : 0;
    ctx.fillStyle = '#e4e4e4';
    this.roundRect(ctx, barX, barY, barWidth, 3 * s, 1.5 * s);
    ctx.fill();
    if (ratio > 0) {
      ctx.fillStyle = RED;
      this.roundRect(ctx, barX, barY, barWidth * ratio, 3 * s, 1.5 * s);
      ctx.fill();
    }

    // The next award still unclaimed this run. It moves only when one is
    // earned, so it reads as a goal rather than a ticker.
    const next = nextAward(world.awardsBankedUpTo);
    if (next) {
      const label = next.kind === 'weapon' ? WEAPONS[next.weapon].name : next.message.replace('+: ', ': ');
      const text = `NEXT x${next.multiplier} · ${label.toUpperCase()}`;
      ctx.font = `700 ${8 * s}px ${BODY}`;
      const pillWidth = ctx.measureText(text).width + 16 * s;
      const pillY = y + height + 5 * s;
      ctx.fillStyle = PAPER;
      this.roundRect(ctx, x + width - pillWidth, pillY, pillWidth, 14 * s, 7 * s);
      ctx.fill();
      ctx.textAlign = 'right';
      ctx.fillStyle = GREY;
      ctx.fillText(text, x + width - 8 * s, pillY + 10 * s);
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
      ctx.lineWidth = 4 * s;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = `rgba(255,255,255,${alpha * 0.9})`;
      if (message.kind === 'level') {
        ctx.font = `900 ${26 * s}px ${DISPLAY}`;
        ctx.fillStyle = `rgba(20,20,20,${alpha})`;
      } else if (message.kind === 'upgrade') {
        ctx.font = `900 ${15 * s}px ${DISPLAY}`;
        ctx.fillStyle = `rgba(226,0,26,${alpha})`;
      } else if (message.kind === 'critical') {
        ctx.font = `900 ${15 * s}px ${DISPLAY}`;
        ctx.fillStyle = `rgba(226,0,26,${alpha})`;
      } else {
        ctx.font = `700 ${13 * s}px ${BODY}`;
        ctx.fillStyle = `rgba(20,20,20,${alpha * 0.85})`;
      }
      ctx.strokeText(message.text, centre, y);
      ctx.fillText(message.text, centre, y);
      y += (message.kind === 'level' ? 30 : 20) * s;
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
      ctx.font = `900 ${12 * s}px ${DISPLAY}`;
      ctx.fillStyle = `rgba(226,0,26,${alpha})`;
      // A pale outline keeps popups legible over blood and explosions.
      ctx.lineWidth = 3 * s;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = `rgba(255,255,255,${alpha * 0.85})`;
      ctx.strokeText(popup.text, screen.x, screen.y);
      ctx.fillText(popup.text, screen.x, screen.y);
    }
    ctx.textAlign = 'left';
  }

  private roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ): void {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  }
}
