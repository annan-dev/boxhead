/**
 * Client-side prediction bookkeeping.
 *
 * A client runs the same simulation as the server, one tick ahead per tick of
 * its own input, so its own character answers immediately. When a snapshot
 * arrives the client restores it and replays every command the server has not
 * consumed yet. If the server agreed with the prediction, the replay lands on
 * the same state and nobody sees a thing; if not, the correction is applied
 * here and smoothed by the renderer.
 *
 * Nothing in this file touches the browser, so the node tests can exercise
 * the same code the client runs.
 */
import { World, emptyCommand, type InputCommand } from '../sim/World.js';
import type { PlayerSnapshot, WorldSnapshot } from '../sim/Snapshot.js';
import type { StampedCommand } from './Protocol.js';

/** Commands sent but not yet acknowledged, oldest first. */
export class InputHistory {
  private readonly entries: StampedCommand[] = [];

  push(entry: StampedCommand): void {
    this.entries.push(entry);
  }

  /** Forget everything the server has consumed. */
  ack(tick: number): void {
    let drop = 0;
    while (drop < this.entries.length && this.entries[drop]!.tick <= tick) drop += 1;
    if (drop > 0) this.entries.splice(0, drop);
  }

  clear(): void {
    this.entries.length = 0;
  }

  get unacked(): readonly StampedCommand[] {
    return this.entries;
  }

  get length(): number {
    return this.entries.length;
  }
}

export interface ReconcileHooks {
  /** Called after each replayed step, e.g. to discard sounds already played. */
  onReplayStep?: (world: World, replayed: StampedCommand) => void;
}

/**
 * Restore an authoritative snapshot and replay the unacknowledged commands
 * on top of it. Returns how many ticks were replayed. `remote` supplies the
 * best guess for every other seat, since their real inputs are unknown.
 */
export function reconcile(
  world: World,
  snapshot: WorldSnapshot,
  localIndex: number,
  unacked: readonly StampedCommand[],
  remote: (index: number) => InputCommand,
  hooks: ReconcileHooks = {},
): number {
  world.restore(snapshot);
  const commands: InputCommand[] = [];
  for (let i = 0; i < world.players.length; i++) {
    commands[i] = i === localIndex ? emptyCommand() : remote(i);
  }
  for (const entry of unacked) {
    commands[localIndex] = entry.command;
    world.step(commands);
    hooks.onReplayStep?.(world, entry);
  }
  return unacked.length;
}

/**
 * Guess what a remote player is holding from two of their snapshots: they
 * probably keep walking the way they were, keep aiming where they were, and
 * keep the trigger as it was. Wrong guesses are corrected by the next
 * snapshot, a few ticks later.
 */
export function inferRemoteCommand(
  previous: PlayerSnapshot | undefined,
  current: PlayerSnapshot,
  dtTicks: number,
): InputCommand {
  const command = emptyCommand();
  if (current.state !== 'alive' || !current.connected) return command;
  if (previous && dtTicks > 0 && current.moving) {
    const dx = (current.x - previous.x) / dtTicks;
    const dy = (current.y - previous.y) / dtTicks;
    const length = Math.hypot(dx, dy);
    if (length > 0.05) {
      command.moveX = dx / length;
      command.moveY = dy / length;
    }
  }
  command.aimX = current.x + Math.cos(current.angle) * 100;
  command.aimY = current.y + Math.sin(current.angle) * 100;
  command.fire = current.firingHeld;
  return command;
}
