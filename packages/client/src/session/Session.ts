/**
 * A session is whatever owns the world the player is looking at.
 *
 * Single player owns a world outright and steps it. A networked session owns
 * a predicted copy of the server's world and keeps it honest. The loop,
 * camera, renderer and HUD do not care which: they ask the session for the
 * world and the local seat, drive one step per tick, and draw.
 */
import type { ExtractedRoom, SoundEvent, World } from '@boxhead/shared';
import type { Input } from '../input/Input.js';
import type { Camera } from '../render/Camera.js';

export type SessionStatus = 'running' | 'waiting' | 'ended' | 'disconnected';

export interface Presenter {
  /** Sound requests the session wants heard; the host positions them. */
  playSound: (event: SoundEvent) => void;
  /** The world object was replaced; renderer, HUD and camera must rebind. */
  worldReplaced: () => void;
}

export interface Session {
  readonly world: World;
  readonly room: ExtractedRoom;
  readonly localPlayerIndex: number;
  /** Wall milliseconds per simulated step. */
  readonly stepMs: number;
  readonly status: SessionStatus;
  /** True when the run's result should go into the local high-score table. */
  readonly recordsScores: boolean;
  /** One fixed step: sample input, advance or predict, hand over cosmetics. */
  step(input: Input, camera: Camera, present: Presenter): void;
  /** Lines for the F3 overlay. */
  stats(): string[];
  dispose(): void;
}
