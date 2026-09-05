/**
 * Follow camera with a deadzone.
 *
 * The deadzone means small movements do not drag the world around, which keeps
 * the picture steady while still framing the player during a run. Shake and the
 * damage flash live here too: both are draw-only and never feed back into the
 * simulation, so they cannot affect determinism.
 */
import { CAMERA } from '@boxhead/shared';

export class Camera {
  x = 0;
  y = 0;
  /** Interpolated position used for drawing; lags `x`/`y` by the frame alpha. */
  drawX = 0;
  drawY = 0;
  private prevX = 0;
  private prevY = 0;

  /** Canvas pixels per world pixel. Set from the viewport on resize. */
  zoom = 1;

  constructor(
    public viewWidth: number,
    public viewHeight: number,
    private readonly worldWidth: number,
    private readonly worldHeight: number,
  ) {}

  /**
   * Choose a zoom that shows roughly a fixed slice of the arena, the way the
   * original's fixed stage did, whatever the window size.
   *
   * The zoom covers the canvas rather than fitting inside it: taking the larger
   * of the two axis ratios means a wide window shows more arena horizontally
   * instead of letterboxing the map into the middle of the screen. The targets
   * are also capped by the map, so a small arena is never zoomed out past its
   * own edges.
   */
  resize(
    canvasWidth: number,
    canvasHeight: number,
    targetWorldWidth: number,
    targetWorldHeight: number,
  ): void {
    const zoomX = canvasWidth / Math.min(this.worldWidth, targetWorldWidth);
    const zoomY = canvasHeight / Math.min(this.worldHeight, targetWorldHeight);
    this.zoom = Math.max(zoomX, zoomY);
    this.viewWidth = canvasWidth / this.zoom;
    this.viewHeight = canvasHeight / this.zoom;
    this.clamp();
  }

  /** Snap to a target immediately, e.g. on spawn. */
  jumpTo(targetX: number, targetY: number): void {
    this.x = targetX;
    this.y = targetY;
    this.clamp();
    this.prevX = this.x;
    this.prevY = this.y;
  }

  /** Call once per simulation step. */
  follow(targetX: number, targetY: number): void {
    this.prevX = this.x;
    this.prevY = this.y;

    const dx = targetX - this.x;
    const dy = targetY - this.y;
    let wantX = this.x;
    let wantY = this.y;
    if (Math.abs(dx) > CAMERA.deadzoneX) {
      wantX = targetX - Math.sign(dx) * CAMERA.deadzoneX;
    }
    if (Math.abs(dy) > CAMERA.deadzoneY) {
      wantY = targetY - Math.sign(dy) * CAMERA.deadzoneY;
    }
    this.x += (wantX - this.x) * CAMERA.follow;
    this.y += (wantY - this.y) * CAMERA.follow;
    this.clamp();
  }

  private clamp(): void {
    const halfW = this.viewWidth / 2;
    const halfH = this.viewHeight / 2;
    // When the arena is smaller than the view, centre it rather than clamping.
    this.x = this.worldWidth <= this.viewWidth
      ? this.worldWidth / 2
      : Math.max(halfW, Math.min(this.worldWidth - halfW, this.x));
    this.y = this.worldHeight <= this.viewHeight
      ? this.worldHeight / 2
      : Math.max(halfH, Math.min(this.worldHeight - halfH, this.y));
  }

  /** Resolve the drawing position for this frame. */
  interpolate(alpha: number): void {
    this.drawX = this.prevX + (this.x - this.prevX) * alpha;
    this.drawY = this.prevY + (this.y - this.prevY) * alpha;
  }

  /** Top-left of the visible world rectangle. */
  get originX(): number {
    return this.drawX - this.viewWidth / 2;
  }

  get originY(): number {
    return this.drawY - this.viewHeight / 2;
  }

  /** Canvas pixels to world coordinates. */
  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: sx / this.zoom + this.originX, y: sy / this.zoom + this.originY };
  }

  /** World coordinates to canvas pixels. */
  worldToScreen(x: number, y: number): { x: number; y: number } {
    return { x: (x - this.originX) * this.zoom, y: (y - this.originY) * this.zoom };
  }

  /** Generous bounds test, so entities are not culled at the screen edge. */
  isVisible(x: number, y: number, margin = 80): boolean {
    return (
      x > this.originX - margin &&
      x < this.originX + this.viewWidth + margin &&
      y > this.originY - margin &&
      y < this.originY + this.viewHeight + margin
    );
  }
}
