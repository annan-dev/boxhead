/**
 * Heads-up display, drawn in screen space over the world.
 *
 * The layout keeps the middle of the screen clear, because that is where the
 * player is looking. Health and the weapon strip sit along the bottom, score in
 * the top corner, and transient messages fade through the upper middle.
 *
 * Everything here reads from the simulation and writes nothing back.
 */
import {
  WEAPONS,
  WEAPON_ORDER,
  statsFor,
  type Player,
  type World,
} from '@boxhead/shared';
import type { Camera } from '../render/Camera.js';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

export class Hud {
  constructor(private readonly world: World) {}

  draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    const world = this.world;
    const player = world.players[0];
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';

    // Screen-space UI is laid out against a nominal height so it stays the same
    // apparent size whatever the device pixel ratio.
    const scale = Math.max(1, Math.min(2, ctx.canvas.height / 620));

    this.drawPopups(ctx, camera, scale);
    if (player) {
      this.drawHealth(ctx, player, scale);
      this.drawWeapons(ctx, player, scale);
    }
    this.drawScore(ctx, scale);
    this.drawMessages(ctx, scale);
  }

  private drawHealth(ctx: CanvasRenderingContext2D, player: Player, s: number): void {
    const x = 18 * s;
    const height = 16 * s;
    const y = ctx.canvas.height - 30 * s - height;
    const width = 210 * s;
    const ratio = Math.max(0, player.life / player.maxLife);

    ctx.fillStyle = 'rgba(8,9,12,0.62)';
    this.roundRect(ctx, x - 6 * s, y - 6 * s, width + 12 * s, height + 12 * s, 5 * s);
    ctx.fill();

    ctx.fillStyle = '#24272d';
    this.roundRect(ctx, x, y, width, height, 3 * s);
    ctx.fill();

    // Green through amber to red, so low health is readable at a glance.
    ctx.fillStyle = `hsl(${ratio * 110}, 68%, ${ratio < 0.25 ? 52 : 44}%)`;
    this.roundRect(ctx, x, y, Math.max(2 * s, width * ratio), height, 3 * s);
    ctx.fill();

    ctx.font = `600 ${11 * s}px ${MONO}`;
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.fillText(`${Math.max(0, Math.ceil(player.life))}`, x + 8 * s, y + height - 4 * s);

    if (player.state === 'dead') {
      ctx.fillStyle = '#ffb4a0';
      ctx.fillText(
        `respawning in ${Math.ceil(player.respawnTimer / 50)}s`,
        x,
        y - 12 * s,
      );
    }
  }

  private drawWeapons(ctx: CanvasRenderingContext2D, player: Player, s: number): void {
    const slots = WEAPON_ORDER.filter((id) => player.weapons.get(id)?.unlocked);
    const slotWidth = 60 * s;
    const slotHeight = 34 * s;
    const gap = 5 * s;
    const totalWidth = slots.length * slotWidth + (slots.length - 1) * gap;
    let x = (ctx.canvas.width - totalWidth) / 2;
    const y = ctx.canvas.height - 22 * s - slotHeight;

    for (const id of slots) {
      const slot = player.weapons.get(id)!;
      const def = WEAPONS[id];
      const stats = statsFor(player.stats, id);
      const infinite = def.infiniteAmmo || stats.infiniteAmmo;
      const active = player.current === id;
      const empty = !infinite && slot.ammo <= 0;

      ctx.fillStyle = active ? 'rgba(208,161,58,0.2)' : 'rgba(8,9,12,0.62)';
      this.roundRect(ctx, x, y, slotWidth, slotHeight, 4 * s);
      ctx.fill();
      ctx.strokeStyle = active ? '#d0a13a' : 'rgba(255,255,255,0.1)';
      ctx.lineWidth = active ? 2 * s : 1 * s;
      this.roundRect(ctx, x, y, slotWidth, slotHeight, 4 * s);
      ctx.stroke();

      ctx.font = `600 ${10 * s}px ${MONO}`;
      ctx.fillStyle = active ? '#ffd88a' : '#6f7883';
      ctx.fillText(String(def.slot), x + 6 * s, y + 13 * s);

      ctx.font = `600 ${11 * s}px ${MONO}`;
      ctx.fillStyle = empty ? '#8a5a52' : active ? '#f2ede2' : '#aab2bd';
      ctx.fillText(def.shortName, x + 17 * s, y + 13 * s);

      ctx.font = `${10 * s}px ${MONO}`;
      ctx.fillStyle = empty ? '#a05050' : 'rgba(230,235,240,0.6)';
      ctx.fillText(infinite ? 'unlimited' : `${slot.ammo}`, x + 6 * s, y + 26 * s);

      x += slotWidth + gap;
    }
  }

  private drawScore(ctx: CanvasRenderingContext2D, s: number): void {
    const world = this.world;
    const right = ctx.canvas.width - 18 * s;
    ctx.textAlign = 'right';

    ctx.fillStyle = 'rgba(8,9,12,0.62)';
    this.roundRect(ctx, right - 176 * s, 14 * s, 176 * s, 56 * s, 5 * s);
    ctx.fill();

    ctx.font = `700 ${20 * s}px ${MONO}`;
    ctx.fillStyle = '#ffd88a';
    ctx.fillText(world.score.toLocaleString(), right - 12 * s, 40 * s);

    ctx.font = `${10 * s}px ${MONO}`;
    ctx.fillStyle = '#8b939e';
    ctx.fillText(`LEVEL ${world.level}   ${world.kills} KILLS`, right - 12 * s, 58 * s);

    if (world.multiplier > 1) {
      ctx.font = `700 ${26 * s}px ${MONO}`;
      ctx.fillStyle = '#ffcf4a';
      ctx.fillText(`x${world.multiplier}`, right - 12 * s, 96 * s);
    }
    ctx.textAlign = 'left';
  }

  private drawMessages(ctx: CanvasRenderingContext2D, s: number): void {
    const world = this.world;
    ctx.textAlign = 'center';
    const centre = ctx.canvas.width / 2;
    let y = 62 * s;

    for (const message of world.messages) {
      // Fade over the last second, so banners do not pop out of existence.
      const alpha = Math.min(1, message.life / 40);
      if (message.kind === 'level') {
        ctx.font = `700 ${24 * s}px ${MONO}`;
        ctx.fillStyle = `rgba(255,220,120,${alpha})`;
      } else if (message.kind === 'upgrade') {
        ctx.font = `600 ${14 * s}px ${MONO}`;
        ctx.fillStyle = `rgba(150,230,160,${alpha})`;
      } else if (message.kind === 'critical') {
        ctx.font = `600 ${14 * s}px ${MONO}`;
        ctx.fillStyle = `rgba(255,140,120,${alpha})`;
      } else {
        ctx.font = `${13 * s}px ${MONO}`;
        ctx.fillStyle = `rgba(200,208,218,${alpha * 0.85})`;
      }
      ctx.fillText(message.text, centre, y);
      y += (message.kind === 'level' ? 28 : 20) * s;
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
      if (popup.kind === 'combo') {
        ctx.font = `700 ${14 * s}px ${MONO}`;
        ctx.fillStyle = `rgba(255,190,80,${alpha})`;
      } else {
        ctx.font = `600 ${11 * s}px ${MONO}`;
        ctx.fillStyle = `rgba(240,244,250,${alpha * 0.9})`;
      }
      // A dark outline keeps popups legible over blood and explosions.
      ctx.lineWidth = 3 * s;
      ctx.strokeStyle = `rgba(0,0,0,${alpha * 0.65})`;
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
