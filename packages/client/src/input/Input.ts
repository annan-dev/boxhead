/**
 * Keyboard and mouse, collapsed into the simulation's InputCommand.
 *
 * Edge-triggered actions (weapon switching) are latched here and cleared once
 * per simulation step rather than per frame, so a tap is never missed and never
 * counted twice when the display runs faster than the simulation.
 */
import { emptyCommand, type InputCommand } from '@boxhead/shared';

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

  constructor(private readonly target: HTMLCanvasElement) {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    target.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointermove', this.onPointerMove);
    target.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    this.target.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointermove', this.onPointerMove);
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat) return;
    // The game owns these keys; let everything else through.
    if (event.code in MOVE_KEYS || event.code in SLOT_KEYS || event.code === 'Space') {
      event.preventDefault();
    }
    this.down.add(event.code);

    const slot = SLOT_KEYS[event.code];
    if (slot !== undefined) this.pendingSlot = slot;
    if (event.code === 'KeyE' || event.code === 'BracketRight') this.pendingNext = true;
    if (event.code === 'KeyQ' || event.code === 'BracketLeft') this.pendingPrev = true;
    if (event.code === 'KeyP' || event.code === 'Escape') this.pausePressed = true;
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.down.delete(event.code);
  };

  /** Losing focus mid-key would otherwise leave the player running forever. */
  private readonly onBlur = (): void => {
    this.down.clear();
    this.pointerDown = false;
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.pointerDown = true;
    this.updatePointer(event);
  };

  private readonly onPointerUp = (): void => {
    this.pointerDown = false;
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    this.updatePointer(event);
  };

  private updatePointer(event: PointerEvent): void {
    const rect = this.target.getBoundingClientRect();
    this.pointerX = ((event.clientX - rect.left) / rect.width) * this.target.width;
    this.pointerY = ((event.clientY - rect.top) / rect.height) * this.target.height;
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  /** True once per press. */
  consumePause(): boolean {
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
    command.aimX = aimX;
    command.aimY = aimY;
    command.fire = this.pointerDown || this.down.has('Space');
    command.weaponSlot = this.pendingSlot;
    command.nextWeapon = this.pendingNext;
    command.prevWeapon = this.pendingPrev;

    this.pendingSlot = null;
    this.pendingNext = false;
    this.pendingPrev = false;
    return command;
  }
}
