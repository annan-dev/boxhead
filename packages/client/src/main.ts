/**
 * Entry point and app state machine.
 *
 * The simulation lives in @boxhead/shared and knows nothing about the browser.
 * This module owns everything it must not: the canvas, the clock, input
 * devices, audio, menus and drawing.
 *
 * Whether the world is simulated here or predicted from a server is the
 * session's business (see session/Session.ts); this file drives whichever it
 * has and draws the result.
 */
import {
  ROOMS,
  TICK_MS,
  WEAPONS,
  circleBlocked,
  emptyCommand,
  serverUrl,
  type ArtPack,
  type ExtractedRoom,
  type Player,
  type SoundEvent,
  type WeaponId,
  type World,
  type WorldSnapshot,
} from '@boxhead/shared';
import { Loop } from './loop/Loop.js';
import { Input, keyName, type Bindings } from './input/Input.js';
import { Camera } from './render/Camera.js';
import { GameRenderer } from './render/GameRenderer.js';
import { Hud } from './ui/Hud.js';
import { Menus, type LobbyView, type RunResult, type ScreenArt } from './ui/Menus.js';
import { SaveData } from './state/SaveData.js';
import { AudioEngine, SOUND_NAMES } from './audio/AudioEngine.js';
import { MenuMusic } from './audio/MenuMusic.js';
import { GameMusic } from './audio/GameMusic.js';
import type { Presenter, Session } from './session/Session.js';
import { LocalSession } from './session/LocalSession.js';
import { NetSession } from './session/NetSession.js';
import { loadArtPack, loadJson } from './assets/AssetSource.js';
import { addCharacterHeads } from './render/HeadArt.js';

/**
 * Roughly how much arena to keep on screen, in world units. These set how
 * zoomed-in the game feels; the camera covers the canvas with whichever axis
 * needs the larger scale.
 */
const VIEW_WORLD_WIDTH = 720;
const VIEW_WORLD_HEIGHT = 460;
/** Two players on one screen see this much more arena. */
const SHARED_SCREEN_VIEW = 1.3;
let viewScale = 1;

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <style>
    :root { color-scheme: dark; }
    html, body { margin: 0; height: 100%; background: #07080a; overflow: hidden; }
    body { font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
           color: #dfe3e8; }
    #view { display: block; width: 100vw; height: 100vh; cursor: crosshair; }
    /* In play the HUD draws its own reticle; the browser's must not double it. */
    #view.aiming { cursor: none; }
    #boot { position: fixed; inset: 0; display: grid; place-content: center; gap: 10px;
            text-align: center; background: #07080a; z-index: 30; }
    #boot h1 { margin: 0; font: 400 34px/1 "Anton", Impact, "Arial Black", sans-serif; letter-spacing: .12em;
               color: #e9e2d0; text-transform: uppercase; text-shadow: 0 3px 0 #000, 0 0 24px rgba(224,17,31,.4); }
    #boot p { margin: 0; color: #857f72; max-width: 460px; line-height: 1.6; font: 700 11px "Segoe UI", system-ui, sans-serif;
              letter-spacing: .2em; text-transform: uppercase; }
    #boot code { color: #e6cf94; text-transform: none; letter-spacing: 0; font: 13px ui-monospace, Consolas, monospace; }
    /* A short reminder on entering a run, then it gets out of the way. */
    #hint { position: fixed; left: 50%; bottom: 84px; transform: translateX(-50%);
            color: #e9e2d0; background: rgba(12,12,14,.92); padding: 9px 18px; border: 1px solid rgba(201,167,90,.45);
            pointer-events: none; opacity: 0; font: 700 11px "Segoe UI", system-ui, sans-serif; letter-spacing: .16em;
            text-transform: uppercase; transition: opacity .5s; white-space: nowrap; box-shadow: 0 4px 0 #000, 0 8px 20px rgba(0,0,0,.6); }
    #hint.on { opacity: 1; }
    #hint b { color: #e6cf94; }
    /* Connection state while on a server; quiet unless something is wrong. */
    #net { position: fixed; top: 10px; right: 12px; z-index: 10; pointer-events: none;
           font: 700 11px "Segoe UI", system-ui, sans-serif; letter-spacing: .12em;
           text-transform: uppercase; color: rgba(233,226,208,.5); }
    #net.warn { color: #e6cf94; background: rgba(12,12,14,.9); border: 1px solid rgba(201,167,90,.5); padding: 4px 10px; }
  </style>
  <canvas id="view"></canvas>
  <div id="hint"></div>
  <div id="net" hidden></div>
  <div id="boot"><h1>Boxhead</h1><p>Loading art&hellip;</p></div>
`;

const canvas = app.querySelector<HTMLCanvasElement>('#view')!;
const ctx = canvas.getContext('2d', { alpha: false })!;
const boot = app.querySelector<HTMLDivElement>('#boot')!;
const hint = app.querySelector<HTMLDivElement>('#hint')!;
const netBadge = app.querySelector<HTMLDivElement>('#net')!;

let pack: ArtPack;
try {
  pack = await loadArtPack();
} catch {
  boot.innerHTML = `
    <h1>Boxhead</h1>
    <p>The art pack is missing. Extract it from your own copy of the SWF:</p>
    <p><code>npm run extract -- boxhead2play.swf</code></p>
    <p>Assets are never committed to the repository.</p>`;
  throw new Error('art.json is unavailable');
}
boot.remove();
// The SWF gives three of the four characters the same head; draw the rest.
addCharacterHeads(pack.textures);

// Development-only art gallery at /#gallery, for eyeballing extracted symbols.
if (import.meta.env.DEV && window.location.hash === '#gallery') {
  const { mountGallery } = await import('./dev/gallery.js');
  mountGallery(app, pack);
  throw new Error('gallery mode');
}

const rooms: ExtractedRoom[] = pack.rooms.length > 0 ? pack.rooms : ROOMS;
const save = new SaveData();
const input = new Input(canvas);
input.setBindings(save.keys as Partial<Bindings>);

// The original's own menu pictures: logo, level icons, portraits. Optional;
// the menus draw their own stand-ins when the manifest is absent.
const screens: ScreenArt | null = await loadJson<ScreenArt>('bitmaps/screens.json');

const audio = new AudioEngine();
void audio.init(SOUND_NAMES);
audio.setVolume(save.volume);
if (save.muted) audio.toggleMute();
// The menus' own track; it follows the master volume and mute through the engine.
const music = new MenuMusic(() => audio.bus());
music.setVolume(save.music);
// The bed under play, driven by how the fight is going; same slider.
const gameMusic = new GameMusic(() => audio.bus());
gameMusic.setVolume(save.music);
// Browsers only unlock audio on a gesture they count as activation, which
// an Escape press or a touch-start is not, so keep trying until it takes.
const unlock = (): void => {
  void audio.resume().then((running) => {
    if (!running) return;
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('pointerup', unlock);
    window.removeEventListener('keydown', unlock);
  });
};
window.addEventListener('pointerdown', unlock);
window.addEventListener('pointerup', unlock);
window.addEventListener('keydown', unlock);

/** Cheap noise for cosmetic ambience; never touches the simulation. */
let ambienceSeed = 0x1a2b3c;
const ambienceRandom = (): number => {
  ambienceSeed = (Math.imul(ambienceSeed, 1664525) + 1013904223) >>> 0;
  return ambienceSeed / 4294967296;
};

// ---- run state -----------------------------------------------------------

interface Run {
  session: Session;
  renderer: GameRenderer;
  hud: Hud;
  camera: Camera;
  /** What the run started with; a restart uses the same. */
  characterId: string;
  /** Eligibility as it stood at the start; the options screen may change it mid-run. */
  countsForHighScores: boolean;
  practiceReason: string | null;
}

let run: Run | null = null;
let paused = false;
let showStats = false;
let stepAverage = 0;
/** Set once the debrief has been shown, so it fires only on the first death. */
let debriefed = false;
/** The address typed for the current or last server, for the lobby screen. */
let netAddress = '';
let netStatus = '';
/** The last lobby the server described, re-shown when the link state changes. */
let lastLobby: Omit<LobbyView, 'address' | 'status'> | null = null;

/** Ticks the fallen player stays on screen before the debrief takes over. */
const DEATH_LINGER_TICKS = 75;
/** The fall plays out at this fraction of speed, so the moment lands. */
const DEATH_SLOW_MOTION = 0.4;
/** Frames the picture holds after a kill; longer for a multi-kill. */
const HIT_STOP_FRAMES = [0, 1, 2, 3, 4];
/** Ticks between hit stops, so a shredding uzi does not turn into a slideshow. */
const HIT_STOP_SPACING = 12;

/** Frames still to hold; the loop draws but does not step while it is up. */
let hitStop = 0;
let lastHitStopTick = -100;
let lastKills = 0;
let lastHurt = 0;
let slowMotion = false;

const menus = new Menus(app, pack, rooms, save, screens, {
  onStart: (roomId, characterId) => startRun(roomId, characterId),
  onContinue: () => continueRun(),
  onResume: () => {
    menus.show('none');
    paused = false;
  },
  onRestart: () => {
    if (!run || run.session instanceof NetSession) return;
    recordRun();
    startRun(run.session.room.id, run.characterId);
  },
  onQuit: () => {
    recordRun();
    endRun();
    menus.show('title');
  },
  onVolume: (value) => audio.setVolume(value),
  onMusic: (value) => {
    music.setVolume(value);
    gameMusic.setVolume(value);
  },
  onMuted: (value) => {
    if (audio.muted !== value) audio.toggleMute();
  },
  onFeel: () => applyFeelSettings(),
  onKeys: () => input.setBindings(save.keys as Partial<Bindings>),
  onPadSeen: () => {
    input.padSeen = true;
  },
  // The menus own the keyboard while they are up; play keys must not leak
  // through, and nothing pressed there may fire once play resumes.
  onScreen: (screen) => {
    input.setEnabled(screen === 'none');
    music.setScene(screen === 'none' ? 'off' : screen === 'pause' ? 'ducked' : 'full');
    gameMusic.setScene(screen === 'none' && run ? 'play' : screen === 'pause' && run ? 'ducked' : 'off');
  },
  onConnect: (address, name, characterId) => connect(address, name, characterId),
  onLeaveMatch: () => {
    endRun();
    menus.show('multiplayer');
  },
  onLobbyReady: (ready) => netSession()?.setReady(ready),
  onLobbyConfigure: (config) => netSession()?.configure(config),
  onLobbyStart: () => netSession()?.start(),
});

function netSession(): NetSession | null {
  return run?.session instanceof NetSession ? run.session : null;
}

let hintTimer = 0;
function showHint(text: string, ms = 4200): void {
  hint.innerHTML = text;
  hint.classList.add('on');
  window.clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => hint.classList.remove('on'), ms);
}

/**
 * One-time tips, each shown the first time its moment arrives in a
 * single-player run and never again: the things a new player would
 * otherwise learn by dying. The how-to-play screen covers the rest.
 */
interface Tip {
  id: string;
  text: string;
  when: (world: World, me: Player) => boolean;
}
const unlocked = (me: Player, id: string): boolean => me.weapons.get(id as never)?.unlocked === true;
const TIPS: Tip[] = [
  {
    id: 'crate',
    text: 'a <b>crate</b> &mdash; walk over it for ammo, or health when you are hurt',
    when: (world) => world.pickups.some((p) => p.alive && p.hiddenUntil === 0),
  },
  {
    id: 'drain',
    text: 'the <b>multiplier drains</b> when you stop killing &mdash; keep the streak up for the next award',
    when: (world) => world.multiplier >= 4 && world.multiplierTicksLeft < world.multiplierWindow * 0.4,
  },
  {
    id: 'devil',
    text: 'a <b>devil</b> &mdash; it throws fire and razes walls; shoot it first',
    when: (world) => world.enemies.some((e) => e.state === 'alive' && e.defId === 'devil'),
  },
  {
    id: 'barrel',
    text: '<b>barrels</b> (4) drop one cell ahead &mdash; zombies cannot pass, one shot sets it off',
    when: (_, me) => unlocked(me, 'barrel'),
  },
  {
    id: 'grenade',
    text: '<b>grenade</b> (5) &mdash; hold to throw farther, release to lob',
    when: (_, me) => unlocked(me, 'grenade'),
  },
  {
    id: 'wall',
    text: '<b>fake walls</b> (6) hold zombies off for good; only devils and your own fire bring them down',
    when: (_, me) => unlocked(me, 'fakewall'),
  },
  {
    id: 'mine',
    text: '<b>mines</b> (7) arm once you step off; whatever treads on one sets it off',
    when: (_, me) => unlocked(me, 'mine'),
  },
  {
    id: 'charge',
    text: '<b>charge packs</b> (9) &mdash; press to place, press again to blow them all',
    when: (_, me) => unlocked(me, 'chargepack'),
  },
  {
    id: 'hurt',
    text: '<b>health comes back</b> on its own &mdash; back off and let it',
    when: (_, me) => me.life < me.maxLife * 0.4,
  },
];
let tipCooldown = 0;

/** Show the first tip whose moment has come, one at a time, spaced out. */
function offerTips(world: World, me: Player): void {
  if (!save.tips) return;
  if (tipCooldown > 0) {
    tipCooldown -= 1;
    return;
  }
  if (hint.classList.contains('on')) return;
  for (const tip of TIPS) {
    if (save.hasSeenTip(tip.id) || !tip.when(world, me)) continue;
    save.markTip(tip.id);
    showHint(tip.text, 5200);
    // Leave a gap after one tip so two never run together.
    tipCooldown = 400;
    return;
  }
}

/** Sound and rebinding, on behalf of whichever session is running. */
const presenter: Presenter = {
  playSound: (event: SoundEvent) => {
    if (!run) return;
    const { camera, session } = run;
    // A grunt is the hurt player's own: a partner's plays quietly where they
    // stand, never full in the centre as if it were you.
    if (event.name === 'UI.Hurt') {
      const mine = session.world.players.some(
        (p) => p.id === event.ownerId && (p.index === session.localPlayerIndex || (session instanceof LocalSession && p.index < session.localSeats)),
      );
      if (!mine) return;
    }
    const listener = { x: camera.x, y: camera.y, halfWidth: camera.viewWidth / 2 };
    audio.play(event.name, event.x, event.y, event.rate, listener);
  },
  worldReplaced: () => {
    if (run) bind(run.session, run.characterId);
  },
};

/** Point the camera, renderer and HUD at a session's world. */
function bind(session: Session, characterId: string): void {
  const { room, world } = session;
  // Older art packs carry no floor extent; the whole map stands in for it.
  const bounds = room.floorBounds ?? { x: 0, y: 0, w: room.width, h: room.height };
  const camera = new Camera(canvas.width, canvas.height, bounds);
  const seats = session instanceof LocalSession ? session.localSeats : 1;
  viewScale = seats >= 2 ? SHARED_SCREEN_VIEW : 1;
  input.setLocalPlayers(seats);
  camera.resize(canvas.width, canvas.height, VIEW_WORLD_WIDTH * viewScale, VIEW_WORLD_HEIGHT * viewScale);
  const player = world.players[session.localPlayerIndex] ?? world.players[0];
  if (player) camera.jumpTo(player.x, player.y);
  const names = session instanceof NetSession
    ? (index: number) => session.nameOf(index)
    : seats >= 2 ? (index: number) => `P${index + 1}` : () => null;
  run = {
    session,
    countsForHighScores: save.countsForHighScores,
    practiceReason: save.practiceReason,
    renderer: new GameRenderer(world, pack, session.localPlayerIndex),
    hud: new Hud(world, Math.max(0, session.localPlayerIndex), names),
    camera,
    characterId,
  };
  run.hud.localSeats = seats;
  applyFeelSettings();
  loop.setStepMs(session.stepMs);
  slowMotion = false;
  hitStop = 0;
  lastKills = world.kills;
  lastHurt = world.hurt;
}

/** Push the comfort settings into whatever is drawing. */
function applyFeelSettings(): void {
  if (!run) return;
  run.renderer.shakeScale = save.shake;
  run.renderer.flashes = save.flashes;
  run.hud.sizeScale = save.hudScale;
  run.hud.highContrast = save.highContrast;
}

function startRun(roomId: string, characterId: string): void {
  endRun();
  save.clearSavedRun();
  const room = rooms.find((r) => r.id === roomId) ?? rooms[0]!;
  const session = new LocalSession({
    room,
    characterId,
    difficulty: save.difficulty,
    gameSpeed: save.gameSpeed,
    devils: save.devils,
    ...(save.sharedScreen ? { secondCharacterId: save.secondCharacterId, mode: save.sharedMode } : {}),
  });
  bind(session, characterId);
  paused = false;
  debriefed = false;
  input.clearLatches();
  menus.inMatch = false;
  menus.show('none');
  showHint(controlsHint());
  tipCooldown = 250;
}

function controlsHint(): string {
  if (save.sharedScreen) {
    return input.padSeen
      ? '<b>P1</b> keyboard + mouse &nbsp; <b>P2</b> gamepad &nbsp; <b>Esc</b> menu'
      : '<b>P1</b> WASD + mouse &nbsp; <b>P2</b> arrows + Enter &nbsp; <b>Esc</b> menu';
  }
  if (input.padSeen) {
    return '<b>stick</b> move &nbsp; <b>right stick</b> aim &nbsp; <b>trigger</b> fire &nbsp; <b>start</b> pause';
  }
  const move = (['up', 'left', 'down', 'right'] as const).map((a) => keyName(input.keysFor(a)[0] ?? '')).join('');
  return `<b>${move}</b> move &nbsp; <b>mouse</b> aim &nbsp; <b>click</b> fire &nbsp; <b>Esc</b> menu`;
}

/**
 * Park a single-player run mid-wave so a closed tab or a crash does not
 * cost it. Called on focus loss, on the pause menu and when the page goes.
 */
function parkRun(): void {
  if (!run || !(run.session instanceof LocalSession)) return;
  const { session } = run;
  const { world } = session;
  if (world.gameOver || debriefed) return;
  save.parkRun({
    roomId: session.room.id,
    characterId: run.characterId,
    difficulty: session.difficulty,
    gameSpeed: save.gameSpeed,
    devils: world.devilsEnabled,
    countsForHighScores: run.countsForHighScores,
    practiceReason: run.practiceReason,
    ...(session.localSeats >= 2
      ? { secondCharacterId: world.players[1]?.characterId ?? save.secondCharacterId, mode: session.mode }
      : {}),
    snapshot: world.snapshot(),
    level: world.level,
    score: world.score,
    savedAt: Date.now(),
  });
}

/** Pick the parked run back up exactly where it stopped. */
function continueRun(): void {
  const parked = save.savedRun;
  if (!parked) {
    menus.show('title');
    return;
  }
  endRun();
  const room = rooms.find((r) => r.id === parked.roomId) ?? rooms[0]!;
  let session: LocalSession;
  try {
    session = new LocalSession({
      room,
      characterId: parked.characterId,
      difficulty: parked.difficulty,
      gameSpeed: parked.gameSpeed,
      devils: parked.devils,
      snapshot: parked.snapshot as WorldSnapshot,
      ...(parked.secondCharacterId ? { secondCharacterId: parked.secondCharacterId, mode: parked.mode ?? 'coop' } : {}),
    });
  } catch {
    // A snapshot from an older build may not restore; drop it rather than crash.
    save.clearSavedRun();
    menus.show('title');
    return;
  }
  bind(session, parked.characterId);
  if (run) {
    run.countsForHighScores = parked.countsForHighScores;
    run.practiceReason = parked.practiceReason;
  }
  paused = false;
  debriefed = false;
  input.clearLatches();
  menus.inMatch = false;
  menus.show('none');
  showHint('<b>run restored</b> &nbsp; ' + controlsHint());
  tipCooldown = 250;
}
window.addEventListener('pagehide', parkRun);
window.addEventListener('beforeunload', parkRun);

function connect(address: string, name: string, characterId: string): void {
  endRun();
  netAddress = address;
  netStatus = 'connecting';
  const session = new NetSession(rooms, {
    onLobby: (state) => {
      lastLobby = state;
      const view: LobbyView = { ...state, address: netAddress, status: netStatus };
      // A match in progress on arrival is joined straight away; the lobby is
      // for before and after, and a pause menu open mid-match keeps its place.
      if (state.phase === 'playing' && menus.screen !== 'lobby') return;
      menus.setLobby(view);
    },
    onStart: () => {
      paused = false;
      input.clearLatches();
      menus.show('none');
      showHint(controlsHint());
    },
    onNet: (state, detail) => {
      netStatus = state === 'joined' ? 'connected' : detail || state;
      const warn = state === 'reconnecting' || state === 'connecting';
      netBadge.hidden = state === 'joined' || state === 'idle';
      netBadge.textContent = netStatus;
      netBadge.classList.toggle('warn', warn);
      if (menus.screen === 'lobby') {
        menus.setLobby(lastLobby && !warn ? { ...lastLobby, address: netAddress, status: netStatus } : null);
      }
    },
    onClosed: (reason) => {
      endRun();
      menus.showNetError(reason || 'disconnected');
    },
  });
  bind(session, characterId);
  menus.inMatch = true;
  menus.setLobby(null);
  session.connect(serverUrl(address, window.location.protocol === 'https:'), name, characterId);
}

/** Drop whatever is running, freeing a server seat if there was one. */
function endRun(): void {
  // Clear first: disposing a session can raise events that look here.
  const current = run;
  run = null;
  lastLobby = null;
  current?.session.dispose();
  paused = false;
  menus.inMatch = false;
  netBadge.hidden = true;
  gameMusic.setScene('off');
}

/** Bank the current run's result exactly once, whatever ended it. */
function recordRun(): RunResult | null {
  if (!run || debriefed) return null;
  if (run.session instanceof LocalSession && run.session.mode === 'deathmatch') {
    // A deathmatch leaves a winner, not a score, and nothing in the save.
    debriefed = true;
    save.clearSavedRun();
    const { world, room } = run.session;
    return {
      roomId: room.id,
      roomName: room.name,
      score: 0,
      level: world.level,
      kills: world.kills,
      peakMultiplier: 0,
      seconds: Math.round((world.tick * run.session.stepMs) / 1000),
      difficulty: run.session.difficulty,
      levelsCleared: 0,
      bestBefore: 0,
      accuracy: null,
      longestStreak: 0,
      favouriteWeapon: null,
      isBest: false,
      unlockedNext: false,
      practice: null,
      versus: {
        winnerIndex: world.winnerIndex,
        kills: world.players.map((p) => p.kills),
        names: world.players.map((p, i) => `Player ${i + 1}`),
      },
    };
  }
  if (!run.session.recordsScores) return null;
  debriefed = true;
  // The run is over one way or another; there is nothing left to park.
  save.clearSavedRun();
  const { world, room } = run.session;
  const local = run.session instanceof LocalSession ? run.session : null;
  const seconds = Math.round((world.tick * run.session.stepMs) / 1000);
  const difficulty = local?.difficulty ?? save.difficulty;
  const bestBefore = save.bestAt(room.id, difficulty).score;
  const favourite = (Object.entries(world.stats.killsByWeapon) as Array<[WeaponId, number]>)
    .sort((a, b) => b[1] - a[1])[0];
  const outcome = save.recordRun(
    room.id,
    room.index,
    {
      score: world.score,
      level: world.level,
      kills: world.kills,
      startLevel: local?.startLevel ?? 1,
      difficulty: local?.difficulty ?? save.difficulty,
      peakMultiplier: world.awardsBankedUpTo,
      seconds,
    },
    run.countsForHighScores,
    rooms.length,
  );
  return {
    roomId: room.id,
    roomName: room.name,
    score: world.score,
    level: world.level,
    kills: world.kills,
    peakMultiplier: world.awardsBankedUpTo,
    seconds,
    difficulty,
    levelsCleared: world.level - (local?.startLevel ?? 1),
    bestBefore,
    accuracy: world.stats.shotsFired > 0 ? Math.min(1, world.stats.shotsHit / world.stats.shotsFired) : null,
    longestStreak: world.stats.longestStreak,
    favouriteWeapon: favourite ? WEAPONS[favourite[0]].name : null,
    isBest: outcome.isBest,
    unlockedNext: outcome.unlockedNext,
    practice: run.practiceReason,
  } satisfies RunResult;
}

function finishRun(): void {
  const result = recordRun();
  if (result) menus.show('debrief', result);
}

function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  // The element can measure zero before the first layout, which would make the
  // camera scale non-finite; fall back until real dimensions arrive.
  const cssWidth = canvas.clientWidth || window.innerWidth || 960;
  const cssHeight = canvas.clientHeight || window.innerHeight || 540;
  const width = Math.max(320, Math.round(cssWidth * dpr));
  const height = Math.max(240, Math.round(cssHeight * dpr));
  if (canvas.width === width && canvas.height === height) return;

  canvas.width = width;
  canvas.height = height;
  ctx.imageSmoothingEnabled = false;
  run?.camera.resize(width, height, VIEW_WORLD_WIDTH * viewScale, VIEW_WORLD_HEIGHT * viewScale);
}
window.addEventListener('resize', resize);
// Layout can settle after the module runs, so track the element itself.
new ResizeObserver(resize).observe(canvas);
resize();

/** Camera look-ahead toward the aim, in world pixels. */
const AIM_LEAD = 0.18;
const AIM_LEAD_MAX = 64;

function aimLead(me: Player): { x: number; y: number } {
  if (!run) return { x: 0, y: 0 };
  let dx: number;
  let dy: number;
  if (input.padOwnsAim) {
    dx = Math.cos(me.angle) * AIM_LEAD_MAX * 0.7;
    dy = Math.sin(me.angle) * AIM_LEAD_MAX * 0.7;
  } else {
    const aim = run.camera.screenToWorld(input.pointerX, input.pointerY);
    dx = (aim.x - me.x) * AIM_LEAD;
    dy = (aim.y - me.y) * AIM_LEAD;
  }
  const length = Math.hypot(dx, dy);
  if (length > AIM_LEAD_MAX) {
    dx *= AIM_LEAD_MAX / length;
    dy *= AIM_LEAD_MAX / length;
  }
  return { x: dx, y: dy };
}

/**
 * How hard the fight is going, 0 to 1, for the music: creatures within
 * reach of the player, the multiplier's climb, and how hurt they are.
 */
function tensionOf(world: World, me: Player | undefined): number {
  if (!me || me.state !== 'alive') return 0.2;
  let near = 0;
  for (const enemy of world.enemies) {
    if (enemy.state !== 'alive') continue;
    const d = Math.hypot(enemy.x - me.x, enemy.y - me.y);
    if (d < 420) near += d < 160 ? 1.5 : 1;
  }
  const crowd = Math.min(1, near / 14);
  const climb = Math.min(1, world.multiplier / 60);
  const hurt = 1 - me.life / me.maxLife;
  return crowd * 0.6 + climb * 0.15 + hurt * 0.35;
}

/**
 * Losing the window mid-wave must not cost the run: a single-player game
 * pauses itself the moment focus goes and waits on the quick-pause sheet.
 */
function pauseForFocusLoss(): void {
  if (!run || menus.isOpen || paused) return;
  if (run.session instanceof NetSession || run.session.world.gameOver) return;
  paused = true;
  input.clearLatches();
  parkRun();
}
window.addEventListener('blur', pauseForFocusLoss);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pauseForFocusLoss();
});

window.addEventListener('keydown', (event) => {
  if (menus.isOpen) return;
  // On a server the run is over only when the server says so; the menu must
  // stay reachable while the local player is down.
  const ended = run !== null && !(run.session instanceof NetSession) && run.session.world.gameOver;
  if (event.code === 'Escape' && run && !ended) {
    event.preventDefault();
    paused = false;
    parkRun();
    menus.show('pause');
    return;
  }
  // Restart only from the pause overlay: R sits next to E and a mis-tap must
  // not throw a run away.
  if (event.code === 'KeyR' && run && paused && !(run.session instanceof NetSession)) {
    recordRun();
    startRun(run.session.room.id, run.characterId);
  }
  if (event.code === 'F3') {
    event.preventDefault();
    showStats = !showStats;
  }
  if (event.code === 'KeyM') {
    const muted = audio.toggleMute();
    save.setMuted(muted);
    showHint(muted ? 'sound muted' : 'sound on', 1400);
  }
});

const loop = new Loop(
  {
    step: () => {
      if (!run) return;
      const { session, camera } = run;
      const networked = session instanceof NetSession;
      // A server keeps going whether or not this player is looking at a menu,
      // so a networked session must keep consuming snapshots.
      if (menus.isOpen && !networked) return;
      // The pad's menu button opens the pause menu, online or not; on a
      // server, where nothing can pause, the quick-pause key does the same.
      const wantsMenu = input.consumeMenu() || (networked && input.consumePause());
      if (!menus.isOpen && wantsMenu && !session.world.gameOver) {
        paused = false;
        parkRun();
        menus.show('pause');
        return;
      }
      if (!networked) {
        if (input.consumePause()) paused = !paused;
        if (paused) {
          gameMusic.setScene('ducked');
          return;
        }
        // Let the fall play out and the scene settle before the debrief,
        // slowed right down so the moment lands.
        const { world } = session;
        if (world.gameOver && !slowMotion) {
          slowMotion = true;
          loop.setStepMs(session.stepMs / DEATH_SLOW_MOTION);
        }
        if (world.gameOver && world.tick - world.gameOverTick >= DEATH_LINGER_TICKS) {
          finishRun();
          return;
        }
        // A kill holds the picture for a frame or a few: the weight of it.
        if (hitStop > 0) {
          hitStop -= 1;
          return;
        }
      }

      session.step(input, camera, presenter);
      if (!networked && run) {
        const { world } = run.session;
        const kills = world.kills - lastKills;
        lastKills = world.kills;
        if (kills > 0 && world.tick - lastHitStopTick >= HIT_STOP_SPACING && !world.gameOver) {
          hitStop = HIT_STOP_FRAMES[Math.min(kills, HIT_STOP_FRAMES.length - 1)]!;
          lastHitStopTick = world.tick;
          if (save.rumble) input.rumble(40 + kills * 20, 0.2 + kills * 0.1, 0.3);
        }
        if (world.hurt > lastHurt + 0.05 && save.rumble) input.rumble(140, 0.9, 0.5);
        lastHurt = world.hurt;
        const me = world.players[run.session.localPlayerIndex];
        if (me && me.state === 'alive' && !world.gameOver) offerTips(world, me);
        // Park every ten seconds as well, against a crash the page never sees coming.
        if (world.tick % 500 === 0) parkRun();
      }
      // `step` may have replaced the world (a match started); re-read.
      if (!run) return;
      const world = run.session.world;
      const local = world.players[session.localPlayerIndex];
      // Follow whoever is alive if the local player is not, so a fallen or
      // still-seating player can watch the match.
      const target = local && local.state !== 'dead' ? local : world.players.find((p) => p.state === 'alive');
      const seats = run.session instanceof LocalSession ? run.session.localSeats : 1;
      if (seats >= 2) {
        // Two on one screen: the camera holds the point between the living.
        const living = world.players.filter((p) => p.connected && p.state !== 'dead');
        if (living.length > 0) {
          const mx = living.reduce((sum, p) => sum + p.x, 0) / living.length;
          const my = living.reduce((sum, p) => sum + p.y, 0) / living.length;
          run.camera.follow(mx, my);
        }
      } else if (target) {
        // Lean the camera a little toward the aim, so the player sees more
        // of where they are shooting than of what is behind them.
        const lead = save.cameraLead && target === local && local.state === 'alive' ? aimLead(local) : { x: 0, y: 0 };
        run.camera.follow(target.x + lead.x, target.y + lead.y);
      }

      const listener = { x: run.camera.x, y: run.camera.y, halfWidth: run.camera.viewWidth / 2 };
      audio.updateAmbience(world.enemies.length, listener, ambienceRandom);
      gameMusic.setTension(tensionOf(world, local));
      gameMusic.setScene(world.gameOver ? 'off' : paused ? 'ducked' : 'play');
      stepAverage = stepAverage * 0.9 + loop.stepMs * 0.1;
    },
    draw: (alpha) => {
      if (!run) {
        // Nothing to show behind the menus; keep the canvas quiet.
        canvas.classList.remove('aiming');
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = '#0a0b0d';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        return;
      }
      const { camera, renderer, hud } = run;
      // A world that is not stepping has nothing to interpolate toward; a
      // varying alpha would shuttle everything between its last two positions.
      // A hit stop holds the picture exactly where it is, not part-way to
      // the next step.
      const frozen = !(run.session instanceof NetSession) && (paused || menus.isOpen || hitStop > 0);
      const blend = frozen ? 1 : alpha;
      camera.interpolate(blend);
      renderer.draw(ctx, camera, blend);
      const aiming = !frozen && !input.padOwnsAim && !run.session.world.gameOver;
      canvas.classList.toggle('aiming', aiming);
      hud.draw(ctx, camera, aiming ? { x: input.pointerX, y: input.pointerY } : null);

      if (paused && !menus.isOpen) drawQuickPause();
      if (showStats) drawStats();
    },
  },
  TICK_MS,
);

/**
 * The quick pause: the original's dark sheet with its red band across the
 * top, lettered the way the menus are so the two pause screens read as one.
 */
function drawQuickPause(): void {
  const s = Math.max(1, Math.min(2, canvas.height / 620));
  const { width, height } = canvas;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = 'rgba(4,4,6,0.72)';
  ctx.fillRect(0, 0, width, height);
  const band = ctx.createLinearGradient(0, 0, 0, 42 * s);
  band.addColorStop(0, '#8b1a12');
  band.addColorStop(1, '#5a0d0a');
  ctx.fillStyle = band;
  ctx.fillRect(0, 0, width, 42 * s);
  ctx.fillStyle = '#2a0605';
  ctx.fillRect(0, 42 * s, width, 3 * s);

  ctx.textAlign = 'center';
  ctx.font = `700 ${46 * s}px "Cinzel", "Trajan Pro", "Palatino Linotype", Georgia, serif`;
  ctx.fillStyle = 'rgba(0,0,0,0.8)';
  ctx.fillText('PAUSED', width / 2 + 2 * s, height / 2 + 3 * s);
  ctx.fillStyle = '#e9e2d0';
  ctx.fillText('PAUSED', width / 2, height / 2);
  ctx.fillStyle = '#e0111f';
  ctx.fillRect(width / 2 - 30 * s, height / 2 + 12 * s, 60 * s, 3 * s);

  ctx.font = `700 ${11 * s}px "Segoe UI", system-ui, sans-serif`;
  ctx.fillStyle = '#c9a75a';
  const pauseKey = keyName(input.keysFor('pause')[0] ?? 'KeyP').toUpperCase();
  ctx.fillText(`${pauseKey}   RESUME          ESC   MENU          R   RESTART`, width / 2, height / 2 + 40 * s);
  ctx.textAlign = 'left';
}

function drawStats(): void {
  if (!run) return;
  const { world } = run.session;
  const lines = [
    `room        ${world.map.id}`,
    `tick        ${world.tick}`,
    `steps/frame ${loop.lastSteps}`,
    `sim         ${stepAverage.toFixed(2)} ms`,
    `draw        ${loop.drawMs.toFixed(2)} ms`,
    `enemies     ${world.enemies.length}`,
    `shots       ${world.shots.length}`,
    `effects     ${world.effects.length}`,
    `decals      ${world.decals.length}`,
    `poses       ${run.renderer.cachedPoses}`,
    ...run.session.stats(),
  ];
  ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
  ctx.fillStyle = 'rgba(0,0,0,0.62)';
  ctx.fillRect(10, canvas.height - 22 - lines.length * 14, 260, lines.length * 14 + 12);
  ctx.fillStyle = '#9fe6b0';
  lines.forEach((line, i) => {
    ctx.fillText(line, 18, canvas.height - 24 - (lines.length - 1 - i) * 14);
  });
}

// A shared link can carry the server: boxhead.html?server=host:port
const linkedServer = new URLSearchParams(window.location.search).get('server');
if (linkedServer) {
  save.setNet(linkedServer, save.playerName);
  menus.show('multiplayer');
} else {
  menus.show('title');
}
loop.start();

// Development-only hooks. Vite drops this branch from production builds, so
// the game never ships an object that reaches into its own internals.
if (import.meta.env.DEV) {
  const debugStats = () => {
    if (!run) return null;
    const { world } = run.session;
    const me = world.players[run.session.localPlayerIndex];
    return {
      tick: world.tick,
      enemies: world.enemies.length,
      kills: world.kills,
      score: world.score,
      level: world.level,
      multiplier: world.multiplier,
      life: me ? Math.round(me.life) : 0,
      weapon: me?.current ?? null,
      gameOver: world.gameOver,
      simMs: Number(stepAverage.toFixed(2)),
      drawMs: Number(loop.drawMs.toFixed(2)),
      poses: run.renderer.cachedPoses,
    };
  };
  (window as unknown as Record<string, unknown>).__game = {
    get run() {
      return run;
    },
    get world() {
      return run?.session.world;
    },
    get camera() {
      return run?.camera;
    },
    menus,
    save,
    loop,
    rooms,
    music,
    gameMusic,
    audio,
    startRun,
    connect,
    /**
     * Drive the game without requestAnimationFrame, for automated checks in
     * environments that report the document as hidden and throttle rAF.
     */
    debugRun(
      steps: number,
      opts: { moveX?: number; moveY?: number; fire?: boolean; aim?: [number, number] } = {},
    ) {
      if (!run) return null;
      const { session, camera, renderer, hud } = run;
      const { world } = session;
      for (let i = 0; i < steps; i++) {
        const command = emptyCommand();
        command.moveX = opts.moveX ?? 0;
        command.moveY = opts.moveY ?? 0;
        command.fire = opts.fire ?? false;
        const target = world.players[session.localPlayerIndex];
        command.aimX = opts.aim ? opts.aim[0] : (target?.x ?? 0) + 100;
        command.aimY = opts.aim ? opts.aim[1] : (target?.y ?? 0);
        world.step([command]);
        world.sounds.length = 0;
        if (target) camera.follow(target.x, target.y);
      }
      camera.interpolate(0);
      renderer.draw(ctx, camera, 0);
      hud.draw(ctx, camera);
      return {
        tick: world.tick,
        enemies: world.enemies.length,
        kills: world.kills,
        score: world.score,
        level: world.level,
      };
    },
    /**
     * A simple player: aims at the nearest enemy, fires, backs away when
     * crowded, and keeps the strongest loaded weapon up. Enough to reach the
     * later waves for screenshots and load tests. `suicide` walks into the
     * horde instead, for the death and debrief paths.
     */
    debugBot(steps: number, opts: { suicide?: boolean } = {}) {
      if (!run) return null;
      const { session, camera, renderer, hud } = run;
      const { world } = session;
      let nextSwitchTick = 0;
      for (let i = 0; i < steps; i++) {
        const command = emptyCommand();
        const me = world.players[session.localPlayerIndex];
        if (me && me.state === 'alive') {
          let nearest: { x: number; y: number; d: number } | null = null;
          let cx = 0;
          let cy = 0;
          let crowd = 0;
          for (const enemy of world.enemies) {
            if (enemy.state !== 'alive') continue;
            const d = Math.hypot(enemy.x - me.x, enemy.y - me.y);
            if (!nearest || d < nearest.d) nearest = { x: enemy.x, y: enemy.y, d };
            if (d < 220) {
              cx += enemy.x;
              cy += enemy.y;
              crowd += 1;
            }
          }
          if (nearest) {
            // A devil in range is the target; otherwise the nearest thing.
            let devil: { x: number; y: number; d: number } | null = null;
            for (const enemy of world.enemies) {
              if (enemy.state !== 'alive' || enemy.defId !== 'devil') continue;
              const d = Math.hypot(enemy.x - me.x, enemy.y - me.y);
              if (d < 320 && (!devil || d < devil.d)) devil = { x: enemy.x, y: enemy.y, d };
            }
            const aimAt = devil ?? nearest;
            command.aimX = aimAt.x;
            command.aimY = aimAt.y;
            // Pulse the trigger: a semi-automatic weapon fires on the press, not the hold.
            command.fire = aimAt.d < 420 && i % 2 === 0;
            const fromX = crowd > 0 ? cx / crowd : nearest.x;
            const fromY = crowd > 0 ? cy / crowd : nearest.y;
            const away = Math.atan2(me.y - fromY, me.x - fromX);
            if (opts.suicide) {
              command.moveX = Math.sign(Math.round(Math.cos(away + Math.PI) * 2));
              command.moveY = Math.sign(Math.round(Math.sin(away + Math.PI) * 2));
            } else if (nearest.d < 170 || crowd > 3) {
              // Retreat along the most open of sixteen headings: clear of walls,
              // far from every creature, and leaning away from the crowd.
              const bounds = session.room.floorBounds ?? { x: 0, y: 0, w: session.room.width, h: session.room.height };
              let bestScore = -Infinity;
              let bestAngle = away;
              for (let k = 0; k < 16; k++) {
                const angle = (k / 16) * Math.PI * 2;
                const px = me.x + Math.cos(angle) * 56;
                const py = me.y + Math.sin(angle) * 56;
                if (circleBlocked(world.map, px, py, me.radius + 2)) continue;
                if (circleBlocked(world.map, me.x + Math.cos(angle) * 28, me.y + Math.sin(angle) * 28, me.radius + 2)) continue;
                let clearance = Infinity;
                for (const enemy of world.enemies) {
                  if (enemy.state !== 'alive') continue;
                  clearance = Math.min(clearance, Math.hypot(enemy.x - px, enemy.y - py));
                }
                const agreement = Math.cos(angle - away);
                const toCentre = Math.atan2(bounds.y + bounds.h / 2 - py, bounds.x + bounds.w / 2 - px);
                const centred = Math.cos(angle - toCentre);
                const score = Math.min(clearance, 400) + agreement * 60 + centred * 25;
                if (score > bestScore) {
                  bestScore = score;
                  bestAngle = angle;
                }
              }
              command.moveX = Math.sign(Math.round(Math.cos(bestAngle) * 2));
              command.moveY = Math.sign(Math.round(Math.sin(bestAngle) * 2));
            }
          } else {
            command.aimX = me.x + 100;
            command.aimY = me.y;
          }
          // Prefer the heaviest gun with ammo; placeables are skipped.
          if (world.tick >= nextSwitchTick) {
            nextSwitchTick = world.tick + 50;
            const preference: Array<[string, number]> = [
              ['railgun', 0], ['rocket', 8], ['shotgun', 3], ['uzi', 2], ['pistol', 1],
            ];
            for (const [id, slot] of preference) {
              const weapon = me.weapons.get(id as never);
              if (weapon?.unlocked && (id === 'pistol' || weapon.ammo > 0)) {
                if (me.current !== id) command.weaponSlot = slot;
                break;
              }
            }
          }
        }
        world.step([command]);
        world.sounds.length = 0;
        if (me) camera.follow(me.x, me.y);
      }
      camera.interpolate(0);
      renderer.draw(ctx, camera, 0);
      hud.draw(ctx, camera);
      return debugStats();
    },
    debugStats,
  };
}
