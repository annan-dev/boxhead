/**
 * Keyboard, mouse and gamepad, collapsed into the simulation's InputCommand.
 *
 * Edge-triggered actions (weapon switching) are latched here and cleared once
 * per simulation step rather than per frame, so a tap is never missed and never
 * counted twice when the display runs faster than the simulation.
 *
 * A gamepad is polled once per step. The left stick or d-pad moves, the right
 * stick aims (relative to the player, since there is no pointer), the right
 * trigger or A fires, the bumpers cycle weapons, Start pauses. Whichever
 * device was touched last owns the aim, so a mouse still works with a pad
 * plugged in.
 */
import { emptyCommand, type InputCommand } from '@boxhead/shared';

/** Standard-mapping gamepad buttons. */
const PAD = {
  a: 0,
  b: 1,
  y: 3,
  lb: 4,
  rb: 5,
  rt: 7,
  start: 9,
  up: 12,
  down: 13,
  left: 14,
  right: 15,
} as const;
const STICK_DEADZONE = 0.25;
/** How far ahead of the player the right stick aims, in world pixels. */
const PAD_AIM_REACH = 180;

/** Read the first connected gamepad, or null. */
export function firstGamepad(): Gamepad | null {
  if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
  for (const pad of navigator.getGamepads()) {
    if (pad && pad.connected) return pad;
  }
  return null;
}

function pressed(pad: Gamepad, index: number): boolean {
  const button = pad.buttons[index];
  return !!button && (button.pressed || button.value > 0.5);
}

function axis(pad: Gamepad, index: number): number {
  const value = pad.axes[index] ?? 0;
  return Math.abs(value) < STICK_DEADZONE ? 0 : value;
}

const MOVE_KEYS: Record<string, [number, number]> = {
  KeyW: [0, -1],
  ArrowUp: [0, -1],
  KeyS: [0, 1],
  ArrowDown: [0, 1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};

const SLOT_KEYS: Record<string, number> = {
  Digit1: 1,
  Digit2: 2,
  Digit3: 3,
  Digit4: 4,
  Digit5: 5,
  Digit6: 6,
  Digit7: 7,
  Digit8: 8,
  Digit9: 9,
  Digit0: 0,
};

export class Input {
  private readonly down = new Set<string>();
  private pendingSlot: number | null = null;
  private pendingNext = false;
  private pendingPrev = false;
  private pointerDown = false;
  /** Pointer position in canvas pixels; the game converts to world space. */
  pointerX = 0;
  pointerY = 0;
  /** Latched once per step so a tap on a fast display is not lost. */
  private pausePressed = false;
  /** False while a menu owns the keyboard, so play keys are not intercepted. */
  private enabled = true;
  /** Gamepad button states from the last poll, for edge detection. */
  private padHeld = new Set<number>();
  /** Right-stick direction, unit length, while the pad owns the aim. */
  private padAimX = 0;
  private padAimY = 0;
  /** True once the pad moved the aim more recently than the mouse did. */
  private padAims = false;
  private padMoveX = 0;
  private padMoveY = 0;
  private padFire = false;
  /** Whether a gamepad has been seen at all, for the hint text. */
  padSeen = false;

  /** True while the pad, not the mouse, owns the aim. */
  get padOwnsAim(): boolean {
    return this.padAims;
  }

  constructor(private readonly target: HTMLCanvasElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    target.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointermove', this.onPointerMove);
    target.addEventListener('contextmenu', (event) => event.preventDefault());
    // Wheel cycles weapons; passive:false so the page does not scroll too.
    target.addEventListener('wheel', this.onWheel, { passive: false });
  }

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    if (!this.enabled || event.deltaY === 0) return;
    if (event.deltaY > 0) this.pendingNext = true;
    else this.pendingPrev = true;
  };

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.target.removeEventListener('pointerdown', this.onPointerDown);
    this.target.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointermove', this.onPointerMove);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat || !this.enabled) return;
    // The game owns these keys; let everything else through.
    if (event.code in MOVE_KEYS || event.code in SLOT_KEYS || event.code === 'Space') {
      event.preventDefault();
    }
    this.down.add(event.code);

    const slot = SLOT_KEYS[event.code];
    if (slot !== undefined) this.pendingSlot = slot;
    if (event.code === 'KeyE' || event.code === 'BracketRight') this.pendingNext = true;
    if (event.code === 'KeyQ' || event.code === 'BracketLeft') this.pendingPrev = true;
    if (event.code === 'KeyP') this.pausePressed = true;
  };

  /** Hand the keyboard to the menus, or take it back for play. */
  setEnabled(value: boolean): void {
    if (this.enabled === value) return;
    this.enabled = value;
    // Whatever was held or tapped while the menu was up must not carry over.
    this.down.clear();
    this.pointerDown = false;
    this.clearLatches();
  }

  /** Drop any edge-triggered presses so a fresh run starts from nothing. */
  clearLatches(): void {
    this.pendingSlot = null;
    this.pendingNext = false;
    this.pendingPrev = false;
    this.pausePressed = false;
  }

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.down.delete(event.code);
  };

  /** Losing focus mid-key would otherwise leave the player running forever. */
  private readonly onBlur = (): void => {
    this.down.clear();
    this.pointerDown = false;
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.enabled) return;
    this.updatePointer(event);
    // Only the primary button fires; the context menu is suppressed, so a
    // right click would otherwise shoot.
    if (event.button !== 0) return;
    this.pointerDown = true;
  };

  private readonly onPointerUp = (): void => {
    this.pointerDown = false;
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    this.updatePointer(event);
  };

  /**
   * Read the gamepad once per step. Edge-triggered buttons latch the same
   * way key presses do; the sticks are sampled.
   */
  private pollGamepad(): void {
    const pad = firstGamepad();
    if (!pad) {
      this.padMoveX = 0;
      this.padMoveY = 0;
      this.padFire = false;
      this.padHeld.clear();
      return;
    }
    this.padSeen = true;
    const now = new Set<number>();
    for (let i = 0; i < pad.buttons.length; i++) if (pressed(pad, i)) now.add(i);
    const rose = (index: number): boolean => now.has(index) && !this.padHeld.has(index);

    if (this.enabled) {
      let mx = axis(pad, 0);
      let my = axis(pad, 1);
      if (now.has(PAD.left)) mx = -1;
      if (now.has(PAD.right)) mx = 1;
      if (now.has(PAD.up)) my = -1;
      if (now.has(PAD.down)) my = 1;
      this.padMoveX = Math.max(-1, Math.min(1, mx));
      this.padMoveY = Math.max(-1, Math.min(1, my));

      const ax = axis(pad, 2);
      const ay = axis(pad, 3);
      if (ax !== 0 || ay !== 0) {
        const length = Math.hypot(ax, ay);
        this.padAimX = ax / length;
        this.padAimY = ay / length;
        this.padAims = true;
      } else if (this.padAims && (mx !== 0 || my !== 0)) {
        // No aim input: face the way we walk, as the original did.
        const length = Math.hypot(mx, my);
        this.padAimX = mx / length;
        this.padAimY = my / length;
      }

      this.padFire = now.has(PAD.rt) || now.has(PAD.a);
      if (rose(PAD.rb) || rose(PAD.y)) this.pendingNext = true;
      if (rose(PAD.lb)) this.pendingPrev = true;
    }
    if (rose(PAD.start)) this.pausePressed = true;
    this.padHeld = now;
  }

  /**
   * Where the local player aims this step, in world space: the pointer, or
   * a point out along the right stick when the pad spoke last.
   */
  aimWorld(
    camera: { screenToWorld: (sx: number, sy: number) => { x: number; y: number } },
    playerX: number,
    playerY: number,
  ): { x: number; y: number } {
    this.pollGamepad();
    if (this.padAims) {
      return { x: playerX + this.padAimX * PAD_AIM_REACH, y: playerY + this.padAimY * PAD_AIM_REACH };
    }
    return camera.screenToWorld(this.pointerX, this.pointerY);
  }

  private updatePointer(event: PointerEvent): void {
    const rect = this.target.getBoundingClientRect();
    // Before layout settles the canvas can measure zero; a division by that
    // would poison the aim with NaN and the player would stop being drawn.
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = ((event.clientX - rect.left) / rect.width) * this.target.width;
    const y = ((event.clientY - rect.top) / rect.height) * this.target.height;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    // A real pointer move takes the aim back from the pad.
    if (Math.abs(x - this.pointerX) + Math.abs(y - this.pointerY) > 2) this.padAims = false;
    this.pointerX = x;
    this.pointerY = y;
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  /** True once per press. Polls the pad so Start works while paused. */
  consumePause(): boolean {
    this.pollGamepad();
    const value = this.pausePressed;
    this.pausePressed = false;
    return value;
  }

  /**
   * Build the command for this simulation step.
   * `aim` is the pointer already converted to world coordinates.
   */
  buildCommand(aimX: number, aimY: number): InputCommand {
    const command = emptyCommand();
    for (const [code, [dx, dy]] of Object.entries(MOVE_KEYS)) {
      if (!this.down.has(code)) continue;
      command.moveX += dx;
      command.moveY += dy;
    }
    if (command.moveX === 0 && command.moveY === 0) {
      command.moveX = this.padMoveX;
      command.moveY = this.padMoveY;
    }
    command.aimX = aimX;
    command.aimY = aimY;
    command.fire = this.pointerDown || this.down.has('Space') || this.padFire;
    command.weaponSlot = this.pendingSlot;
    command.nextWeapon = this.pendingNext;
    command.prevWeapon = this.pendingPrev;

    this.pendingSlot = null;
    this.pendingNext = false;
    this.pendingPrev = false;
    return command;
  }
}
