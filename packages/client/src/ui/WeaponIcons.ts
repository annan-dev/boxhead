/**
 * Weapon icons for the HUD and the wheels: one drawn silhouette per weapon,
 * in the game's own palette, so a slot reads at a glance without a name.
 *
 * Each is authored in a 32 by 32 box and scaled; a dark outline under the
 * fill keeps it legible over blood and pale floor alike. Vector rather than
 * bitmap so the single-file build carries them and any size stays crisp.
 */
import type { WeaponId } from '@boxhead/shared';

const OUTLINE = 'rgba(0,0,0,0.85)';

/** A shape drawn twice: a fat dark stroke under the fill. */
function shape(ctx: CanvasRenderingContext2D, colour: string, build: () => void): void {
  ctx.beginPath();
  build();
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;
  ctx.strokeStyle = OUTLINE;
  ctx.stroke();
  ctx.fillStyle = colour;
  ctx.fill();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

const DRAW: Record<WeaponId, (ctx: CanvasRenderingContext2D, c: string) => void> = {
  pistol: (ctx, c) => {
    // Slide and barrel, a grip raked back, a trigger guard.
    shape(ctx, c, () => {
      ctx.moveTo(3, 11);
      ctx.lineTo(29, 11);
      ctx.lineTo(29, 17);
      ctx.lineTo(14, 17);
      ctx.lineTo(11, 27);
      ctx.lineTo(4, 27);
      ctx.lineTo(7, 17);
      ctx.lineTo(3, 17);
      ctx.closePath();
    });
    ctx.fillStyle = OUTLINE;
    ctx.fillRect(14, 17, 5, 2);
    ctx.fillRect(22, 8, 3, 3);
  },
  uzi: (ctx, c) => {
    // A boxy receiver, a long magazine straight down, a stubby barrel.
    shape(ctx, c, () => {
      ctx.moveTo(4, 9);
      ctx.lineTo(24, 9);
      ctx.lineTo(24, 12);
      ctx.lineTo(30, 12);
      ctx.lineTo(30, 15);
      ctx.lineTo(24, 15);
      ctx.lineTo(24, 18);
      ctx.lineTo(18, 18);
      ctx.lineTo(18, 30);
      ctx.lineTo(12, 30);
      ctx.lineTo(12, 18);
      ctx.lineTo(4, 18);
      ctx.closePath();
    });
    ctx.fillStyle = OUTLINE;
    ctx.fillRect(4, 12, 4, 2);
    ctx.fillRect(13, 20, 4, 2);
    ctx.fillRect(13, 24, 4, 2);
  },
  shotgun: (ctx, c) => {
    // A long barrel over a pump, a stock behind.
    shape(ctx, c, () => {
      ctx.moveTo(2, 20);
      ctx.lineTo(8, 14);
      ctx.lineTo(31, 14);
      ctx.lineTo(31, 17);
      ctx.lineTo(16, 17);
      ctx.lineTo(16, 20);
      ctx.lineTo(11, 20);
      ctx.lineTo(9, 25);
      ctx.lineTo(3, 25);
      ctx.closePath();
    });
    shape(ctx, '#8a6f34', () => roundRect(ctx, 18, 16, 8, 4, 1));
  },
  rocket: (ctx, c) => {
    // A launcher tube with a flared mouth, the rocket's nose showing.
    shape(ctx, c, () => {
      ctx.moveTo(3, 12);
      ctx.lineTo(23, 12);
      ctx.lineTo(23, 9);
      ctx.lineTo(29, 9);
      ctx.lineTo(29, 21);
      ctx.lineTo(23, 21);
      ctx.lineTo(23, 18);
      ctx.lineTo(13, 18);
      ctx.lineTo(11, 25);
      ctx.lineTo(5, 25);
      ctx.lineTo(7, 18);
      ctx.lineTo(3, 18);
      ctx.closePath();
    });
    shape(ctx, '#ff3040', () => {
      ctx.moveTo(24, 12);
      ctx.lineTo(28, 15);
      ctx.lineTo(24, 18);
      ctx.closePath();
    });
  },
  railgun: (ctx, c) => {
    // A slim rail with three coils along it and a grip under.
    shape(ctx, c, () => {
      ctx.moveTo(2, 13);
      ctx.lineTo(31, 13);
      ctx.lineTo(31, 17);
      ctx.lineTo(14, 17);
      ctx.lineTo(12, 25);
      ctx.lineTo(6, 25);
      ctx.lineTo(8, 17);
      ctx.lineTo(2, 17);
      ctx.closePath();
    });
    for (const x of [16, 21, 26]) shape(ctx, '#9966ff', () => roundRect(ctx, x, 10, 3, 10, 1));
  },
  barrel: (ctx, c) => {
    // A drum with two red bands.
    shape(ctx, c, () => roundRect(ctx, 9, 4, 14, 24, 3));
    ctx.fillStyle = '#e0111f';
    ctx.fillRect(9, 10, 14, 3);
    ctx.fillRect(9, 20, 14, 3);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(11, 6, 3, 20);
  },
  fakewall: (ctx, c) => {
    // Bricks in a square: a barricade.
    shape(ctx, c, () => roundRect(ctx, 5, 5, 22, 22, 1));
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const y of [12, 19]) {
      ctx.moveTo(5, y);
      ctx.lineTo(27, y);
    }
    ctx.moveTo(16, 5);
    ctx.lineTo(16, 12);
    ctx.moveTo(11, 12);
    ctx.lineTo(11, 19);
    ctx.moveTo(21, 12);
    ctx.lineTo(21, 19);
    ctx.moveTo(16, 19);
    ctx.lineTo(16, 27);
    ctx.stroke();
  },
  mine: (ctx, c) => {
    // A flat disc with a light in the middle and prongs around.
    shape(ctx, c, () => {
      ctx.ellipse(16, 18, 13, 7, 0, 0, Math.PI * 2);
    });
    shape(ctx, c, () => roundRect(ctx, 6, 10, 20, 8, 3));
    ctx.fillStyle = '#ff3040';
    ctx.beginPath();
    ctx.arc(16, 12, 2.5, 0, Math.PI * 2);
    ctx.fill();
  },
  chargepack: (ctx, c) => {
    // A brick of charge with a timer and two leads.
    shape(ctx, c, () => roundRect(ctx, 5, 9, 22, 16, 2));
    ctx.fillStyle = '#0f1013';
    ctx.fillRect(9, 13, 9, 6);
    ctx.fillStyle = '#ff3040';
    ctx.font = '700 6px "Segoe UI", system-ui, sans-serif';
    ctx.fillText('0:05', 9.5, 18);
    ctx.strokeStyle = '#e0111f';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(21, 13);
    ctx.lineTo(24, 6);
    ctx.moveTo(24, 13);
    ctx.lineTo(28, 7);
    ctx.stroke();
  },
  grenade: (ctx, c) => {
    // A pineapple with its lever and pin.
    shape(ctx, c, () => {
      ctx.ellipse(15, 19, 8, 10, 0, 0, Math.PI * 2);
    });
    shape(ctx, '#8a8a8a', () => roundRect(ctx, 12, 5, 7, 6, 1));
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (const y of [15, 20, 25]) {
      ctx.moveTo(8, y);
      ctx.lineTo(22, y);
    }
    for (const x of [11, 15, 19]) {
      ctx.moveTo(x, 10);
      ctx.lineTo(x, 28);
    }
    ctx.stroke();
    shape(ctx, '#e6cf94', () => {
      ctx.moveTo(19, 6);
      ctx.lineTo(27, 4);
      ctx.lineTo(27, 7);
      ctx.lineTo(19, 9);
      ctx.closePath();
    });
  },
};

/**
 * Draw a weapon's icon centred on (x, y), `size` pixels across, in `colour`.
 */
export function drawWeaponIcon(ctx: CanvasRenderingContext2D, id: WeaponId, x: number, y: number, size: number, colour = '#e9e2d0'): void {
  ctx.save();
  ctx.translate(x - size / 2, y - size / 2);
  ctx.scale(size / 32, size / 32);
  DRAW[id](ctx, colour);
  ctx.restore();
}
