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
  emptyCommand,
  serverUrl,
  type ArtPack,
  type ExtractedRoom,
  type Player,
  type SoundEvent,
  type World,
} from '@boxhead/shared';
import { Loop } from './loop/Loop.js';
import { Input } from './input/Input.js';
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

const menus = new Menus(app, pack, rooms, save, screens, {
  onStart: (roomId, characterId) => startRun(roomId, characterId),
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

/** Sound and rebinding, on behalf of whichever session is running. */
const presenter: Presenter = {
  playSound: (event: SoundEvent) => {
    if (!run) return;
    const { camera } = run;
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
  camera.resize(canvas.width, canvas.height, VIEW_WORLD_WIDTH, VIEW_WORLD_HEIGHT);
  const player = world.players[session.localPlayerIndex] ?? world.players[0];
  if (player) camera.jumpTo(player.x, player.y);
  const names = session instanceof NetSession ? (index: number) => session.nameOf(index) : () => null;
  run = {
    session,
    countsForHighScores: save.countsForHighScores,
    practiceReason: save.practiceReason,
    renderer: new GameRenderer(world, pack, session.localPlayerIndex),
    hud: new Hud(world, Math.max(0, session.localPlayerIndex), names),
    camera,
    characterId,
  };
  loop.setStepMs(session.stepMs);
}

function startRun(roomId: string, characterId: string): void {
  endRun();
  const room = rooms.find((r) => r.id === roomId) ?? rooms[0]!;
  const session = new LocalSession({
    room,
    characterId,
    difficulty: save.difficulty,
    gameSpeed: save.gameSpeed,
    devils: save.devils,
  });
  bind(session, characterId);
  paused = false;
  debriefed = false;
  input.clearLatches();
  menus.inMatch = false;
  menus.show('none');
  showHint(controlsHint());
}

function controlsHint(): string {
  return input.padSeen
    ? '<b>stick</b> move &nbsp; <b>right stick</b> aim &nbsp; <b>trigger</b> fire &nbsp; <b>start</b> pause'
    : '<b>WASD</b> move &nbsp; <b>mouse</b> aim &nbsp; <b>click</b> fire &nbsp; <b>Esc</b> menu';
}

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
  if (!run || debriefed || !run.session.recordsScores) return null;
  debriefed = true;
  const { world, room } = run.session;
  const local = run.session instanceof LocalSession ? run.session : null;
  const seconds = Math.round((world.tick * run.session.stepMs) / 1000);
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
    difficulty: local?.difficulty ?? save.difficulty,
    levelsCleared: world.level - (local?.startLevel ?? 1),
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
  run?.camera.resize(width, height, VIEW_WORLD_WIDTH, VIEW_WORLD_HEIGHT);
}
window.addEventListener('resize', resize);
// Layout can settle after the module runs, so track the element itself.
new ResizeObserver(resize).observe(canvas);
resize();

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
      if (!networked) {
        if (menus.isOpen) return;
        if (input.consumePause()) paused = !paused;
        if (paused) return;
        // Let the fall play out and the scene settle before the debrief.
        const { world } = session;
        if (world.gameOver && world.tick - world.gameOverTick >= DEATH_LINGER_TICKS) {
          finishRun();
          return;
        }
      }

      session.step(input, camera, presenter);
      // `step` may have replaced the world (a match started); re-read.
      if (!run) return;
      const world = run.session.world;
      const local = world.players[session.localPlayerIndex];
      // Follow whoever is alive if the local player is not, so a fallen or
      // still-seating player can watch the match.
      const target = local && local.state !== 'dead' ? local : world.players.find((p) => p.state === 'alive');
      if (target) run.camera.follow(target.x, target.y);

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
      const frozen = !(run.session instanceof NetSession) && (paused || menus.isOpen);
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
  ctx.fillText('P   RESUME          ESC   MENU          R   RESTART', width / 2, height / 2 + 40 * s);
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
            command.aimX = nearest.x;
            command.aimY = nearest.y;
            // Pulse the trigger: a semi-automatic weapon fires on the press, not the hold.
            command.fire = nearest.d < 420 && i % 2 === 0;
            const fromX = crowd > 0 ? cx / crowd : nearest.x;
            const fromY = crowd > 0 ? cy / crowd : nearest.y;
            const away = Math.atan2(me.y - fromY, me.x - fromX);
            if (opts.suicide) {
              command.moveX = Math.sign(Math.round(Math.cos(away + Math.PI) * 2));
              command.moveY = Math.sign(Math.round(Math.sin(away + Math.PI) * 2));
            } else if (nearest.d < 150) {
              // Retreat, drifting toward the arena centre so the bot is not pinned in a corner.
              const bounds = session.room.floorBounds ?? { x: 0, y: 0, w: session.room.width, h: session.room.height };
              const toCentre = Math.atan2(bounds.y + bounds.h / 2 - me.y, bounds.x + bounds.w / 2 - me.x);
              const blend = Math.atan2(Math.sin(away) * 0.7 + Math.sin(toCentre) * 0.3, Math.cos(away) * 0.7 + Math.cos(toCentre) * 0.3);
              command.moveX = Math.sign(Math.round(Math.cos(blend) * 2));
              command.moveY = Math.sign(Math.round(Math.sin(blend) * 2));
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
