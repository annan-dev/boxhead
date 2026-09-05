/**
 * Entry point and app state machine.
 *
 * The simulation lives in @boxhead/shared and knows nothing about the browser.
 * This module owns everything it must not: the canvas, the clock, input
 * devices, audio, menus and drawing.
 */
import {
  ROOMS,
  TICK_MS,
  World,
  emptyCommand,
  type ArtPack,
  type ExtractedRoom,
} from '@boxhead/shared';
import { Loop } from './loop/Loop.js';
import { Input } from './input/Input.js';
import { Camera } from './render/Camera.js';
import { GameRenderer } from './render/GameRenderer.js';
import { Hud } from './ui/Hud.js';
import { Menus, type RunResult } from './ui/Menus.js';
import { SaveData } from './state/SaveData.js';
import { AudioEngine, SOUND_NAMES } from './audio/AudioEngine.js';

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
    #boot { position: fixed; inset: 0; display: grid; place-content: center; gap: 10px;
            text-align: center; background: #07080a; z-index: 30; }
    #boot h1 { margin: 0; font-size: 15px; letter-spacing: .3em; color: #8b939e;
               text-transform: uppercase; }
    #boot p { margin: 0; color: #6f7883; max-width: 460px; line-height: 1.6; }
    #boot code { color: #ffd88a; }
    /* A short reminder on entering a run, then it gets out of the way. */
    #hint { position: fixed; left: 50%; bottom: 108px; transform: translateX(-50%);
            color: #8b939e; background: rgba(10,11,13,.72); padding: 7px 14px;
            border-radius: 20px; pointer-events: none; opacity: 0;
            transition: opacity .5s; white-space: nowrap; }
    #hint.on { opacity: 1; }
    #hint b { color: #dfe3e8; }
  </style>
  <canvas id="view"></canvas>
  <div id="hint"></div>
  <div id="boot"><h1>Boxhead</h1><p>Loading art&hellip;</p></div>
`;

const canvas = app.querySelector<HTMLCanvasElement>('#view')!;
const ctx = canvas.getContext('2d', { alpha: false })!;
const boot = app.querySelector<HTMLDivElement>('#boot')!;
const hint = app.querySelector<HTMLDivElement>('#hint')!;

let pack: ArtPack;
try {
  const response = await fetch('art.json');
  if (!response.ok) throw new Error(String(response.status));
  pack = (await response.json()) as ArtPack;
} catch {
  boot.innerHTML = `
    <h1>Boxhead</h1>
    <p>The art pack is missing. Extract it from your own copy of the SWF:</p>
    <p><code>npm run extract -- boxhead2play.swf</code></p>
    <p>Assets are never committed to the repository.</p>`;
  throw new Error('art.json is unavailable');
}
boot.remove();

// Development-only art gallery at /#gallery, for eyeballing extracted symbols.
if (import.meta.env.DEV && window.location.hash === '#gallery') {
  const { mountGallery } = await import('./dev/gallery.js');
  mountGallery(app, pack);
  throw new Error('gallery mode');
}

const rooms: ExtractedRoom[] = pack.rooms.length > 0 ? pack.rooms : ROOMS;
const save = new SaveData();
const input = new Input(canvas);

const audio = new AudioEngine();
void audio.init(SOUND_NAMES);
audio.setVolume(save.volume);
if (save.muted) audio.toggleMute();
const unlock = (): void => {
  audio.resume();
  window.removeEventListener('pointerdown', unlock);
  window.removeEventListener('keydown', unlock);
};
window.addEventListener('pointerdown', unlock);
window.addEventListener('keydown', unlock);

/** Cheap noise for cosmetic ambience; never touches the simulation. */
let ambienceSeed = 0x1a2b3c;
const ambienceRandom = (): number => {
  ambienceSeed = (Math.imul(ambienceSeed, 1664525) + 1013904223) >>> 0;
  return ambienceSeed / 4294967296;
};

// ---- run state -----------------------------------------------------------

interface Run {
  world: World;
  renderer: GameRenderer;
  hud: Hud;
  camera: Camera;
  room: ExtractedRoom;
  characterId: string;
}

let run: Run | null = null;
let paused = false;
let showStats = false;
let stepAverage = 0;
/** Set once the debrief has been shown, so it fires only on the first death. */
let debriefed = false;

const menus = new Menus(app, pack, rooms, save, {
  onStart: (roomId, characterId) => startRun(roomId, characterId),
  onResume: () => menus.show('none'),
  onVolume: (value) => audio.setVolume(value),
  onMuted: (value) => {
    if (audio.muted !== value) audio.toggleMute();
  },
});

function showHint(text: string, ms = 4200): void {
  hint.innerHTML = text;
  hint.classList.add('on');
  window.setTimeout(() => hint.classList.remove('on'), ms);
}

function startRun(roomId: string, characterId: string): void {
  const room = rooms.find((r) => r.id === roomId) ?? rooms[0]!;
  const world = new World({
    room,
    seed: Date.now() & 0xffff,
    playerCount: 1,
    characters: [characterId],
  });
  const camera = new Camera(canvas.width, canvas.height, room.width, room.height);
  camera.resize(canvas.width, canvas.height, VIEW_WORLD_WIDTH, VIEW_WORLD_HEIGHT);
  const player = world.players[0];
  if (player) camera.jumpTo(player.x, player.y);

  run = {
    world,
    renderer: new GameRenderer(world, pack),
    hud: new Hud(world),
    camera,
    room,
    characterId,
  };
  paused = false;
  debriefed = false;
  menus.show('none');
  showHint('<b>WASD</b> move &nbsp; <b>mouse</b> aim &nbsp; <b>click</b> fire &nbsp; <b>Esc</b> menu');
}

function finishRun(): void {
  if (!run || debriefed) return;
  debriefed = true;
  const { world, room } = run;
  const outcome = save.recordRun(room.id, room.index, {
    score: world.score,
    level: world.level,
    kills: world.kills,
  });
  menus.show('debrief', {
    roomId: room.id,
    roomName: room.name,
    score: world.score,
    level: world.level,
    kills: world.kills,
    isBest: outcome.isBest,
    unlockedNext: outcome.unlockedNext,
  } satisfies RunResult);
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

window.addEventListener('keydown', (event) => {
  if (menus.isOpen) return;
  if (event.code === 'KeyR' && run) startRun(run.room.id, run.characterId);
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
      if (!run || menus.isOpen) return;
      if (input.consumePause()) paused = !paused;
      if (paused) return;
      if (run.world.gameOver) {
        finishRun();
        return;
      }

      const { world, camera } = run;
      // The pointer aims in world space, so it must be unprojected first.
      const aim = camera.screenToWorld(input.pointerX, input.pointerY);
      const player = world.players[0];
      world.step([player ? input.buildCommand(aim.x, aim.y) : emptyCommand()]);

      const target = world.players[0];
      if (target) camera.follow(target.x, target.y);

      // The simulation raises sound requests; playback happens here so the
      // simulation itself stays headless.
      const listener = { x: camera.x, y: camera.y, halfWidth: camera.viewWidth / 2 };
      for (const event of world.sounds) {
        audio.play(event.name, event.x, event.y, event.rate, listener);
      }
      world.sounds.length = 0;
      audio.updateAmbience(world.enemies.length, listener, ambienceRandom);
      stepAverage = stepAverage * 0.9 + loop.stepMs * 0.1;
    },
    draw: (alpha) => {
      if (!run) {
        // Nothing to show behind the menus; keep the canvas quiet.
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = '#0a0b0d';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        return;
      }
      const { camera, renderer, hud } = run;
      camera.interpolate(alpha);
      renderer.draw(ctx, camera, alpha);
      hud.draw(ctx, camera);

      if (paused && !menus.isOpen) {
        ctx.fillStyle = 'rgba(8,9,12,0.62)';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.font = '700 30px ui-monospace, Menlo, Consolas, monospace';
        ctx.fillStyle = '#e8ecf1';
        ctx.textAlign = 'center';
        ctx.fillText('PAUSED', canvas.width / 2, canvas.height / 2);
        ctx.font = '13px ui-monospace, Menlo, Consolas, monospace';
        ctx.fillStyle = '#8b939e';
        ctx.fillText('P to resume, Esc for the menu', canvas.width / 2, canvas.height / 2 + 26);
        ctx.textAlign = 'left';
      }
      if (showStats) drawStats();
    },
  },
  TICK_MS,
);

function drawStats(): void {
  if (!run) return;
  const { world } = run;
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
  ];
  ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
  ctx.fillStyle = 'rgba(0,0,0,0.62)';
  ctx.fillRect(10, canvas.height - 22 - lines.length * 14, 210, lines.length * 14 + 12);
  ctx.fillStyle = '#9fe6b0';
  lines.forEach((line, i) => {
    ctx.fillText(line, 18, canvas.height - 24 - (lines.length - 1 - i) * 14);
  });
}

menus.show('title');
loop.start();

// Development-only hooks. Vite drops this branch from production builds, so
// the game never ships an object that reaches into its own internals.
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__game = {
    get run() {
      return run;
    },
    get world() {
      return run?.world;
    },
    get camera() {
      return run?.camera;
    },
    menus,
    save,
    loop,
    rooms,
    startRun,
    /**
     * Drive the game without requestAnimationFrame, for automated checks in
     * environments that report the document as hidden and throttle rAF.
     */
    debugRun(
      steps: number,
      opts: { moveX?: number; moveY?: number; fire?: boolean; aim?: [number, number] } = {},
    ) {
      if (!run) return null;
      const { world, camera, renderer, hud } = run;
      for (let i = 0; i < steps; i++) {
        const command = emptyCommand();
        command.moveX = opts.moveX ?? 0;
        command.moveY = opts.moveY ?? 0;
        command.fire = opts.fire ?? false;
        const target = world.players[0];
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
  };
}
