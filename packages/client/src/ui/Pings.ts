/**
 * Squad marks: what the ping wheel offers, how each is drawn, and the marks
 * alive on this screen. A mark is a point in the arena with a kind and an
 * owner; it lives a few seconds, is drawn where it lies, on the minimap, and
 * at the screen's edge when out of view.
 */
import type { MarkKind } from '@boxhead/shared';

export interface PingStyle {
  /** The wheel's word for it, and the line shown at the mark. */
  label: string;
  /** What the owner is heard to say in the strip. */
  line: string;
  colour: string;
  /** A one-glyph icon; drawn by name so it reads at any size. */
  glyph: 'diamond' | 'skull' | 'arrow' | 'crate' | 'cross' | 'flame' | 'shield';
}

export const PING_STYLES: Record<MarkKind, PingStyle> = {
  look: { label: 'Look here', line: 'Look here', colour: '#e9e2d0', glyph: 'diamond' },
  enemy: { label: 'Enemy', line: 'Enemy here', colour: '#ff3040', glyph: 'skull' },
  go: { label: 'Going here', line: 'Going here', colour: '#4ea6ff', glyph: 'arrow' },
  loot: { label: 'Crate', line: 'Crate here', colour: '#e6cf94', glyph: 'crate' },
  help: { label: 'Help', line: 'Need help', colour: '#f0b21a', glyph: 'cross' },
  danger: { label: 'Devil', line: 'Devil, watch out', colour: '#ff8c28', glyph: 'flame' },
  defend: { label: 'Hold here', line: 'Hold this spot', colour: '#3ec04a', glyph: 'shield' },
};

/** The wheel's order, top and clockwise. */
export const PING_WHEEL: MarkKind[] = ['enemy', 'go', 'loot', 'defend', 'help', 'danger'];

/** Ticks a mark stays on screen. */
export const PING_LIFE = 400;

export interface Ping {
  id: number;
  kind: MarkKind;
  x: number;
  y: number;
  /** Player index of whoever marked it. */
  owner: number;
  /** Simulation tick it was made on. */
  born: number;
}

/** Colours the squad wears, by seat: the bars, the minimap dots, the ping rings. */
export const SQUAD_COLOURS = ['#e9e2d0', '#3ec04a', '#4ea6ff', '#f0b21a', '#c86bff'];

export function squadColour(index: number): string {
  return SQUAD_COLOURS[((index % SQUAD_COLOURS.length) + SQUAD_COLOURS.length) % SQUAD_COLOURS.length]!;
}

/**
 * Which sector of a wheel of `count` options the pointer's travel points
 * at, the first sector at the top and the rest clockwise; -1 inside the
 * dead zone, where nothing is chosen.
 */
export function wheelPick(count: number, dx: number, dy: number, deadzone = 22): number {
  if (count <= 0 || dx * dx + dy * dy < deadzone * deadzone) return -1;
  const angle = Math.atan2(dy, dx) + Math.PI / 2;
  const turn = ((angle / (Math.PI * 2)) % 1 + 1) % 1;
  return Math.round(turn * count) % count;
}

/** Draw one of the glyphs, centred on the origin, `r` pixels across. */
export function drawGlyph(ctx: CanvasRenderingContext2D, glyph: PingStyle['glyph'], r: number): void {
  ctx.beginPath();
  switch (glyph) {
    case 'diamond':
      ctx.moveTo(0, -r);
      ctx.lineTo(r, 0);
      ctx.lineTo(0, r);
      ctx.lineTo(-r, 0);
      ctx.closePath();
      ctx.fill();
      break;
    case 'skull':
      ctx.arc(0, -r * 0.2, r * 0.75, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillRect(-r * 0.45, r * 0.2, r * 0.9, r * 0.7);
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.beginPath();
      ctx.arc(-r * 0.3, -r * 0.25, r * 0.22, 0, Math.PI * 2);
      ctx.arc(r * 0.3, -r * 0.25, r * 0.22, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      break;
    case 'arrow':
      ctx.moveTo(0, -r);
      ctx.lineTo(r, r * 0.2);
      ctx.lineTo(r * 0.35, r * 0.2);
      ctx.lineTo(r * 0.35, r);
      ctx.lineTo(-r * 0.35, r);
      ctx.lineTo(-r * 0.35, r * 0.2);
      ctx.lineTo(-r, r * 0.2);
      ctx.closePath();
      ctx.fill();
      break;
    case 'crate':
      ctx.rect(-r * 0.85, -r * 0.7, r * 1.7, r * 1.4);
      ctx.fill();
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillRect(-r * 0.12, -r * 0.7, r * 0.24, r * 1.4);
      ctx.fillRect(-r * 0.85, -r * 0.1, r * 1.7, r * 0.2);
      ctx.restore();
      break;
    case 'cross':
      ctx.rect(-r * 0.3, -r, r * 0.6, r * 2);
      ctx.rect(-r, -r * 0.3, r * 2, r * 0.6);
      ctx.fill();
      break;
    case 'flame':
      ctx.moveTo(0, -r);
      ctx.quadraticCurveTo(r * 1.1, -r * 0.1, r * 0.55, r * 0.75);
      ctx.quadraticCurveTo(r * 0.3, r * 1.05, 0, r);
      ctx.quadraticCurveTo(-r * 0.3, r * 1.05, -r * 0.55, r * 0.75);
      ctx.quadraticCurveTo(-r * 1.1, -r * 0.1, 0, -r);
      ctx.fill();
      break;
    case 'shield':
      ctx.moveTo(0, -r);
      ctx.lineTo(r * 0.9, -r * 0.6);
      ctx.lineTo(r * 0.75, r * 0.3);
      ctx.lineTo(0, r);
      ctx.lineTo(-r * 0.75, r * 0.3);
      ctx.lineTo(-r * 0.9, -r * 0.6);
      ctx.closePath();
      ctx.fill();
      break;
  }
}
