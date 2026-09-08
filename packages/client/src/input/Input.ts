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

/** Standard-mapping gamepad buttons the d-pad and sticks use; the rest are bindable. */
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

/** The pad's actions a player may move to other buttons. */
export type PadAction = 'fire' | 'next' | 'prev' | 'menu' | 'pause';
export type PadBindings = Record<PadAction, number[]>;
export const DEFAULT_PAD: PadBindings = {
  fire: [PAD.rt, PAD.a],
  next: [PAD.rb],
  prev: [PAD.lb],
  menu: [PAD.b, PAD.y],
  pause: [PAD.start],
};
export const PAD_ACTION_LABELS: Record<PadAction, string> = {
  fire: 'Fire',
  next: 'Next weapon',
  prev: 'Previous weapon',
  menu: 'Pause menu',
  pause: 'Quick pause',
};
/** A standard-mapping button as a player knows it. */
export function padButtonName(index: number): string {
  const names: Record<number, string> = {
    0: 'A', 1: 'B', 2: 'X', 3: 'Y', 4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT', 8: 'Back', 9: 'Start',
    10: 'L stick', 11: 'R stick', 12: 'D-pad up', 13: 'D-pad down', 14: 'D-pad left', 15: 'D-pad right', 16: 'Guide',
  };
  return names[index] ?? `Button ${index}`;
}
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

/** The actions a player may rebind; weapon numbers stay on their keys. */
export type BindableAction = 'up' | 'down' | 'left' | 'right' | 'fire' | 'next' | 'prev' | 'pause';
export type Bindings = Record<BindableAction, string[]>;

export const DEFAULT_BINDINGS: Bindings = {
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  fire: ['Space'],
  next: ['KeyE', 'BracketRight'],
  prev: ['KeyQ', 'BracketLeft'],
  pause: ['KeyP'],
};

export const ACTION_LABELS: Record<BindableAction, string> = {
  up: 'Move up',
  down: 'Move down',
  left: 'Move left',
  right: 'Move right',
  fire: 'Fire',
  next: 'Next weapon',
  prev: 'Previous weapon',
  pause: 'Quick pause',
};

/** Keys the game keeps for itself; binding one would take it away. */
export const RESERVED_KEYS = new Set([
  'Escape', 'KeyR', 'KeyM', 'F3', 'Tab',
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0',
]);

/**
 * The pointer's other buttons, bindable like keys: `Mouse1` is the middle,
 * `Mouse2` the right. The thumb buttons are left alone: browsers use them
 * for back and forward and cannot be talked out of it.
 */
export function mouseCode(button: number): string | null {
  return button === 1 ? 'Mouse1' : button === 2 ? 'Mouse2' : null;
}

/** A key code as a player would read it on the cap. */
export function keyName(code: string): string {
  if (code === 'Mouse1') return 'Middle click';
  if (code === 'Mouse2') return 'Right click';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const names: Record<string, string> = {
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Space',
    BracketLeft: '[', BracketRight: ']', ShiftLeft: 'L Shift', ShiftRight: 'R Shift',
    ControlLeft: 'L Ctrl', ControlRight: 'R Ctrl', AltLeft: 'L Alt', AltRight: 'R Alt',
    Enter: 'Enter', Tab: 'Tab', Comma: ',', Period: '.', Slash: '/', Semicolon: ';',
    Quote: "'", Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`',
  };
  if (names[code]) return names[code]!;
  if (code.startsWith('Numpad')) return `Num ${code.slice(6).replace('Decimal', '.').replace('Divide', '/').replace('Multiply', '*').replace('Enter', 'Enter')}`;
  if (code.startsWith('Intl')) return code.slice(4);
  if (code === 'CapsLock') return 'Caps';
  if (code === 'ContextMenu') return 'Menu';
  // Whatever is left, split from its code style into words.
  return code.replace(/([a-z])([A-Z])/g, '$1 $2');
}

/**
 * The second seat's keys when two people share one keyboard: arrows move,
 * Enter or right Shift fires, comma and full stop cycle. Not rebindable.
 */
export const DEFAULT_SEAT_B: Bindings = {
  up: ['ArrowUp'],
  down: ['ArrowDown'],
  left: ['ArrowLeft'],
  right: ['ArrowRight'],
  fire: ['Enter', 'ShiftRight', 'Numpad0'],
  next: ['Period', 'NumpadAdd'],
  prev: ['Comma', 'NumpadSubtract'],
  pause: ['Backspace'],
};
const ARROWS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
let SEAT_B: Bindings = DEFAULT_SEAT_B;

const MOVE_DIRECTIONS: Record<'up' | 'down' | 'left' | 'right', [number, number]> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
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
  /** The pad asked for the pause menu (B or Y in play). */
  private menuPressed = false;
  /** Fire is ignored until every fire button has been let go, after a menu. */
  private padFireLatched = false;
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
  private bindings: Bindings = DEFAULT_BINDINGS;
  /** Key code to action, rebuilt whenever the bindings change. */
  private keyToAction = new Map<string, BindableAction>();
  /** Seats driven from this machine: one, or two sharing the screen. */
  private localPlayers = 1;
  private pad: PadBindings = DEFAULT_PAD;

  /** Install the second seat's keys; an empty action keeps its default. */
  setSeatBBindings(bindings: Partial<Bindings>): void {
    const merged = { ...DEFAULT_SEAT_B } as Bindings;
    for (const action of Object.keys(DEFAULT_SEAT_B) as BindableAction[]) {
      const keys = bindings[action];
      if (keys && keys.length > 0) merged[action] = keys;
    }
    SEAT_B = merged;
  }

  /** Install the pad's bindings; an empty action keeps its default. */
  setPadBindings(bindings: Partial<Record<PadAction, number[]>>): void {
    const merged = { ...DEFAULT_PAD };
    for (const action of Object.keys(DEFAULT_PAD) as PadAction[]) {
      const buttons = bindings[action];
      if (buttons && buttons.length > 0) merged[action] = buttons;
    }
    this.pad = merged;
  }
  /** The second seat's edge-triggered presses. */
  private latchB = { next: false, prev: false };
  /** The second seat faces the way it last walked when it has no stick. */
  private facingBX = 1;
  private facingBY = 0;

  /**
   * One or two players on this screen. With two, the pad belongs to the
   * second seat (or arrows and Enter when there is no pad) and the arrows
   * stop doubling as the first seat's movement keys.
   */
  setLocalPlayers(count: number): void {
    this.localPlayers = count >= 2 ? 2 : 1;
    this.latchB = { next: false, prev: false };
  }

  /** Which seat the pad drives. */
  private get padSeat(): number {
    return this.localPlayers === 2 ? 1 : 0;
  }

  /** Install a binding set; unknown or empty actions fall back to the defaults. */
  setBindings(bindings: Partial<Bindings>): void {
    const merged = { ...DEFAULT_BINDINGS } as Bindings;
    for (const action of Object.keys(DEFAULT_BINDINGS) as BindableAction[]) {
      const keys = bindings[action];
      if (keys && keys.length > 0) merged[action] = keys;
    }
    this.bindings = merged;
    this.keyToAction.clear();
    for (const action of Object.keys(merged) as BindableAction[]) {
      for (const code of merged[action]) this.keyToAction.set(code, action);
    }
  }

  /** The move keys currently bound to an action, for the hint text. */
  keysFor(action: BindableAction): string[] {
    return this.bindings[action];
  }

  /** True while the pad, not the mouse, owns the aim. */
  get padOwnsAim(): boolean {
    return this.padAims;
  }

  /** Shake the pad, where the browser lets us; a no-op otherwise. */
  rumble(ms: number, strong: number, weak = strong * 0.6): void {
    const pad = firstGamepad();
    const actuator = (pad as (Gamepad & { vibrationActuator?: { playEffect?: (type: string, params: object) => Promise<unknown> } }) | null)
      ?.vibrationActuator;
    if (!actuator?.playEffect) return;
    try {
      void actuator
        .playEffect('dual-rumble', { duration: ms, strongMagnitude: strong, weakMagnitude: weak })
        .catch(() => undefined);
    } catch {
      // Not every pad or browser supports it.
    }
  }

  constructor(private readonly target: HTMLCanvasElement) {
    this.setBindings({});
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
    const seatB = this.localPlayers === 2 && this.seatBAction(event.code);
    const action = seatB ? undefined : this.seatAAction(event.code);
    if (action || seatB || event.code in SLOT_KEYS) event.preventDefault();
    this.down.add(event.code);

    const slot = SLOT_KEYS[event.code];
    if (slot !== undefined) this.pendingSlot = slot;
    if (action === 'next') this.pendingNext = true;
    if (action === 'prev') this.pendingPrev = true;
    if (action === 'pause') this.pausePressed = true;
    if (seatB === 'next') this.latchB.next = true;
    if (seatB === 'prev') this.latchB.prev = true;
    if (seatB === 'pause') this.pausePressed = true;
  };

  /** The first seat's action for a key; arrows are the second seat's when it exists. */
  private seatAAction(code: string): BindableAction | undefined {
    if (this.localPlayers === 2 && (ARROWS.has(code) || this.seatBAction(code))) return undefined;
    return this.keyToAction.get(code);
  }

  private seatBAction(code: string): BindableAction | undefined {
    for (const action of Object.keys(SEAT_B) as BindableAction[]) {
      if (SEAT_B[action].includes(code)) return action;
    }
    return undefined;
  }

  private seatAHeld(action: BindableAction): boolean {
    return this.bindings[action].some((code) => this.down.has(code) && this.seatAAction(code) === action);
  }

  private seatBHeld(action: BindableAction): boolean {
    return SEAT_B[action].some((code) => this.down.has(code));
  }

  /** Hand the keyboard to the menus, or take it back for play. */
  setEnabled(value: boolean): void {
    if (this.enabled === value) return;
    this.enabled = value;
    // Whatever was held or tapped while the menu was up must not carry over.
    this.down.clear();
    this.pointerDown = false;
    this.clearLatches();
    if (value) this.syncPad();
  }

  /**
   * Reseed the pad's button memory from what is held right now, so the A
   * that chose Resume is not read as a fresh press, and hold fire off until
   * every fire button has been released.
   */
  private syncPad(): void {
    const pad = firstGamepad();
    this.padHeld.clear();
    if (!pad) return;
    for (let i = 0; i < pad.buttons.length; i++) if (pressed(pad, i)) this.padHeld.add(i);
    this.padFireLatched = this.pad.fire.some((b) => this.padHeld.has(b));
    this.padFire = false;
  }

  /** True once per press of the pad's menu button. */
  consumeMenu(): boolean {
    const value = this.menuPressed;
    this.menuPressed = false;
    return value;
  }

  /** Drop any edge-triggered presses so a fresh run starts from nothing. */
  clearLatches(): void {
    this.pendingSlot = null;
    this.pendingNext = false;
    this.pendingPrev = false;
    this.pausePressed = false;
    this.menuPressed = false;
    this.latchB = { next: false, prev: false };
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
    // The primary button fires; the others do whatever they are bound to,
    // held like keys. The context menu is suppressed, so right click is free.
    if (event.button === 0) {
      this.pointerDown = true;
      return;
    }
    const code = mouseCode(event.button);
    if (!code) return;
    event.preventDefault();
    this.down.add(code);
    const action = this.seatAAction(code);
    if (action === 'next') this.pendingNext = true;
    if (action === 'prev') this.pendingPrev = true;
    if (action === 'pause') this.pausePressed = true;
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (event.button === 0) this.pointerDown = false;
    const code = mouseCode(event.button);
    if (code) this.down.delete(code);
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

      const fireHeld = this.pad.fire.some((b) => now.has(b));
      if (!fireHeld) this.padFireLatched = false;
      this.padFire = fireHeld && !this.padFireLatched;
      const latch = this.padSeat === 1 ? this.latchB : null;
      if (this.pad.next.some(rose)) {
        if (latch) latch.next = true;
        else this.pendingNext = true;
      }
      if (this.pad.prev.some(rose)) {
        if (latch) latch.prev = true;
        else this.pendingPrev = true;
      }
      if (this.pad.menu.some(rose)) this.menuPressed = true;
    }
    if (this.pad.pause.some(rose)) this.pausePressed = true;
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
    if (this.padAims && this.padSeat === 0) {
      return { x: playerX + this.padAimX * PAD_AIM_REACH, y: playerY + this.padAimY * PAD_AIM_REACH };
    }
    return camera.screenToWorld(this.pointerX, this.pointerY);
  }

  /**
   * The second seat's aim: the pad's right stick when it has one, otherwise
   * the way it is walking or last walked, as the original's keyboard players
   * aimed. Call after `aimWorld` each step so the pad has been polled.
   */
  aimWorldB(playerX: number, playerY: number): { x: number; y: number } {
    if (this.padSeat === 1 && firstGamepad()) {
      if (this.padAimX !== 0 || this.padAimY !== 0) {
        return { x: playerX + this.padAimX * PAD_AIM_REACH, y: playerY + this.padAimY * PAD_AIM_REACH };
      }
    } else {
      let mx = 0;
      let my = 0;
      if (this.seatBHeld('up')) my -= 1;
      if (this.seatBHeld('down')) my += 1;
      if (this.seatBHeld('left')) mx -= 1;
      if (this.seatBHeld('right')) mx += 1;
      if (mx !== 0 || my !== 0) {
        const length = Math.hypot(mx, my);
        this.facingBX = mx / length;
        this.facingBY = my / length;
      }
    }
    return { x: playerX + this.facingBX * PAD_AIM_REACH, y: playerY + this.facingBY * PAD_AIM_REACH };
  }

  /** The second seat's command: its keys, or the pad when there are two players. */
  buildCommandB(aimX: number, aimY: number): InputCommand {
    const command = emptyCommand();
    if (this.padSeat === 1 && firstGamepad()) {
      command.moveX = this.padMoveX;
      command.moveY = this.padMoveY;
      command.fire = this.padFire;
    } else {
      if (this.seatBHeld('up')) command.moveY -= 1;
      if (this.seatBHeld('down')) command.moveY += 1;
      if (this.seatBHeld('left')) command.moveX -= 1;
      if (this.seatBHeld('right')) command.moveX += 1;
      command.fire = this.seatBHeld('fire');
    }
    command.aimX = aimX;
    command.aimY = aimY;
    command.nextWeapon = this.latchB.next;
    command.prevWeapon = this.latchB.prev;
    this.latchB.next = false;
    this.latchB.prev = false;
    return command;
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
    for (const direction of Object.keys(MOVE_DIRECTIONS) as Array<keyof typeof MOVE_DIRECTIONS>) {
      if (!this.seatAHeld(direction)) continue;
      const [dx, dy] = MOVE_DIRECTIONS[direction];
      command.moveX += dx;
      command.moveY += dy;
    }
    command.moveX = Math.max(-1, Math.min(1, command.moveX));
    command.moveY = Math.max(-1, Math.min(1, command.moveY));
    const padHere = this.padSeat === 0;
    if (padHere && command.moveX === 0 && command.moveY === 0) {
      command.moveX = this.padMoveX;
      command.moveY = this.padMoveY;
    }
    command.aimX = aimX;
    command.aimY = aimY;
    command.fire = this.pointerDown || this.seatAHeld('fire') || (padHere && this.padFire);
    command.weaponSlot = this.pendingSlot;
    command.nextWeapon = this.pendingNext;
    command.prevWeapon = this.pendingPrev;

    this.pendingSlot = null;
    this.pendingNext = false;
    this.pendingPrev = false;
    return command;
  }
}
