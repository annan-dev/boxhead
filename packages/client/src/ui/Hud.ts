/**
 * Heads-up display, drawn in screen space over the world.
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

const FONT = '600 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const FONT_SMALL = '600 10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const FONT_BIG = '700 26px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

export class Hud {
  constructor(private readonly world: World) {}

  draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    const world = this.world;
    const player = world.players[0];
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.textBaseline = 'alphabetic';

    this.drawPopups(ctx, camera);
    if (player) {
      this.drawHealth(ctx, player);
      this.drawWeapons(ctx, player);
    }
    this.drawScore(ctx);
    this.drawMessages(ctx);
    if (world.gameOver) this.drawGameOver(ctx);
  }

  private drawHealth(ctx: CanvasRenderingContext2D, player: Player): void {
    const x = 16;
    const y = ctx.canvas.height - 46;
    const width = 180;
    const ratio = Math.max(0, player.life / player.maxLife);

    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x - 4, y - 4, width + 8, 22);
    ctx.fillStyle = '#2a2f36';
    ctx.fillRect(x, y, width, 14);
    // Green through amber to red, so low health is readable at a glance.
    const hue = ratio * 110;
    ctx.fillStyle = `hsl(${hue}, 70%, 45%)`;
    ctx.fillRect(x, y, width * ratio, 14);

    ctx.font = FONT_SMALL;
    ctx.fillStyle = '#e8ecf1';
    ctx.fillText(`${Math.ceil(player.life)} / ${player.maxLife}`, x + 6, y + 11);

    if (player.state === 'dead') {
      ctx.font = FONT;
      ctx.fillStyle = '#ffb4a0';
      ctx.fillText(
        `respawning in ${Math.ceil(player.respawnTimer / 50)}s`,
        x,
        y - 10,
      );
    }
  }

  private drawWeapons(ctx: CanvasRenderingContext2D, player: Player): void {
    const world = this.world;
    const y = ctx.canvas.height - 22;
    let x = 210;
    ctx.font = FONT_SMALL;

    for (const id of WEAPON_ORDER) {
      const slot = player.weapons.get(id);
      if (!slot?.unlocked) continue;
      const def = WEAPONS[id];
      const active = player.current === id;
      const stats = statsFor(player.stats, id);
      const infinite = def.infiniteAmmo || stats.infiniteAmmo;
      const empty = !infinite && slot.ammo <= 0;

      const width = 52;
      ctx.fillStyle = active ? 'rgba(220,180,60,0.22)' : 'rgba(0,0,0,0.5)';
      ctx.fillRect(x, y - 14, width, 20);
      ctx.strokeStyle = active ? '#e0b93c' : 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y - 13.5, width - 1, 19);

      ctx.fillStyle = empty ? '#7d5c5c' : active ? '#ffe9a8' : '#aab2bd';
      ctx.fillText(`${def.slot}`, x + 4, y);
      ctx.fillText(def.shortName, x + 14, y);
      ctx.fillStyle = empty ? '#a05050' : 'rgba(230,235,240,0.65)';
      ctx.fillText(infinite ? '--' : String(slot.ammo), x + 14, y - 6);
      x += width + 4;
    }

    const ammo = world.ammoFor(player);
    ctx.font = FONT;
    ctx.fillStyle = '#e8ecf1';
    ctx.fillText(
      `${WEAPONS[player.current].name}  ${ammo < 0 ? 'INF' : ammo}`,
      16,
      ctx.canvas.height - 8,
    );
  }

  private drawScore(ctx: CanvasRenderingContext2D): void {
    const world = this.world;
    ctx.font = FONT;
    ctx.textAlign = 'right';
    const right = ctx.canvas.width - 16;

    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(right - 168, 10, 168, 58);

    ctx.fillStyle = '#ffe9a8';
    ctx.fillText(`SCORE ${world.score.toLocaleString()}`, right - 8, 30);
    ctx.fillStyle = '#cdd4dd';
    ctx.fillText(`LEVEL ${world.level}`, right - 8, 48);
    ctx.font = FONT_SMALL;
    ctx.fillStyle = '#9aa3ad';
    ctx.fillText(`KILLS ${world.kills}`, right - 8, 62);

    if (world.multiplier > 1) {
      ctx.font = FONT_BIG;
      ctx.fillStyle = '#ffcf4a';
      ctx.fillText(`x${world.multiplier}`, right - 8, 100);
    }
    ctx.textAlign = 'left';
  }

  private drawMessages(ctx: CanvasRenderingContext2D): void {
    const world = this.world;
    ctx.textAlign = 'center';
    const centre = ctx.canvas.width / 2;
    let y = 64;

    for (const message of world.messages) {
      // Fade over the last second so banners do not pop out of existence.
      const alpha = Math.min(1, message.life / 40);
      if (message.kind === 'level') {
        ctx.font = FONT_BIG;
        ctx.fillStyle = `rgba(255,220,120,${alpha})`;
      } else if (message.kind === 'upgrade') {
        ctx.font = FONT;
        ctx.fillStyle = `rgba(150,230,160,${alpha})`;
      } else if (message.kind === 'critical') {
        ctx.font = FONT;
        ctx.fillStyle = `rgba(255,140,120,${alpha})`;
      } else {
        ctx.font = FONT;
        ctx.fillStyle = `rgba(210,218,228,${alpha})`;
      }
      ctx.fillText(message.text, centre, y);
      y += message.kind === 'level' ? 30 : 20;
    }
    ctx.textAlign = 'left';
  }

  private drawPopups(ctx: CanvasRenderingContext2D, camera: Camera): void {
    const world = this.world;
    ctx.textAlign = 'center';
    for (const popup of world.popups) {
      const screen = camera.worldToScreen(popup.x, popup.y);
      const sx = screen.x;
      const sy = screen.y;
      if (sx < -40 || sy < -40 || sx > ctx.canvas.width + 40 || sy > ctx.canvas.height + 40) {
        continue;
      }
      const alpha = Math.min(1, popup.life / 20);
      if (popup.kind === 'combo') {
        ctx.font = FONT;
        ctx.fillStyle = `rgba(255,190,80,${alpha})`;
      } else {
        ctx.font = FONT_SMALL;
        ctx.fillStyle = `rgba(240,244,250,${alpha * 0.9})`;
      }
      ctx.fillText(popup.text, sx, sy);
    }
    ctx.textAlign = 'left';
  }

  private drawGameOver(ctx: CanvasRenderingContext2D): void {
    const world = this.world;
    ctx.fillStyle = 'rgba(8,9,12,0.72)';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.textAlign = 'center';
    const centre = ctx.canvas.width / 2;
    const middle = ctx.canvas.height / 2;

    ctx.font = '700 40px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    ctx.fillStyle = '#ff8d78';
    ctx.fillText('GAME OVER', centre, middle - 30);

    ctx.font = FONT;
    ctx.fillStyle = '#e8ecf1';
    ctx.fillText(`Score ${world.score.toLocaleString()}`, centre, middle + 6);
    ctx.fillText(`Reached level ${world.level} with ${world.kills} kills`, centre, middle + 28);
    ctx.fillStyle = '#9aa3ad';
    ctx.fillText('press R to play again', centre, middle + 58);
    ctx.textAlign = 'left';
  }
}
