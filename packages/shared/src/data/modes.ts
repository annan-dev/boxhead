/**
 * Game modes, as the original distinguishes them.
 *
 * The SWF keeps one flag, `CWorld.mGameMode` ("Single", "Coop" or
 * "DeathMatch"), and a handful of classes branch on it. Everything below was
 * recovered by following those branches; each field says where it came from,
 * and the few that are the port's own choice say so.
 *
 * What the bytecode says about deathmatch:
 *
 * - `CUpgrades.Process` returns at once when the mode is DeathMatch, and it is
 *   the only caller of `CWorld.Spawn_Zombie` / `Spawn_Devil`: no creature ever
 *   spawns, the multiplier never drains and no level ever advances.
 * - `CUpgrades.SetDifficulty` ignores the difficulty in DeathMatch and forces
 *   level 1 with multiplier 200, which banks every award. `CWorld.InitCleanUp`
 *   then calls `ResetWeapons` on each player in DeathMatch only: every weapon
 *   but the pistol is emptied and the pistol is drawn, so the arsenal is
 *   owned but unloaded until a crate is found.
 * - Bullets hit anything whose affect flags include Bullet except the shooter
 *   (`CMap_Cell.LineIntersection_ThingList`: `mID != shooter && mAffectFlags &
 *   cAffectFlags`), and a player's flags include Bullet and Explosion
 *   (`CThing_Creature_Player.State_Respawn`). Explosions hit everything in
 *   range (`CMap_Affect.AffectArea`). So players hurt each other in *every*
 *   mode there, gated only by the global Damage option
 *   (`CThing_Creature.mDamageActive`, default on), which when off makes players
 *   ignore Bullet and Explosion affects entirely -- their own blasts included.
 * - `CWorld.LogKill` keeps one death counter per player (`CHud.mPlayerN_Deaths`)
 *   and awards no score for a player kill; in DeathMatch it drops a crate where
 *   the victim fell. `CWorld.PlayerDead` ends a deathmatch when a player's
 *   deaths reach `CWorld.mNumberOfGameKills[mGameAmount]`, i.e. 50/20/10/5 for
 *   the Games 1-4 option (default index 1: 20), and the *other* player wins
 *   (`CMain.State_RunWorld` -> `CScreen_Debrief_Winner`, "PLAYER n WINS").
 *   There is no timer.
 * - `CThing_Creature_Player.State_Respawn`: a dead player waits 25 original
 *   ticks, reappears near the other player with full life, and is invincible
 *   for 25 * 5 ticks in DeathMatch against 25 otherwise. Respawns are
 *   unlimited; outside DeathMatch the run ends when the live player count hits
 *   zero (`PlayerDead`, "player dead").
 * - `CThing_Object_Mine`: trip flags are Creature, plus Player in DeathMatch.
 * - `CThing_Object_Pickup.PickedUp`: a room crate reappears after 30 seconds
 *   in DeathMatch, 10 otherwise.
 * - `CThing_Creature_Player.State_Respawn` places the returning player with
 *   `Spawn_ValidPosition_Close` (nearest player spawn point to the other
 *   player) in co-op and `Spawn_ValidPosition_Far` in DeathMatch.
 */
import type { GameMode } from '../net/Protocol.js';
import { ORIGINAL_TICK_RATIO } from './tuning.js';
import { SCORING } from './levels.js';

export interface ModeDef {
  id: GameMode;
  name: string;
  /** A player's shots and blasts land on other players: versus play. */
  playersHurtEachOther: boolean;
  /** A player's blasts land on teammates. Their own blast always hurts them. */
  friendlyFire: boolean;
  /** Waves spawn at all. */
  zombies: boolean;
  /** Scale on each level's zombie total, when waves spawn. */
  zombieMul?: number;
  /** Player kills that end the match, or null for none. */
  killTarget: number | null;
  /** Tick at which the match ends on kills, or null for none. */
  timeLimitTicks: number | null;
  /** Ticks a fallen player waits before returning; default `PLAYER.respawnTicks`. */
  respawnTicks?: number;
  /** Spawn protection after a respawn; default `PLAYER.respawnInvincibleTicks`. */
  respawnInvincibleTicks?: number;
  /** One score and multiplier for the room; false gives each player a tally. */
  sharedScore: boolean;
  /** Multiplier banked at the start regardless of difficulty, with its awards. */
  startMultiplier?: number;
  /** Every weapon but the pistol starts empty (`CWorld.InitCleanUp` -> `ResetWeapons`). */
  startEmpty: boolean;
  /** A fallen player leaves a crate. */
  dropCrateOnPlayerDeath: boolean;
  /** Claymores go off under players too. */
  minesTripPlayers: boolean;
  /**
   * Claymores wait until nobody stands on their cell before arming
   * (`Process_WaitForCollideFlags0`), so the placer cannot trip their own.
   */
  minesArmWhenClear: boolean;
  /** Ticks before a room's own crate comes back once taken. */
  crateRespawnTicks: number;
  /** A fallen player comes back near the other player, or as far from them as possible. */
  respawnNear: boolean;
}

/**
 * Kills that decide a deathmatch, per the original's Games 1-4 option
 * (`CWorld.mNumberOfGameKills`); the option defaults to index 1.
 */
export const DEATHMATCH_KILL_TARGETS = [50, 20, 10, 5] as const;

export const MODES: Record<GameMode, ModeDef> = {
  coop: {
    id: 'coop',
    name: 'Co-op',
    // Port's choice. The original lets players hurt each other in co-op
    // whenever its Damage option is on (the default); that option is not
    // ported, and the port keeps teammates' fire harmless instead.
    playersHurtEachOther: false,
    friendlyFire: false,
    zombies: true, // CUpgrades.Process runs normally
    killTarget: null, // CWorld.PlayerDead only ends the run at zero live players
    timeLimitTicks: null,
    sharedScore: true, // CUpgrades.mScore / CHud.mcScoreTotal
    startEmpty: false,
    dropCrateOnPlayerDeath: false, // CWorld.LogKill, DeathMatch branch only
    minesTripPlayers: false, // CThing_Object_Mine.Process_Init
    minesArmWhenClear: false,
    crateRespawnTicks: SCORING.pickupRespawnTicks, // PickedUp: mFPS * 10
    respawnNear: true, // Spawn_ValidPosition_Close
  },
  deathmatch: {
    id: 'deathmatch',
    name: 'Deathmatch',
    playersHurtEachOther: true, // LineIntersection_ThingList + Affect_Setup flags
    friendlyFire: true,
    zombies: false, // CUpgrades.Process returns at once in DeathMatch
    killTarget: DEATHMATCH_KILL_TARGETS[1], // CWorld.mNumberOfGameKills[mGameAmount = 1]
    timeLimitTicks: null, // no timer anywhere in CWorld / CMain
    respawnTicks: 25 * ORIGINAL_TICK_RATIO, // State_Dead -> State_Respawn, mStateCount = 25
    respawnInvincibleTicks: 25 * 5 * ORIGINAL_TICK_RATIO, // State_Respawn: 25 * (DeathMatch ? 5 : 1)
    sharedScore: false, // CHud shows Hud_PlayerFrags instead of the score total
    startMultiplier: 200, // CUpgrades.SetDifficulty: multiplier 200, level 1
    startEmpty: true, // CWorld.InitCleanUp: ResetWeapons in DeathMatch
    dropCrateOnPlayerDeath: true, // CWorld.LogKill: _CreatePickup at the victim
    minesTripPlayers: true, // CThing_Object_Mine: Creature | Player in DeathMatch
    minesArmWhenClear: true, // CThing_Object_Mine.Process_Init, DeathMatch branch
    crateRespawnTicks: SCORING.pickupRespawnTicksDeathmatch, // PickedUp: mFPS * 30
    respawnNear: false, // Spawn_ValidPosition_Far
  },
};
