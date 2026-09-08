/**
 * Front-end screens: title, arena select, character select, instructions,
 * options, the pause screen and the post-run debrief.
 *
 * These are real DOM rather than canvas drawing. Menus are text and lists, and
 * the browser already does text, focus, keyboard navigation and scrolling far
 * better than hand-rolled canvas widgets would.
 *
 * The look keeps the original's ingredients -- the cream floor, blood red for
 * anything you can press, the boxy silhouettes, the skull behind the debrief,
 * the floor band -- and sets them at night: dark scorched concrete, slab
 * buttons with a hard bevel, brass-framed panels, and embers drifting up. The
 * rules live in one stylesheet so every screen reads as the same game.
 *
 * Arena thumbnails and character portraits are the exception to "no canvas":
 * both are drawn from the same data the game uses, so what the menu shows is
 * what you get; the original's own bitmaps replace them when present.
 */
import type { ArtPack, ExtractedRoom, LobbyPlayer, MatchConfig, RoomPhase } from '@boxhead/shared';
import { CHARACTERS, DEATHMATCH_KILL_TARGETS, DIFFICULTIES, GAME_SPEEDS } from '@boxhead/shared';
import { drawComposed, type TextureSwap } from '../render/VectorModel.js';
import { ClipIndex, composePose, type Layer } from '../render/Rig.js';
import { drawSprite } from '../render/SpriteRenderer.js';
import type { SaveData } from '../state/SaveData.js';
import { UNLOCK_CLEARS, UNLOCK_LEVEL } from '../state/SaveData.js';
import { assetUrl } from '../assets/AssetSource.js';
import { CHARACTER_PALETTES } from '../render/HeadArt.js';
import { TitleArt } from './TitleArt.js';
import {
  ACTION_LABELS,
  DEFAULT_BINDINGS,
  DEFAULT_PAD,
  PAD_ACTION_LABELS,
  RESERVED_KEYS,
  firstGamepad,
  keyName,
  mouseCode,
  padButtonName,
  type BindableAction,
  type PadAction,
} from '../input/Input.js';

export type Screen =
  | 'title'
  | 'rooms'
  | 'character'
  | 'instructions'
  | 'options'
  | 'pause'
  | 'debrief'
  | 'multiplayer'
  | 'lobby'
  | 'none';

/** What the lobby screen shows; the session keeps it current. */
export interface LobbyView {
  phase: RoomPhase;
  config: MatchConfig;
  players: LobbyPlayer[];
  localIndex: number;
  isHost: boolean;
  rooms: ExtractedRoom[];
  /** Server address, for sharing. */
  address: string;
  /** A short status line, e.g. "connecting" or "reconnecting". */
  status: string;
}

export interface RunResult {
  roomId: string;
  roomName: string;
  score: number;
  level: number;
  kills: number;
  peakMultiplier: number;
  /** Wall seconds of play. */
  seconds: number;
  difficulty: string;
  /** Waves cleared past the difficulty's starting level. */
  levelsCleared: number;
  /** The best on this room at this difficulty before the run. */
  bestBefore: number;
  /** Shots that hit over shots fired, or null when nothing was fired. */
  accuracy: number | null;
  longestStreak: number;
  favouriteWeapon: string | null;
  isBest: boolean;
  unlockedNext: boolean;
  /** Why the run did not count for high scores, or null when it did. */
  practice: string | null;
  /** A deathmatch's outcome: who won and each seat's kills. Nothing is recorded. */
  versus?: { winnerIndex: number; kills: number[]; names: string[] };
}

/** "today 14:02", "yesterday", or a short date, for the history. */
function whenLabel(at: number): string {
  const then = new Date(at);
  const now = new Date();
  const sameDay = then.toDateString() === now.toDateString();
  const yesterday = new Date(now.getTime() - 86400000).toDateString() === then.toDateString();
  const time = then.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `today ${time}`;
  if (yesterday) return `yesterday ${time}`;
  return then.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function formatSeconds(total: number): string {
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/** Marks an option that takes a run out of the high-score table. */
const NO_SCORE_BADGE =
  '<span class="badge" title="Runs with this setting do not count for high scores or unlocks">&#9888; no high scores</span>';

/**
 * The original's own menu pictures, written by the extractor as
 * `bitmaps/screens.json`. Every entry is optional: the menus fall back to
 * generated art (minimap, live-rendered portrait, text logo) when one is missing.
 */
export interface ScreenArt {
  logo: string | null;
  /** Room id to bitmap file, relative to /bitmaps. */
  levelIcons: Record<string, string>;
  /** Character id to bitmap file. */
  portraits: Record<string, string>;
}

export interface MenuCallbacks {
  onStart: (roomId: string, characterId: string) => void;
  /** Pick up the parked run. */
  onContinue: () => void;
  onResume: () => void;
  /** Restart the current run in the same arena. */
  onRestart: () => void;
  /** Abandon the current run and return to the title. */
  onQuit: () => void;
  onVolume: (value: number) => void;
  /** Menu music level. */
  onMusic: (value: number) => void;
  onMuted: (value: boolean) => void;
  /** Shake, flashes, HUD size or rumble changed; the game re-reads the save. */
  onFeel: () => void;
  /** Key bindings changed; the game re-reads the save. */
  onKeys: () => void;
  /** A gamepad spoke on a menu, so the hints can name it. */
  onPadSeen?: () => void;
  /** Fired whenever a screen opens or the menus close. */
  onScreen: (screen: Screen) => void;
  /** Join a server; `address` is whatever the player typed. */
  onConnect: (address: string, name: string, characterId: string) => void;
  /** Leave the server, from the lobby or the pause screen. */
  onLeaveMatch: () => void;
  onLobbyReady: (ready: boolean) => void;
  onLobbyConfigure: (config: Partial<Omit<MatchConfig, 'seed'>>) => void;
  onLobbyStart: () => void;
}

const DISPLAY = '"Cinzel", "Trajan Pro", "Palatino Linotype", Georgia, "Times New Roman", serif';
const BODY = '"Segoe UI", system-ui, -apple-system, Roboto, Helvetica, Arial, sans-serif';

/** Concrete grain: a tiny SVG turbulence tile, inlined so it works from a file on disk. */
const GRAIN =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'>" +
  "<filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3' stitchTiles='stitch'/>" +
  "<feColorMatrix values='0 0 0 0 0.55 0 0 0 0 0.52 0 0 0 0 0.47 0 0 0 .18 0'/></filter>" +
  "<rect width='160' height='160' filter='url(%23n)'/></svg>\")";

/**
 * The look: a scorched arena at night. Boxhead's own ingredients stay -- the
 * cream floor, the blood red, the boxy silhouettes -- but the screens are dark
 * and cinematic rather than paper. Buttons are heavy slabs with a hard bevel
 * and a pressed state (the Minecraft feel), panels carry a thin brass frame
 * with bracketed corners and a warm glow on hover (the League feel), and
 * embers drift up behind everything. One set of rules covers every screen.
 */
const STYLE = `
  .menu {
    position: fixed; inset: 0; z-index: 20; display: none;
    color: #e9e2d0; overflow-y: auto; overflow-x: hidden;
    font: 15px/1.45 ${BODY};
    background: #0b0b0d;
    --red: #e0111f; --red-hi: #ff3040; --red-lo: #7a0810;
    --bone: #e9e2d0; --bone-dim: #b9b2a2; --muted: #857f72;
    --brass: #c9a75a; --brass-dim: rgba(201,167,90,.45); --brass-glow: rgba(201,167,90,.28);
    --slab: #1c1c20; --slab-hi: #2b2b31; --slab-lo: #0a0a0c;
    --panel: rgba(16,16,19,.86);
  }
  .menu.on { display: block; animation: menuIn .22s ease-out; }
  @keyframes menuIn { from { opacity: 0; transform: scale(1.015); } to { opacity: 1; transform: none; } }

  /* Backdrop: vignette over concrete grain, a smoulder along the floor, and the
     original's floor band recast as a dark, scorched strip. */
  .menu .bg { position: fixed; inset: 0; pointer-events: none; z-index: 1;
              background:
                radial-gradient(ellipse 90% 70% at 50% 110%, rgba(224,17,31,.30), transparent 60%),
                radial-gradient(ellipse 120% 90% at 50% 40%, rgba(255,255,255,.035), transparent 65%),
                ${GRAIN}, #0b0b0d; }
  .menu .bg::before { content: ''; position: absolute; inset: 0;
              background: radial-gradient(ellipse 70% 60% at 50% 45%, transparent 40%, rgba(0,0,0,.78) 100%); }
  .menu .bg::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 30px;
              background: linear-gradient(#3a1a0e, #23100a); border-top: 3px solid #5d2413;
              box-shadow: 0 -12px 30px rgba(224,17,31,.18); }
  /* The pause screen sits over the frozen arena rather than hiding it. */
  .menu.overlay { background: transparent; }
  .menu.overlay .bg { background: rgba(4,4,6,.72); backdrop-filter: blur(2px); }
  .menu.overlay .bg::before { display: none; }
  .menu.overlay .bg::after { top: 0; bottom: auto; height: 42px;
              background: linear-gradient(#8b1a12, #5a0d0a); border-top: 0; border-bottom: 3px solid #2a0605;
              box-shadow: 0 6px 24px rgba(0,0,0,.6); }

  /* The title's key art fills the screen under everything; the backdrop's
     fill steps aside and only its vignette and grain remain. */
  .hero-art { position: fixed; inset: 0; z-index: 0; width: 100vw; height: 100vh; pointer-events: none;
              transform-origin: 58% 45%; animation: heroDrift 70s ease-in-out infinite alternate; }
  @keyframes heroDrift { from { transform: scale(1.03) translate(0, 0); } to { transform: scale(1.10) translate(-1.6%, -1%); } }
  .menu.hero .bg { background: ${GRAIN}, transparent; opacity: .55; }
  .menu.hero .bg::before { background: radial-gradient(ellipse 62% 58% at 50% 40%, transparent 35%, rgba(0,0,0,.72) 100%); }
  .menu.hero .bg::after { display: none; }
  .menu.hero .inner { padding: 6vh 0 70px 7vw; max-width: none; text-align: left; }
  .menu.hero .inner::before { content: ''; position: fixed; inset: 0; z-index: -1; pointer-events: none;
              background: linear-gradient(90deg, rgba(6,6,9,.94) 0%, rgba(6,6,9,.86) 28%, rgba(6,6,9,.35) 48%, transparent 64%); }
  .menu.hero h1 { text-align: left; }
  .menu.hero .sub { text-align: left; margin-left: 0; }
  .menu.hero .sub::before { display: none; }
  .menu.hero .stats { justify-content: flex-start; }
  .menu.hero .btn, .menu.hero .rule { margin-left: 0; margin-right: 0; }
  .menu.hero img.logo { width: min(440px, 80%); margin: 0 0 0 -10px;
                        filter: drop-shadow(0 10px 0 rgba(0,0,0,.6)) drop-shadow(0 0 36px rgba(224,17,31,.55)); }
  .menu.hero .sub { color: #e6d4a8; }
  .menu.hero .stats { color: #a8987a; }
  .menu.hero .stats b { color: #f3e3b6; }
  .menu.hero .btn { max-width: 360px; }

  /* Embers rising through the dark, cheap enough to leave running. */
  .embers { position: fixed; inset: 0; pointer-events: none; z-index: 1; overflow: hidden; }
  .menu.overlay .embers { display: none; }
  .ember { position: absolute; bottom: -10px; width: 3px; height: 3px; border-radius: 50%;
           background: #ff7a4a; box-shadow: 0 0 8px 2px rgba(255,90,50,.55); opacity: 0;
           animation: rise linear infinite; }
  @keyframes rise {
    0% { transform: translate(0, 0) scale(1); opacity: 0; }
    10% { opacity: .9; }
    60% { opacity: .55; }
    100% { transform: translate(var(--drift), -105vh) scale(.4); opacity: 0; }
  }

  .menu .inner { position: relative; z-index: 2; max-width: 960px; margin: 0 auto; padding: 26px 30px 70px; }
  .menu.centered .inner { text-align: center; }
  .menu.centered .btn, .menu.centered .rule { margin-left: auto; margin-right: auto; }

  /* Type: the heading is a slab of condensed caps with a blood underline;
     labels are brass small caps, the League way of marking a section. */
  .menu h1 { margin: 0; font: 900 56px/1 ${DISPLAY}; text-transform: uppercase; color: var(--bone);
             letter-spacing: .08em; text-shadow: 0 3px 0 #000, 0 0 30px rgba(224,17,31,.35); }
  .menu img.logo { display: block; width: min(460px, 78%); height: auto; margin: 4px auto 0;
                   filter: drop-shadow(0 8px 0 rgba(0,0,0,.55)) drop-shadow(0 0 28px rgba(224,17,31,.45)); }
  .menu .sub { margin: 8px 0 16px; color: var(--brass); letter-spacing: .32em; text-transform: uppercase;
               font: 700 11px ${BODY}; }
  .menu .sub::before, .menu .sub::after { content: '\\25C6'; font-size: 8px; vertical-align: 2px; margin: 0 12px;
               color: var(--brass-dim); }
  .menu h2 { position: relative; font: 700 24px/1.1 ${DISPLAY}; text-transform: uppercase; color: var(--bone);
             letter-spacing: .14em; margin: 0 0 18px; padding-bottom: 10px; text-shadow: 0 2px 0 #000; }
  .menu h2::after { content: ''; position: absolute; left: 0; bottom: 0; width: 56px; height: 4px;
             background: var(--red); box-shadow: 0 0 12px rgba(224,17,31,.7); }
  .menu.centered h2::after { left: 50%; transform: translateX(-50%); }
  .menu .back { color: var(--brass); cursor: pointer; background: none; border: 0; padding: 0;
                margin-bottom: 20px; font: 700 12px ${BODY}; text-transform: uppercase; letter-spacing: .2em;
                transition: color .12s, transform .12s; }
  .menu .back::before { content: '\\25C0'; font-size: 9px; margin-right: 8px; vertical-align: 1px; }
  .menu .back:hover { color: var(--bone); transform: translateX(-2px); }

  /* Buttons: a dark plate in a gold hairline with bracketed corners, lit
     from within on hover, the way a League panel invites the click. */
  .btn { position: relative; display: block; width: 100%; max-width: 420px; text-align: center;
         background: linear-gradient(180deg, rgba(24,26,32,.88), rgba(9,10,13,.94)); color: #d9c48f;
         border: 1px solid rgba(200,170,110,.55); border-radius: 0; padding: 15px 26px; margin: 0 0 12px;
         cursor: pointer; font: 700 15px/1.1 ${DISPLAY}; text-transform: uppercase; letter-spacing: .22em;
         text-indent: .22em; white-space: nowrap; box-shadow: inset 0 0 0 1px rgba(0,0,0,.7), inset 0 1px 0 rgba(255,255,255,.05),
         0 10px 24px rgba(0,0,0,.55); transition: color .15s, border-color .15s, box-shadow .2s, transform .12s; }
  .btn::before { content: ''; position: absolute; inset: 4px; border: 1px solid rgba(200,170,110,.22);
         pointer-events: none; transition: border-color .15s; }
  .btn::after { content: ''; position: absolute; inset: 0; pointer-events: none; opacity: 0;
         background: linear-gradient(105deg, transparent 35%, rgba(240,215,154,.22) 50%, transparent 65%);
         background-size: 250% 100%; background-position: 120% 0; transition: opacity .15s; }
  .btn:hover, .btn:focus { outline: none; color: #fff2cf; border-color: #ecd394; transform: translateY(-1px);
         text-shadow: 0 0 14px rgba(236,211,148,.75), 0 0 2px rgba(255,255,255,.4);
         box-shadow: inset 0 0 0 1px rgba(0,0,0,.7), inset 0 0 26px rgba(200,170,110,.14),
                     0 0 26px rgba(200,170,110,.32), 0 12px 28px rgba(0,0,0,.6); }
  .btn:hover::before, .btn:focus::before { border-color: rgba(236,211,148,.55); }
  .btn:hover::after, .btn:focus::after { opacity: 1; animation: sheen .9s ease-out; }
  @keyframes sheen { from { background-position: 120% 0; } to { background-position: -20% 0; } }
  .btn:active { transform: translateY(1px); filter: brightness(.92); }
  /* Corner brackets. */
  .btn > i { position: absolute; width: 10px; height: 10px; pointer-events: none; }
  .btn.primary { font-size: 22px; padding: 20px 30px; letter-spacing: .4em; text-indent: .4em; color: #f3e3b6;
         border-color: rgba(236,211,148,.85);
         background:
           radial-gradient(ellipse 70% 120% at 50% 130%, rgba(224,17,31,.40), transparent 60%),
           linear-gradient(180deg, rgba(30,30,36,.92), rgba(10,10,14,.96));
         box-shadow: inset 0 0 0 1px rgba(0,0,0,.7), inset 0 0 22px rgba(200,170,110,.10),
                     0 0 18px rgba(200,170,110,.18), 0 12px 30px rgba(0,0,0,.6); }
  .btn.primary:hover, .btn.primary:focus { color: #fff;
         box-shadow: inset 0 0 0 1px rgba(0,0,0,.7), inset 0 0 34px rgba(224,17,31,.28),
                     0 0 36px rgba(224,17,31,.45), 0 0 20px rgba(236,211,148,.35), 0 14px 32px rgba(0,0,0,.65); }
  .btn.secondary { color: #d9c48f; }
  .btn.danger { color: #ff6b75; border-color: rgba(224,17,31,.55); }
  .btn.danger:hover, .btn.danger:focus { color: #ffb3b9; border-color: rgba(255,80,95,.9);
         text-shadow: 0 0 14px rgba(224,17,31,.8);
         box-shadow: inset 0 0 0 1px rgba(0,0,0,.7), inset 0 0 26px rgba(224,17,31,.16),
                     0 0 26px rgba(224,17,31,.35), 0 12px 28px rgba(0,0,0,.6); }
  .btn:disabled { cursor: not-allowed; opacity: .45; }
  /* An ornamental rule: a hairline fading out both ways with a diamond in the middle. */
  .rule { position: relative; height: 1px; max-width: 420px; margin: 10px auto 18px;
          background: linear-gradient(90deg, transparent, rgba(200,170,110,.7) 30%, rgba(200,170,110,.7) 70%, transparent); }
  .rule::after { content: ''; position: absolute; left: 50%; top: 50%; width: 7px; height: 7px;
          transform: translate(-50%, -50%) rotate(45deg); background: #c8aa6e; box-shadow: 0 0 10px rgba(200,170,110,.8); }

  /* Stat strip: brass labels, bone numbers. */
  .stats { display: flex; flex-wrap: wrap; gap: 8px 30px; margin-bottom: 20px; color: var(--muted);
           font: 700 11px ${BODY}; text-transform: uppercase; letter-spacing: .18em; }
  .menu.centered .stats { justify-content: center; }
  .stats b { color: var(--bone); font-size: 13px; letter-spacing: .06em; }

  /* Framed panels: a dark sheet with a brass hairline set inside its edge and
     bracketed corners. The white "paper" of the original becomes the arena
     floor's cream, kept for the cards' pictures. */
  .panel { position: relative; background: var(--panel); border: 1px solid rgba(255,255,255,.06);
           padding: 18px; box-shadow: 0 20px 50px rgba(0,0,0,.6), inset 0 0 0 1px rgba(0,0,0,.6); }
  .panel::before { content: ''; position: absolute; inset: 6px; border: 1px solid var(--brass-dim);
           pointer-events: none; }
  .panel::after { content: ''; position: absolute; inset: 6px; pointer-events: none;
           background:
             linear-gradient(var(--brass), var(--brass)) top left / 14px 2px no-repeat,
             linear-gradient(var(--brass), var(--brass)) top left / 2px 14px no-repeat,
             linear-gradient(var(--brass), var(--brass)) top right / 14px 2px no-repeat,
             linear-gradient(var(--brass), var(--brass)) top right / 2px 14px no-repeat,
             linear-gradient(var(--brass), var(--brass)) bottom left / 14px 2px no-repeat,
             linear-gradient(var(--brass), var(--brass)) bottom left / 2px 14px no-repeat,
             linear-gradient(var(--brass), var(--brass)) bottom right / 14px 2px no-repeat,
             linear-gradient(var(--brass), var(--brass)) bottom right / 2px 14px no-repeat; }
  .paper { padding: 6px; }
  .grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); }
  .card { position: relative; background: linear-gradient(#202024, #151518); border: 1px solid #000;
          padding: 8px; cursor: pointer; text-align: left; color: inherit; font: inherit;
          box-shadow: inset 0 1px 0 rgba(255,255,255,.08), 0 4px 0 #000, 0 8px 18px rgba(0,0,0,.5);
          transition: transform .08s, box-shadow .14s, filter .14s; }
  .card::after { content: ''; position: absolute; inset: 3px; border: 1px solid transparent; pointer-events: none;
          transition: border-color .14s, box-shadow .14s; }
  .card:hover:not(.locked), .card:focus:not(.locked) { transform: translateY(-3px); outline: none;
          box-shadow: inset 0 1px 0 rgba(255,255,255,.1), 0 7px 0 #000, 0 14px 26px rgba(0,0,0,.6), 0 0 22px var(--brass-glow); }
  .card:hover:not(.locked)::after, .card:focus:not(.locked)::after { border-color: var(--brass);
          box-shadow: inset 0 0 14px var(--brass-glow); }
  .card.locked { filter: grayscale(1) brightness(.45); cursor: not-allowed; }
  .card.locked::before { content: 'locked'; position: absolute; z-index: 2; top: 34%; left: 50%;
          transform: translate(-50%, -50%); padding: 4px 12px; background: rgba(8,8,10,.85); color: #d9d2c0;
          border: 1px solid rgba(233,226,208,.35); font: 700 11px ${BODY}; letter-spacing: .28em;
          text-transform: uppercase; }
  .card.on { box-shadow: inset 0 1px 0 rgba(255,255,255,.1), 0 4px 0 #000, 0 8px 18px rgba(0,0,0,.5), 0 0 26px rgba(224,17,31,.45); }
  .card.on::after { border-color: var(--red); box-shadow: inset 0 0 16px rgba(224,17,31,.35); }
  .card canvas, .card img.art { display: block; width: 100%; height: auto; background: #e9e2d0;
          border: 1px solid #000; box-shadow: inset 0 0 0 1px rgba(255,255,255,.08); }
  .card canvas[hidden], .card img.art[hidden] { display: none; }
  .card .t { margin-top: 10px; font: 700 13px ${DISPLAY}; text-transform: uppercase; letter-spacing: .12em;
             color: var(--bone); text-shadow: 0 2px 0 #000; }
  .card .d { color: var(--muted); font-size: 11px; margin-top: 2px; text-transform: uppercase; letter-spacing: .1em; }
  .card .best { color: var(--brass); font-size: 11px; margin-top: 4px; font-weight: 700; text-transform: uppercase;
                letter-spacing: .1em; }

  /* Lists and forms. */
  .keys { display: grid; grid-template-columns: 150px 1fr; gap: 10px 22px; color: var(--bone-dim); margin-bottom: 30px;
          max-width: 780px; }
  .keys dt { color: var(--brass); font: 700 11px ${BODY}; text-transform: uppercase; letter-spacing: .16em;
             padding-top: 3px; }
  .keys dd { margin: 0; }
  .row { display: flex; align-items: center; gap: 16px; margin-bottom: 14px; }
  .row label { color: var(--brass); min-width: 130px; font: 700 11px ${BODY}; text-transform: uppercase;
               letter-spacing: .16em; }
  .row input[type=range] { flex: 1; max-width: 260px; accent-color: var(--red); }
  .row input[type=checkbox] { width: 18px; height: 18px; accent-color: var(--red); }
  .row select, .row input[type=text] { font: 600 14px ${BODY}; padding: 9px 12px; border: 1px solid #000;
                background: linear-gradient(#1d1d21, #141417); color: var(--bone); border-radius: 2px;
                box-shadow: inset 0 1px 0 rgba(255,255,255,.06), inset 0 0 0 1px rgba(201,167,90,.18), 0 3px 0 #000;
                color-scheme: dark; }
  .row input[type=text] { flex: 1; max-width: 340px; }
  .row select:focus, .row input[type=text]:focus { outline: none;
                box-shadow: inset 0 1px 0 rgba(255,255,255,.06), inset 0 0 0 1px var(--brass), 0 3px 0 #000, 0 0 14px var(--brass-glow); }
  .row select:disabled { opacity: .5; }
  .row .hint { color: var(--muted); font-size: 12px; }
  .history { border-collapse: collapse; margin: 0 0 18px; font-size: 13px; color: var(--bone-dim); }
  .history th { text-align: left; color: var(--brass); font: 700 10px "Segoe UI", system-ui, sans-serif;
                text-transform: uppercase; letter-spacing: .16em; padding: 4px 18px 6px 0; }
  .history td { padding: 4px 18px 4px 0; border-top: 1px solid rgba(255,255,255,.05); }
  .history td b { color: var(--bone); }
  .tabs { display: flex; gap: 6px; margin: -6px 0 14px; flex-wrap: wrap; }
  .tab { font: 700 11px "Segoe UI", system-ui, sans-serif; letter-spacing: .2em; text-transform: uppercase;
         padding: 9px 18px; color: var(--bone-dim); background: linear-gradient(#1d1d21, #141417); border: 1px solid #000;
         border-bottom-color: var(--brass-dim); cursor: pointer; box-shadow: inset 0 1px 0 rgba(255,255,255,.06); }
  .tab:hover, .tab:focus { outline: none; color: var(--bone); border-color: var(--brass-dim); }
  .tab.on { color: #f3e3b6; border-color: var(--brass); border-bottom-color: var(--red); box-shadow: inset 0 0 18px var(--brass-glow), 0 0 12px var(--brass-glow); }
  .keygrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 0 30px; max-width: 700px; }
  .keygrid .row { margin-bottom: 10px; }
  .keygrid label { min-width: 140px; }
  button.key { font: 700 12px "Segoe UI", system-ui, sans-serif; letter-spacing: .1em; text-transform: uppercase;
               padding: 7px 14px; min-width: 96px; border: 1px solid var(--brass-dim); color: var(--bone);
               background: linear-gradient(#1d1d21, #141417); cursor: pointer; box-shadow: 0 3px 0 #000; }
  button.key:hover, button.key:focus { outline: none; border-color: var(--brass); box-shadow: 0 3px 0 #000, 0 0 14px var(--brass-glow); }
  button.key.listening { color: #ff8791; border-color: rgba(224,17,31,.7); animation: blink 1s steps(2) infinite; }
  @keyframes blink { to { opacity: .55; } }
  .row span, .row p { color: var(--bone-dim); }
  .note { background: rgba(201,167,90,.09); border: 1px solid var(--brass-dim); color: #e6cf94;
          padding: 10px 14px; margin: 0 0 16px; max-width: 560px; font-size: 13px; line-height: 1.5; }
  .note.bad { background: rgba(224,17,31,.12); border-color: rgba(224,17,31,.6); color: #ff8791; }
  .seats { display: grid; gap: 8px; margin: 0 0 24px; max-width: 560px; }
  .seat { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border: 1px solid #000;
          background: linear-gradient(#1d1d21, #141417); box-shadow: inset 0 1px 0 rgba(255,255,255,.06), 0 3px 0 #000; }
  .seat.me { box-shadow: inset 0 0 0 1px var(--red), 0 3px 0 #000, 0 0 16px rgba(224,17,31,.25); }
  .seat.empty { color: var(--muted); border-style: dashed; border-color: #2a2a2f; background: none; box-shadow: none; }
  .seat .n { font: 700 14px ${DISPLAY}; text-transform: uppercase; letter-spacing: .12em; flex: 1; }
  .seat .c { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .12em; }
  .seat .r { font: 700 10px ${BODY}; text-transform: uppercase; letter-spacing: .12em; padding: 3px 8px;
             background: #2a2a2f; color: var(--bone-dim); border: 1px solid #000; }
  .seat .r.on { background: #1f7a33; color: #fff; }
  .seat .r.host { background: var(--brass); color: #1a1408; }
  .seat .r.away { background: #7a5a12; color: #ffe2a3; }
  .badge { display: inline-block; margin-left: 10px; padding: 3px 8px; background: rgba(201,167,90,.12);
           color: #e6cf94; border: 1px solid var(--brass-dim); font: 700 10px ${BODY};
           text-transform: uppercase; letter-spacing: .12em; vertical-align: middle; }
  .badge.strong { background: var(--red); color: #fff; border-color: var(--red-lo); }
  .menu p { color: var(--bone-dim); }
  .menu code { color: #e6cf94; }

  /* Pause: the game stays visible under the dark sheet; the panel is a slab. */
  .menu.overlay .inner { padding-top: 72px; }
  .sheet { position: relative; background: var(--panel); padding: 30px 32px 22px; max-width: 480px; margin: 0 auto;
           border: 1px solid rgba(255,255,255,.06);
           box-shadow: 0 24px 60px rgba(0,0,0,.7), inset 0 0 0 1px rgba(0,0,0,.6); text-align: left; }
  .sheet::before { content: ''; position: absolute; inset: 6px; border: 1px solid var(--brass-dim); pointer-events: none; }
  .sheet h1 { font-size: 40px; margin-bottom: 2px; }
  .sheet .btn { max-width: none; }

  /* Debrief: the original's grey skull behind a blood-red score. */
  .watermark { position: fixed; inset: 0; z-index: 0; pointer-events: none; opacity: .16;
               filter: invert(1) contrast(1.4); }
  .debrief .big { font: 900 76px/1 ${DISPLAY}; color: var(--red-hi); margin: 2px 0 8px; letter-spacing: .04em;
                  text-shadow: 0 6px 0 var(--red-lo), 0 0 40px rgba(224,17,31,.55); }
  .debrief .best { color: var(--brass); letter-spacing: .24em; text-transform: uppercase; font-size: 11px;
                   font-weight: 700; margin-bottom: 26px; }
  .debrief .best.new { color: var(--red-hi); text-shadow: 0 0 14px rgba(224,17,31,.6); }
  .debrief .unlocked { color: var(--brass); }
  .build { position: fixed; right: 14px; bottom: 40px; color: var(--muted); font: 700 10px ${BODY};
           letter-spacing: .2em; text-transform: uppercase; opacity: .7; }
`;

/** Ember positions and timings, fixed so the backdrop looks the same every time. */
const EMBERS = Array.from({ length: 22 }, (_, i) => {
  const t = (i * 0.618034) % 1;
  return {
    left: Math.round(t * 100),
    delay: -((i * 1.73) % 14),
    duration: 11 + ((i * 2.9) % 9),
    drift: Math.round(((i % 5) - 2) * 40),
    size: 2 + (i % 3),
  };
});

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export class Menus {
  private readonly root: HTMLDivElement;
  private current: Screen = 'none';
  /** Where a secondary screen (options, how to play) returns to. */
  private origin: Screen = 'title';
  /** Which page of the options is open; remembered in the save. */
  private get optionsTab(): 'game' | 'sound' | 'feel' | 'controls' | 'progress' {
    const tab = this.save.optionsTab;
    return tab === 'sound' || tab === 'feel' || tab === 'controls' || tab === 'progress' ? tab : 'game';
  }
  private selectedCharacter: string;
  private selectedRoom: string;
  /** True while seated on a server; changes what pause and quit mean. */
  inMatch = false;
  private lobby: LobbyView | null = null;
  private readonly titleArt: TitleArt;

  constructor(
    parent: HTMLElement,
    private readonly pack: ArtPack,
    private readonly rooms: ExtractedRoom[],
    private readonly save: SaveData,
    private readonly screens: ScreenArt | null,
    private readonly callbacks: MenuCallbacks,
  ) {
    this.selectedCharacter = save.characterId;
    this.selectedRoom = save.lastRoomId ?? rooms[0]?.id ?? '';
    this.titleArt = new TitleArt(pack, rooms);
    window.addEventListener('resize', () => {
      const canvas = this.root.querySelector<HTMLCanvasElement>('canvas.hero-art');
      if (canvas) this.titleArt.draw(canvas);
    });

    const style = document.createElement('style');
    style.textContent = STYLE;
    parent.append(style);

    this.root = document.createElement('div');
    this.root.className = 'menu';
    parent.append(this.root);

    // Escape backs out of a screen; the pause screen resumes play. Opening
    // the pause screen from play is the game loop's job, since only it knows
    // whether a run exists.
    window.addEventListener('keydown', (event) => {
      if (event.code !== 'Escape') return;
      if (this.current === 'none') return;
      if (this.current === 'title' || this.current === 'debrief') return;
      event.preventDefault();
      // The game loop listens on the same key; a screen this handler closes
      // must not be reopened by it on the same press.
      event.stopImmediatePropagation();
      if (this.current === 'pause') {
        this.callbacks.onResume();
        return;
      }
      if (this.current === 'options' || this.current === 'instructions') {
        this.show(this.origin);
        return;
      }
      // Leaving a lobby is a button, not a key: a stray Escape must not drop the seat.
      if (this.current === 'lobby') return;
      this.show('title');
    });

    // Arrow keys walk the focus through a screen, so the menus work without
    // a mouse; a gamepad does the same through the poller below.
    window.addEventListener('keydown', (event) => {
      if (this.current === 'none') return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT')) return;
      const arrows: Record<string, [number, number]> = {
        ArrowUp: [0, -1],
        ArrowDown: [0, 1],
        ArrowLeft: [-1, 0],
        ArrowRight: [1, 0],
      };
      const direction = arrows[event.code];
      if (direction) {
        event.preventDefault();
        this.moveFocusToward(direction[0], direction[1]);
      }
    });
    window.setInterval(() => this.pollPad(), 50);
  }

  /** Everything on the current screen that can take focus, in reading order. */
  private focusables(): HTMLElement[] {
    const nodes = this.root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), select:not([disabled]), input:not([disabled]), a[href]',
    );
    return Array.from(nodes).filter((el) => el.offsetParent !== null);
  }

  private moveFocus(delta: number): void {
    const items = this.focusables();
    if (items.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const at = active ? items.indexOf(active) : -1;
    const next = at < 0 ? (delta > 0 ? 0 : items.length - 1) : (at + delta + items.length) % items.length;
    const target = items[next]!;
    target.focus();
    target.scrollIntoView({ block: 'nearest' });
  }

  /**
   * Move the focus the way the arrow points, by where things are on the
   * screen: down in a grid of rooms goes to the card below, not the one to
   * the right. Falls back to reading order when nothing lies that way.
   */
  private moveFocusToward(dx: number, dy: number): void {
    const items = this.focusables();
    const active = document.activeElement as HTMLElement | null;
    if (!active || !items.includes(active)) {
      this.moveFocus(dx + dy >= 0 ? 1 : -1);
      return;
    }
    const from = active.getBoundingClientRect();
    const fx = from.left + from.width / 2;
    const fy = from.top + from.height / 2;
    let best: HTMLElement | null = null;
    let bestScore = Infinity;
    for (const item of items) {
      if (item === active) continue;
      const r = item.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const ax = cx - fx;
      const ay = cy - fy;
      // Must lie in the arrow's half-plane, past the edge of the current box.
      const along = ax * dx + ay * dy;
      if (along <= 4) continue;
      const across = Math.abs(ax * dy) + Math.abs(ay * dx);
      const score = along + across * 2.5;
      if (score < bestScore) {
        bestScore = score;
        best = item;
      }
    }
    if (best) {
      best.focus();
      best.scrollIntoView({ block: 'nearest' });
    } else {
      this.moveFocus(dx + dy >= 0 ? 1 : -1);
    }
  }

  private padHeld = new Set<number>();
  private padRepeat = 0;

  /** D-pad or left stick moves focus, A activates, B backs out, Start resumes a pause. */
  private pollPad(): void {
    if (this.current === 'none') {
      this.padHeld.clear();
      return;
    }
    const pad = firstGamepad();
    if (!pad) return;
    this.callbacks.onPadSeen?.();
    const now = new Set<number>();
    pad.buttons.forEach((b, i) => {
      if (b.pressed || b.value > 0.5) now.add(i);
    });
    const y = pad.axes[1] ?? 0;
    if (y < -0.5) now.add(12);
    if (y > 0.5) now.add(13);
    const rose = (i: number): boolean => now.has(i) && !this.padHeld.has(i);

    // Held directions repeat slowly, so a long list can be walked.
    const x = pad.axes[0] ?? 0;
    if (x < -0.5) now.add(14);
    if (x > 0.5) now.add(15);
    const vertical = now.has(12) ? -1 : now.has(13) ? 1 : 0;
    const horizontal = now.has(14) ? -1 : now.has(15) ? 1 : 0;
    const moved = rose(12) || rose(13) || rose(14) || rose(15);
    if ((vertical !== 0 || horizontal !== 0) && (moved || ++this.padRepeat > 6)) {
      this.padRepeat = moved ? -4 : 0;
      this.moveFocusToward(horizontal, vertical);
    }
    if (vertical === 0 && horizontal === 0) this.padRepeat = 0;

    if (rose(0)) {
      const active = document.activeElement as HTMLElement | null;
      if (active && this.root.contains(active)) {
        if (active.tagName === 'SELECT') {
          // Step the choice on; a native dropdown cannot be driven from here.
          const select = active as HTMLSelectElement;
          select.selectedIndex = (select.selectedIndex + 1) % select.options.length;
          select.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          active.click();
        }
      } else {
        this.moveFocus(1);
      }
    }
    if (rose(1) || rose(9)) {
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true, cancelable: true }));
    }
    this.padHeld = now;
  }

  get screen(): Screen {
    return this.current;
  }

  get isOpen(): boolean {
    return this.current !== 'none';
  }

  show(screen: Screen, result?: RunResult): void {
    // Secondary screens remember whether play or the title opened them.
    if (screen === 'options' || screen === 'instructions') {
      if (this.current === 'pause' || this.current === 'title') this.origin = this.current;
    }
    this.current = screen;
    this.root.classList.toggle('on', screen !== 'none');
    this.root.classList.toggle('overlay', screen === 'pause');
    this.root.classList.toggle('centered', screen === 'debrief');
    this.root.classList.toggle('hero', screen === 'title');
    if (screen === 'none') {
      this.root.innerHTML = '';
      this.callbacks.onScreen(screen);
      return;
    }
    switch (screen) {
      case 'title':
        this.renderTitle();
        break;
      case 'rooms':
        this.renderRooms();
        break;
      case 'character':
        this.renderCharacters();
        break;
      case 'instructions':
        this.renderInstructions();
        break;
      case 'options':
        this.renderOptions();
        break;
      case 'pause':
        this.renderPause();
        break;
      case 'debrief':
        this.renderDebrief(result);
        break;
      case 'multiplayer':
        this.renderMultiplayer();
        break;
      case 'lobby':
        this.renderLobby();
        break;
      default:
        break;
    }
    this.root.scrollTop = 0;
    this.callbacks.onScreen(screen);
  }

  private shell(inner: string, hero = false): HTMLDivElement {
    const art = hero ? '<canvas class="hero-art"></canvas>' : '';
    const embers = EMBERS.map(
      (e) =>
        `<span class="ember" style="left:${e.left}%;width:${e.size}px;height:${e.size}px;` +
        `animation-duration:${e.duration}s;animation-delay:${e.delay}s;--drift:${e.drift}px"></span>`,
    ).join('');
    this.root.innerHTML = `${art}<div class="bg"></div><div class="embers">${embers}</div><div class="inner">${inner}</div>`;
    const canvas = this.root.querySelector<HTMLCanvasElement>('canvas.hero-art');
    if (canvas) this.titleArt.draw(canvas);
    return this.root.querySelector<HTMLDivElement>('.inner')!;
  }

  private backButton(container: HTMLElement, to: Screen): void {
    const button = container.querySelector<HTMLButtonElement>('.back');
    button?.addEventListener('click', () => this.show(to));
  }

  private wireGoButtons(container: HTMLElement): void {
    for (const button of container.querySelectorAll<HTMLButtonElement>('[data-go]')) {
      button.addEventListener('click', () => this.show(button.dataset.go as Screen));
    }
  }

  /**
   * Swap a generated stand-in for the original picture once it has loaded.
   * Assets are gitignored, so a missing file must leave the stand-in in place.
   */
  private swapInArt(container: HTMLElement): void {
    for (const img of container.querySelectorAll<HTMLImageElement>('img.art[hidden]')) {
      const standIn = img.previousElementSibling as HTMLElement | null;
      const reveal = (): void => {
        if (standIn) standIn.hidden = true;
        img.hidden = false;
      };
      if (img.complete && img.naturalWidth > 0) reveal();
      else img.addEventListener('load', reveal, { once: true });
    }
  }

  // ---- title --------------------------------------------------------------

  private renderTitle(): void {
    const best = this.save.bestOverall;
    const bestRoom = this.rooms.find((room) => room.id === best.roomId);
    const parked = this.save.savedRun;
    const parkedRoom = parked ? this.rooms.find((room) => room.id === parked.roomId) : undefined;
    const logo = this.screens?.logo;
    const inner = this.shell(`
      <h1 ${logo ? 'hidden' : ''}>BOXHEAD</h1>
      ${logo ? `<img class="logo" src="${assetUrl(`bitmaps/${logo}`)}" alt="Boxhead">` : ''}
      <div class="sub">2Play &middot; single player &middot; survive the rooms</div>
      <div class="stats">
        <div>best <b>${best.score.toLocaleString()}</b>${bestRoom ? ` in ${bestRoom.name}` : ''}</div>
        <div>rooms unlocked <b>${Math.min(this.save.unlockedRooms, this.rooms.length)}</b> / ${this.rooms.length}</div>
      </div>
      <div class="rule"></div>
      ${
        parked && parkedRoom
          ? `<button class="btn primary" id="continue">Continue</button>
             <div class="stats" style="margin:-6px 0 12px"><div>${escapeHtml(parkedRoom.name)} &middot; level <b>${parked.level}</b> &middot; <b>${parked.score.toLocaleString()}</b></div></div>
             <button class="btn" data-go="rooms">New game</button>`
          : `<button class="btn primary" data-go="rooms">Play</button>`
      }
      <button class="btn" data-go="multiplayer">Multiplayer</button>
      <button class="btn" data-go="character">Character</button>
      <button class="btn" data-go="options">Options</button>
      <button class="btn" data-go="instructions">How to play</button>
      <div class="rule"></div>
      <div class="build">build ${escapeHtml(__BUILD__)}</div>
    `, true);
    this.wireGoButtons(inner);
    inner.querySelector<HTMLButtonElement>('#continue')?.addEventListener('click', () => this.callbacks.onContinue());
    // If the logo file is missing, the text heading comes back.
    const image = inner.querySelector<HTMLImageElement>('img.logo');
    image?.addEventListener('error', () => {
      image.remove();
      inner.querySelector('h1')?.removeAttribute('hidden');
    });
  }

  /** The first bound key of each action, as caps, for the how-to-play. */
  private keyLabel(actions: BindableAction[]): string {
    return actions
      .map((action) => keyName((this.save.keys[action] ?? DEFAULT_BINDINGS[action])[0] ?? ''))
      .join(' ');
  }

  private characterName(id: string): string {
    return CHARACTERS.find((c) => c.id === id)?.name ?? id;
  }

  private difficultyName(id: string = this.save.difficulty): string {
    return DIFFICULTIES.find((d) => d.id === id)?.name ?? 'Beginner';
  }

  // ---- arena select -------------------------------------------------------

  private renderRooms(): void {
    const cards = this.rooms
      .map((room, index) => {
        const record = this.save.recordFor(room.id);
        const unlocked = this.save.isRoomUnlocked(index);
        const at = this.save.bestAt(room.id, this.save.difficulty);
        const best = at.score > 0
          ? `best ${at.score.toLocaleString()} &middot; level ${at.level}`
          : record.score > 0
            ? `no ${escapeHtml(this.difficultyName())} run yet &middot; best ${record.score.toLocaleString()} on ${escapeHtml(this.difficultyName(record.difficulty ?? 'beginner'))}`
            : 'not played';
        const icon = this.screens?.levelIcons[room.id];
        return `
          <button class="card ${unlocked ? '' : 'locked'}" data-room="${room.id}"
                  ${unlocked ? '' : 'disabled'}>
            <canvas data-map="${room.id}" width="360" height="200"></canvas>
            ${icon ? `<img class="art" src="${assetUrl(`bitmaps/${icon}`)}" alt="" hidden>` : ''}
            <div class="t">${index + 1}. ${room.name}</div>
            <div class="d">${room.width}&times;${room.height} &middot; ${room.blocks.length} blocks</div>
            <div class="best">${unlocked ? best : `clear ${UNLOCK_CLEARS} waves in room ${index} to unlock`}</div>
          </button>`;
      })
      .join('');

    const inner = this.shell(`
      <button class="back">&larr; back</button>
      <h2>Choose a room</h2>
      <div class="stats">
        <div>playing as <b>${this.characterName(this.selectedCharacter)}</b></div>
        <div>difficulty <b>${this.difficultyName()}</b></div>
        <div><label style="cursor:pointer"><input type="checkbox" id="shared" ${this.save.sharedScreen ? 'checked' : ''} style="accent-color:var(--red);vertical-align:-2px;margin-right:6px">two players on this screen</label></div>
        ${
          this.save.sharedScreen
            ? `<div>player 2 <b>${this.characterName(this.save.secondCharacterId)}</b>
                 <button class="back" id="secondChar" style="margin:0 0 0 8px">change</button>
                 &middot; <span style="text-transform:none;letter-spacing:0">gamepad, or arrows + Enter, Backspace pauses</span></div>
               <div><label style="cursor:pointer"><input type="checkbox" id="sharedDm" ${this.save.sharedMode === 'deathmatch' ? 'checked' : ''} style="accent-color:var(--red);vertical-align:-2px;margin-right:6px">deathmatch &mdash; head to head, first to ${DEATHMATCH_KILL_TARGETS[1]}</label></div>`
            : ''
        }
        ${this.save.practiceReason ? `<div><span class="badge strong">&#9888; practice run &mdash; ${this.save.practiceReason}</span></div>` : ''}
      </div>
      <div class="panel"><div class="paper"><div class="grid">${cards}</div></div></div>
    `);
    this.backButton(inner, 'title');
    const shared = inner.querySelector<HTMLInputElement>('#shared')!;
    shared.addEventListener('change', () => {
      this.save.setSharedScreen(shared.checked);
      // The second seat gets a different face from the first.
      if (shared.checked && this.save.secondCharacterId === this.selectedCharacter) {
        const other = CHARACTERS.find((c) => c.id !== this.selectedCharacter);
        if (other) this.save.setSecondCharacter(other.id);
      }
      this.renderRooms();
    });
    inner.querySelector<HTMLButtonElement>('#secondChar')?.addEventListener('click', () => {
      // Step to the next face that is not the first seat's.
      const ids = CHARACTERS.map((c) => c.id);
      let next = ids[(ids.indexOf(this.save.secondCharacterId) + 1) % ids.length]!;
      if (next === this.selectedCharacter) next = ids[(ids.indexOf(next) + 1) % ids.length]!;
      this.save.setSecondCharacter(next);
      this.renderRooms();
    });
    const sharedDm = inner.querySelector<HTMLInputElement>('#sharedDm');
    sharedDm?.addEventListener('change', () => this.save.setSharedMode(sharedDm.checked ? 'deathmatch' : 'coop'));

    for (const canvas of inner.querySelectorAll<HTMLCanvasElement>('[data-map]')) {
      const room = this.rooms.find((r) => r.id === canvas.dataset.map);
      if (room) this.drawMinimap(canvas, room);
    }
    this.swapInArt(inner);
    for (const button of inner.querySelectorAll<HTMLButtonElement>('[data-room]')) {
      button.addEventListener('click', () => {
        const id = button.dataset.room!;
        this.selectedRoom = id;
        this.save.setLastRoom(id);
        this.callbacks.onStart(id, this.selectedCharacter);
      });
    }
  }

  /** A top-down plan of the arena, drawn from the same blocks the game uses. */
  private drawMinimap(canvas: HTMLCanvasElement, room: ExtractedRoom): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const pad = 8;
    const scale = Math.min(
      (canvas.width - pad * 2) / room.width,
      (canvas.height - pad * 2) / room.height,
    );
    const offsetX = (canvas.width - room.width * scale) / 2;
    const offsetY = (canvas.height - room.height * scale) / 2;

    ctx.fillStyle = '#efefef';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#e4dccb';
    ctx.fillRect(offsetX, offsetY, room.width * scale, room.height * scale);

    ctx.fillStyle = '#9a9a9a';
    for (const block of room.blocks) {
      ctx.fillRect(
        offsetX + block.x * scale,
        offsetY + block.y * scale,
        Math.max(1, block.w * scale),
        Math.max(1, block.h * scale),
      );
    }
    // Spawn markers, so the shape of a run is readable before playing it.
    ctx.fillStyle = '#e2001a';
    for (const spot of room.spawns.zombies) {
      ctx.fillRect(offsetX + spot.x * scale - 1, offsetY + spot.y * scale - 1, 3, 3);
    }
    ctx.fillStyle = '#1e5fd0';
    for (const spot of room.spawns.players.slice(0, 1)) {
      ctx.fillRect(offsetX + spot.x * scale - 2, offsetY + spot.y * scale - 2, 5, 5);
    }
  }

  // ---- character select ---------------------------------------------------

  private renderCharacters(): void {
    const cards = CHARACTERS.map(
      (character) => `
        <button class="card ${character.id === this.selectedCharacter ? 'on' : ''}"
                data-char="${character.id}">
          <canvas data-portrait="${character.id}" width="300" height="260"></canvas>
          ${this.screens?.portraits[character.id]
            ? `<img class="art" src="${assetUrl(`bitmaps/${this.screens.portraits[character.id]}`)}" alt="" hidden>`
            : ''}
          <div class="t">${character.name}</div>
          <div class="d">cosmetic only &mdash; same stats</div>
        </button>`,
    ).join('');

    const inner = this.shell(`
      <button class="back">&larr; back</button>
      <h2>Choose a character</h2>
      <div class="panel"><div class="paper"><div class="grid">${cards}</div></div></div>
    `);
    this.backButton(inner, 'title');

    for (const canvas of inner.querySelectorAll<HTMLCanvasElement>('[data-portrait]')) {
      const id = canvas.dataset.portrait!;
      this.drawPortrait(canvas, id);
    }
    this.swapInArt(inner);
    for (const button of inner.querySelectorAll<HTMLButtonElement>('[data-char]')) {
      button.addEventListener('click', () => {
        this.selectedCharacter = button.dataset.char!;
        this.save.setCharacter(this.selectedCharacter);
        this.renderCharacters();
      });
    }
  }

  /** Draw a character with the real rig, so the portrait matches play. */
  private drawPortrait(canvas: HTMLCanvasElement, characterId: string): void {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#efefef';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const clips = new ClipIndex(this.pack.clips);
    const character = CHARACTERS.find((c) => c.id === characterId);
    const base = clips.get('Player', 'Stand');
    if (!base) return;

    // Three-quarter view from the front, which shows the face and the held
    // weapon: frame 11 of 16 faces south, so 10 is a touch to the right of it.
    const direction = Math.round(base.directions * 0.625) % base.directions;
    const layers: Layer[] = [{ clip: base, direction, frame: 0 }];
    const head = character?.headGroup ? clips.get(character.headGroup, 'Stand') : null;
    if (head) layers.push({ clip: head, direction: direction % head.directions, frame: 0 });
    const weapon = clips.get('Player_Shotgun', 'Stand');
    if (weapon) layers.push({ clip: weapon, direction: direction % weapon.directions, frame: 0 });

    const swap: TextureSwap = {};
    for (const piece of ['Body', 'Head'] as const) {
      for (const facing of ['Front', 'Back', 'Side', 'Top'] as const) {
        const specific = `${character?.skin ?? 'Swat'}_${piece}_${facing}`;
        if (this.pack.textures[specific]) swap[`${piece}_${facing}_MC`] = specific;
      }
    }

    const composed = composePose(layers);
    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height * 0.78);
    const palette = CHARACTER_PALETTES[characterId];
    drawComposed(ctx, composed.parts, {
      scale: 1.5,
      art: { textures: this.pack.textures, swap },
      ...(palette ? { palette } : {}),
    });
    ctx.restore();
  }

  // ---- pause --------------------------------------------------------------

  private renderPause(): void {
    const inner = this.shell(`
      <div class="sheet">
        <h1>Paused</h1>
        <div class="sub">the run is waiting</div>
        <button class="btn primary" id="resume">Resume</button>
        <button class="btn secondary" id="restart" ${this.inMatch ? 'hidden' : ''}>Restart room</button>
        <button class="btn secondary" data-go="options">Options</button>
        <button class="btn secondary" data-go="instructions">How to play</button>
        <button class="btn danger" id="quit">${this.inMatch ? 'Leave match' : 'Quit to menu'}</button>
      </div>
    `);
    inner.querySelector<HTMLButtonElement>('#resume')!.addEventListener('click', () => {
      this.callbacks.onResume();
    });
    inner.querySelector<HTMLButtonElement>('#restart')!.addEventListener('click', () => {
      this.callbacks.onRestart();
    });
    inner.querySelector<HTMLButtonElement>('#quit')!.addEventListener('click', () => {
      this.callbacks.onQuit();
    });
    this.wireGoButtons(inner);
    inner.querySelector<HTMLButtonElement>('#resume')!.focus();
  }

  // ---- instructions and options ------------------------------------------

  private renderInstructions(): void {
    const inner = this.shell(`
      <button class="back">&larr; back</button>
      <h2>How to play</h2>
      <div class="panel"><div class="paper">
      <dl class="keys">
        <dt>${escapeHtml(this.keyLabel(['up', 'left', 'down', 'right']))}</dt><dd>move</dd>
        <dt>mouse</dt><dd>aim</dd>
        <dt>click / ${escapeHtml(this.keyLabel(['fire']))}</dt><dd>fire &mdash; most guns fire once per press; hold to charge a grenade</dd>
        <dt>1 &ndash; 0</dt><dd>select weapon</dd>
        <dt>${escapeHtml(this.keyLabel(['prev', 'next']))}, wheel</dt><dd>cycle weapons</dd>
        <dt>${escapeHtml(this.keyLabel(['pause']))}</dt><dd>quick pause</dd>
        <dt>Escape</dt><dd>pause menu: resume, restart, options, quit</dd>
        <dt>R</dt><dd>restart the run (while paused)</dd>
        <dt>M</dt><dd>mute</dd>
        <dt>F3</dt><dd>performance stats</dd>
        <dt>Gamepad</dt><dd>left stick or d-pad moves, right stick aims, right trigger or A fires,
          bumpers cycle weapons, Start quick-pauses, B or Y opens the pause menu; in the menus the
          d-pad moves, A chooses, B goes back</dd>
        <dt>Two players</dt><dd>tick <i>two players on this screen</i> when choosing a room. Player 2
          takes the gamepad, or the arrow keys with Enter to fire, , . to cycle and Backspace to pause,
          and aims the way they walk. In co-op you share one screen, one score and one multiplier, and a
          fallen player comes back beside the other. Tick <i>deathmatch</i> for the original's head to
          head: no zombies, the whole arsenal owned but unloaded until a crate is found, first to twenty
          kills wins.</dd>
      </dl>
      <h2>Surviving</h2>
      <dl class="keys">
        <dt>Multiplier</dt><dd>Every kill raises it by one; stop killing and it drains,
          faster the higher it climbs. Weapons and upgrades are awarded at multiplier
          thresholds &mdash; the UZI at x5, the shotgun at x10, the railgun at x70 &mdash;
          and kept for the rest of the run.</dd>
        <dt>Levels</dt><dd>Clear a wave to level up. Each level is bigger and faster;
          zombies at level 40 move five times as fast as at level 1.</dd>
        <dt>Health</dt><dd>Regenerates on its own, fully in thirty seconds. A crate found
          while hurt may hold a life-up instead of ammo.</dd>
        <dt>Ammo</dt><dd>Only the pistol is unlimited. Every fifth kill of a quick streak
          drops a crate, as does every devil; a crate refills one weapon you carry.</dd>
        <dt>Barrels</dt><dd>Solid, and they block zombies as well as you. One shot sets
          one off. Place your own with key 4 once earned, and lead zombies into them.</dd>
        <dt>Barricades</dt><dd>Fake walls (key 6) hold zombies off for good; only devils
          and your own fire bring them down. Wall yourself in and the wave never ends.</dd>
      </dl>
      </div></div>
    `);
    this.backButton(inner, this.origin);
  }

  private renderOptions(): void {
    const inner = this.shell(`
      <button class="back">&larr; back</button>
      <h2>Options</h2>
      <div class="tabs">
        ${(['game', 'sound', 'feel', 'controls', 'progress'] as const)
          .map((tab) => `<button class="tab ${tab === this.optionsTab ? 'on' : ''}" data-tab="${tab}">${tab}</button>`)
          .join('')}
      </div>
      <div class="panel"><div class="paper">
      <section data-tab="game" ${this.optionsTab === 'game' ? '' : 'hidden'}>
      <div class="row">
        <label for="difficulty">Difficulty</label>
        <select id="difficulty">
          ${DIFFICULTIES.map(
            (d) => `<option value="${d.id}" ${d.id === this.save.difficulty ? 'selected' : ''}>
              ${d.name} &mdash; level ${d.startLevel}, multiplier x${d.startMultiplier}</option>`,
          ).join('')}
        </select>
      </div>
      <div class="row">
        <label for="speed">Game speed</label>
        <select id="speed">
          ${GAME_SPEEDS.map(
            (s) => `<option value="${s.id}" ${s.id === this.save.gameSpeed ? 'selected' : ''}>
              ${s.name} &mdash; ${s.factor}x${s.factor < 1 ? ' ⚠ no high scores' : ''}</option>`,
          ).join('')}
        </select>
        <span id="speedBadge" ${this.save.gameSpeed === 'slow' ? '' : 'hidden'}>${NO_SCORE_BADGE}</span>
      </div>
      <div class="row">
        <label for="devils">Devils</label>
        <input type="checkbox" id="devils" ${this.save.devils ? 'checked' : ''}>
        <span id="devilsBadge" ${this.save.devils ? 'hidden' : ''}>${NO_SCORE_BADGE}</span>
      </div>
      <div class="row">
        <label for="startLevel">Practice start</label>
        <input type="range" id="startLevel" min="1" max="60" value="${this.save.startLevel || 1}">
        <span id="startLevelVal">${this.save.startLevel ? `level ${this.save.startLevel}` : 'off'}</span>
        <span id="startLevelBadge" ${this.save.startLevel ? '' : 'hidden'}>${NO_SCORE_BADGE}</span>
      </div>
      <p class="hint" style="margin:-6px 0 0 146px;max-width:560px">Open the run on any level with the awards a preset
        would have banked there, to practise a wave the presets skip. Such a run counts for nothing.</p>
      </section>
      <section data-tab="sound" ${this.optionsTab === 'sound' ? '' : 'hidden'}>
      <div class="row">
        <label for="vol">Volume</label>
        <input type="range" id="vol" min="0" max="100" value="${Math.round(this.save.volume * 100)}">
        <span id="volVal">${Math.round(this.save.volume * 100)}%</span>
      </div>
      <div class="row">
        <label for="music">Music</label>
        <input type="range" id="music" min="0" max="100" value="${Math.round(this.save.music * 100)}">
        <span id="musicVal">${Math.round(this.save.music * 100)}%</span>
      </div>
      <div class="row">
        <label for="mute">Mute</label>
        <input type="checkbox" id="mute" ${this.save.muted ? 'checked' : ''}>
      </div>
      </section>
      <section data-tab="feel" ${this.optionsTab === 'feel' ? '' : 'hidden'}>
      <div class="row">
        <label for="shake">Screen shake</label>
        <input type="range" id="shake" min="0" max="100" value="${Math.round(this.save.shake * 100)}">
        <span id="shakeVal">${Math.round(this.save.shake * 100)}%</span>
      </div>
      <div class="row">
        <label for="flashes">Blast flashes</label>
        <input type="checkbox" id="flashes" ${this.save.flashes ? 'checked' : ''}>
        <span class="hint">off if bright flashes bother you</span>
      </div>
      <div class="row">
        <label for="hud">HUD size</label>
        <input type="range" id="hud" min="80" max="140" step="10" value="${Math.round(this.save.hudScale * 100)}">
        <span id="hudVal">${Math.round(this.save.hudScale * 100)}%</span>
      </div>
      <div class="row">
        <label for="lead">Camera leads the aim</label>
        <input type="checkbox" id="lead" ${this.save.cameraLead ? 'checked' : ''}>
      </div>
      <div class="row">
        <label for="contrast">High contrast</label>
        <input type="checkbox" id="contrast" ${this.save.highContrast ? 'checked' : ''}>
        <span class="hint">outlined markers and a framed heartbeat, not colour alone</span>
      </div>
      <div class="row">
        <label for="rumble">Gamepad rumble</label>
        <input type="checkbox" id="rumble" ${this.save.rumble ? 'checked' : ''}>
      </div>
      <div class="row">
        <label for="tips">One-time tips</label>
        <input type="checkbox" id="tips" ${this.save.tips ? 'checked' : ''}>
        <button class="key" id="resetTips" type="button">show them again</button>
      </div>
      </section>
      <section data-tab="controls" ${this.optionsTab === 'controls' ? '' : 'hidden'}>
      <p class="hint" style="margin:0 0 12px">Click a key and press the new one, or a mouse button. Shift-click to add a second key
        beside the first. Weapons stay on 1 to 0; Escape, R, M and F3 are the game's own.</p>
      <div id="keyNote" class="note bad" hidden></div>
      <div class="keygrid">
        ${(Object.keys(DEFAULT_BINDINGS) as BindableAction[])
          .map((action) => {
            const keys = this.save.keys[action] ?? DEFAULT_BINDINGS[action];
            return `<div class="row"><label>${ACTION_LABELS[action]}</label>
              <button class="key" data-action="${action}">${keys.map((k) => escapeHtml(keyName(k))).join(' / ')}</button></div>`;
          })
          .join('')}
      </div>
      <p class="hint" style="margin:14px 0 8px">Gamepad: click a button and press the new one. Sticks and the d-pad stay as they are.</p>
      <div class="keygrid">
        ${(Object.keys(DEFAULT_PAD) as PadAction[])
          .map((action) => {
            const buttons = this.save.pad[action] ?? DEFAULT_PAD[action];
            return `<div class="row"><label>${PAD_ACTION_LABELS[action]}</label>
              <button class="key" data-pad="${action}">${buttons.map((b) => escapeHtml(padButtonName(b))).join(' / ')}</button></div>`;
          })
          .join('')}
      </div>
      <button class="btn secondary" id="resetKeys" style="max-width:280px">Default keys and buttons</button>
      </section>
      <section data-tab="progress" ${this.optionsTab === 'progress' ? '' : 'hidden'}>
      <div class="stats">
        <div>rooms unlocked <b>${Math.min(this.save.unlockedRooms, this.rooms.length)}</b> / ${this.rooms.length}</div>
        <div>combined best <b>${this.save.totalBest.toLocaleString()}</b></div>
      </div>
      ${
        this.save.history.length > 0
          ? `<table class="history">
              <tr><th>when</th><th>room</th><th>difficulty</th><th>score</th><th>level</th><th>kills</th><th>time</th></tr>
              ${this.save.history
                .map((entry) => {
                  const room = this.rooms.find((r) => r.id === entry.roomId);
                  return `<tr><td>${escapeHtml(whenLabel(entry.at))}</td><td>${escapeHtml(room?.name ?? entry.roomId)}</td><td>${escapeHtml(this.difficultyName(entry.difficulty))}</td>
                    <td><b>${entry.score.toLocaleString()}</b></td><td>${entry.level}</td><td>${entry.kills}</td><td>${formatSeconds(entry.seconds)}</td></tr>`;
                })
                .join('')}
            </table>`
          : ''
      }
      <div class="row" style="align-items:flex-start">
        <label for="progressCode" style="padding-top:9px">Progress code</label>
        <div style="flex:1;max-width:560px">
          <p class="hint" style="margin:6px 0 8px">Your scores, unlocks and history as text: copy it into the downloaded
            <code>boxhead.html</code> or another browser, or keep it safe. Pasting a code merges it with what is here.</p>
          <textarea id="progressCode" rows="2" spellcheck="false" style="width:100%;box-sizing:border-box;font:12px ui-monospace,Consolas,monospace;
            background:linear-gradient(#1d1d21,#141417);color:var(--bone);border:1px solid #000;padding:8px;resize:vertical;
            box-shadow:inset 0 1px 0 rgba(255,255,255,.06),inset 0 0 0 1px rgba(201,167,90,.18)">${escapeHtml(this.save.exportCode())}</textarea>
          <div style="display:flex;gap:10px;margin-top:8px;align-items:center;flex-wrap:wrap">
            <button class="key" id="copyCode" type="button">copy</button>
            <button class="key" id="copyLink" type="button">copy as link</button>
            <button class="key" id="importCode" type="button">import what is pasted</button>
            <span id="codeNote" class="hint"></span>
          </div>
        </div>
      </div>
      <button class="btn danger" id="reset">Reset scores and unlocks</button>
      </section>
      </div></div>
    `);
    this.backButton(inner, this.origin);
    for (const tab of inner.querySelectorAll<HTMLButtonElement>('button.tab')) {
      tab.addEventListener('click', () => {
        this.save.setOptionsTab(tab.dataset.tab ?? 'game');
        for (const other of inner.querySelectorAll<HTMLButtonElement>('button.tab')) other.classList.toggle('on', other === tab);
        for (const section of inner.querySelectorAll<HTMLElement>('section[data-tab]')) section.hidden = section.dataset.tab !== tab.dataset.tab;
      });
    }

    const volume = inner.querySelector<HTMLInputElement>('#vol')!;
    const volumeValue = inner.querySelector<HTMLSpanElement>('#volVal')!;
    volume.addEventListener('input', () => {
      const value = Number(volume.value) / 100;
      volumeValue.textContent = `${volume.value}%`;
      this.save.setVolume(value);
      this.callbacks.onVolume(value);
    });

    const music = inner.querySelector<HTMLInputElement>('#music')!;
    const musicValue = inner.querySelector<HTMLSpanElement>('#musicVal')!;
    music.addEventListener('input', () => {
      const value = Number(music.value) / 100;
      musicValue.textContent = `${music.value}%`;
      this.save.setMusic(value);
      this.callbacks.onMusic(value);
    });

    const mute = inner.querySelector<HTMLInputElement>('#mute')!;
    mute.addEventListener('change', () => {
      this.save.setMuted(mute.checked);
      this.callbacks.onMuted(mute.checked);
    });

    const shake = inner.querySelector<HTMLInputElement>('#shake')!;
    const shakeValue = inner.querySelector<HTMLSpanElement>('#shakeVal')!;
    shake.addEventListener('input', () => {
      shakeValue.textContent = `${shake.value}%`;
      this.save.setShake(Number(shake.value) / 100);
      this.callbacks.onFeel();
    });
    const flashes = inner.querySelector<HTMLInputElement>('#flashes')!;
    flashes.addEventListener('change', () => {
      this.save.setFlashes(flashes.checked);
      this.callbacks.onFeel();
    });
    const hud = inner.querySelector<HTMLInputElement>('#hud')!;
    const hudValue = inner.querySelector<HTMLSpanElement>('#hudVal')!;
    hud.addEventListener('input', () => {
      hudValue.textContent = `${hud.value}%`;
      this.save.setHudScale(Number(hud.value) / 100);
      this.callbacks.onFeel();
    });
    const rumble = inner.querySelector<HTMLInputElement>('#rumble')!;
    rumble.addEventListener('change', () => {
      this.save.setRumble(rumble.checked);
      this.callbacks.onFeel();
    });
    const lead = inner.querySelector<HTMLInputElement>('#lead')!;
    lead.addEventListener('change', () => {
      this.save.setCameraLead(lead.checked);
      this.callbacks.onFeel();
    });
    const contrast = inner.querySelector<HTMLInputElement>('#contrast')!;
    contrast.addEventListener('change', () => {
      this.save.setHighContrast(contrast.checked);
      this.callbacks.onFeel();
    });
    const tips = inner.querySelector<HTMLInputElement>('#tips')!;
    tips.addEventListener('change', () => this.save.setTips(tips.checked));
    inner.querySelector<HTMLButtonElement>('#resetTips')!.addEventListener('click', () => {
      this.save.resetTips();
      this.save.setTips(true);
      this.renderOptions();
    });

    const difficulty = inner.querySelector<HTMLSelectElement>('#difficulty')!;
    difficulty.addEventListener('change', () => this.save.setDifficulty(difficulty.value));
    const speed = inner.querySelector<HTMLSelectElement>('#speed')!;
    const speedBadge = inner.querySelector<HTMLSpanElement>('#speedBadge')!;
    speed.addEventListener('change', () => {
      this.save.setGameSpeed(speed.value);
      speedBadge.hidden = speed.value !== 'slow';
    });
    const devils = inner.querySelector<HTMLInputElement>('#devils')!;
    const devilsBadge = inner.querySelector<HTMLSpanElement>('#devilsBadge')!;
    devils.addEventListener('change', () => {
      this.save.setDevils(devils.checked);
      devilsBadge.hidden = devils.checked;
    });
    const startLevel = inner.querySelector<HTMLInputElement>('#startLevel')!;
    const startLevelValue = inner.querySelector<HTMLSpanElement>('#startLevelVal')!;
    const startLevelBadge = inner.querySelector<HTMLSpanElement>('#startLevelBadge')!;
    startLevel.addEventListener('input', () => {
      const level = Number(startLevel.value);
      this.save.setStartLevel(level <= 1 ? 0 : level);
      startLevelValue.textContent = this.save.startLevel ? `level ${this.save.startLevel}` : 'off';
      startLevelBadge.hidden = this.save.startLevel === 0;
    });

    const keyNote = inner.querySelector<HTMLDivElement>('#keyNote')!;
    for (const button of inner.querySelectorAll<HTMLButtonElement>('button.key[data-action]')) {
      button.addEventListener('click', (click) => {
        const action = button.dataset.action!;
        const add = click.shiftKey;
        button.textContent = add ? 'press a second key' : 'press a key';
        button.classList.add('listening');
        const finish = (code: string | null): void => {
          window.removeEventListener('keydown', onKey, true);
          window.removeEventListener('mousedown', onMouse, true);
          if (code && RESERVED_KEYS.has(code)) {
            keyNote.textContent = `${keyName(code)} is the game's own key and cannot be bound.`;
            keyNote.hidden = false;
            button.textContent = (this.save.keys[action] ?? DEFAULT_BINDINGS[action as BindableAction])
              .map((k) => keyName(k)).join(' / ');
            button.classList.remove('listening');
            return;
          }
          if (code) this.save.setKey(action, code, DEFAULT_BINDINGS, add);
          this.callbacks.onKeys();
          this.renderOptions();
          inner.querySelector<HTMLButtonElement>(`button.key[data-action="${action}"]`)?.focus();
        };
        const onKey = (event: KeyboardEvent): void => {
          event.preventDefault();
          event.stopImmediatePropagation();
          finish(event.code === 'Escape' ? null : event.code);
        };
        const onMouse = (event: MouseEvent): void => {
          // The click that opened the capture is already over; a primary
          // click elsewhere simply cancels.
          if (event.target === button) return;
          event.preventDefault();
          event.stopImmediatePropagation();
          finish(mouseCode(event.button));
        };
        window.setTimeout(() => {
          window.addEventListener('keydown', onKey, true);
          window.addEventListener('mousedown', onMouse, true);
        }, 0);
      });
    }
    for (const button of inner.querySelectorAll<HTMLButtonElement>('button.key[data-pad]')) {
      button.addEventListener('click', () => {
        const action = button.dataset.pad!;
        button.textContent = 'press a button';
        button.classList.add('listening');
        // Watch the pad until a button rises; Escape gives up.
        const held = new Set<number>();
        const first = firstGamepad();
        first?.buttons.forEach((b, i) => {
          if (b.pressed) held.add(i);
        });
        const stop = (): void => {
          window.clearInterval(timer);
          window.removeEventListener('keydown', onKey, true);
        };
        const onKey = (event: KeyboardEvent): void => {
          if (event.code !== 'Escape') return;
          event.preventDefault();
          event.stopImmediatePropagation();
          stop();
          this.renderOptions();
        };
        window.addEventListener('keydown', onKey, true);
        const timer = window.setInterval(() => {
          const pad = firstGamepad();
          if (!pad) return;
          for (let i = 0; i < pad.buttons.length; i++) {
            const pressed = pad.buttons[i]!.pressed || pad.buttons[i]!.value > 0.5;
            if (!pressed) {
              held.delete(i);
              continue;
            }
            if (held.has(i) || i >= 12) continue;
            stop();
            this.save.setPadButton(action, i, DEFAULT_PAD);
            this.callbacks.onKeys();
            this.renderOptions();
            inner.querySelector<HTMLButtonElement>(`button.key[data-pad="${action}"]`)?.focus();
            return;
          }
        }, 40);
      });
    }
    inner.querySelector<HTMLButtonElement>('#resetKeys')!.addEventListener('click', () => {
      this.save.resetKeys();
      this.callbacks.onKeys();
      this.renderOptions();
    });

    const codeField = inner.querySelector<HTMLTextAreaElement>('#progressCode')!;
    const codeNote = inner.querySelector<HTMLSpanElement>('#codeNote')!;
    inner.querySelector<HTMLButtonElement>('#copyCode')!.addEventListener('click', () => {
      codeField.value = this.save.exportCode();
      codeField.select();
      const done = (): void => {
        codeNote.textContent = 'copied';
      };
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(codeField.value).then(done, done);
      else done();
    });
    inner.querySelector<HTMLButtonElement>('#copyLink')!.addEventListener('click', () => {
      const link = this.save.exportLink();
      codeField.value = link;
      codeField.select();
      const done = (): void => {
        codeNote.textContent = 'link copied: open it in the other copy of the game';
      };
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(link).then(done, done);
      else done();
    });
    inner.querySelector<HTMLButtonElement>('#importCode')!.addEventListener('click', () => {
      const pasted = codeField.value.trim();
      const fromLink = /#progress=([^&]+)/.exec(pasted);
      if (this.save.importCode(fromLink ? decodeURIComponent(fromLink[1]!) : pasted)) {
        codeNote.textContent = 'merged';
        this.renderOptions();
      } else {
        codeNote.textContent = 'that is not a progress code';
      }
    });

    inner.querySelector<HTMLButtonElement>('#reset')!.addEventListener('click', () => {
      // Destructive and one click away, so make it deliberate.
      if (!window.confirm('Erase every high score and re-lock all rooms?')) return;
      this.save.reset();
      this.renderOptions();
    });
  }

  // ---- multiplayer --------------------------------------------------------

  private renderMultiplayer(): void {
    const secure = window.location.protocol === 'https:';
    const inner = this.shell(`
      <button class="back">&larr; back</button>
      <h2>Multiplayer</h2>
      <div class="panel"><div class="paper">
      <p style="max-width:560px;margin:0 0 18px">
        Somebody runs the server (<code>npm start</code> in the project) and shares its address,
        the way a Minecraft server works. Type it here to join.
      </p>
      ${
        secure
          ? `<div class="note">This page is served over HTTPS, so browsers will only let it reach servers
             with a certificate (<b>wss://</b>). To join an ordinary server, open the downloadable
             <b>boxhead.html</b> from your computer instead.</div>`
          : ''
      }
      <div class="row">
        <label for="server">Server</label>
        <input type="text" id="server" placeholder="192.168.1.20 or host:8787" value="${escapeHtml(this.save.netServer)}" autocomplete="off" spellcheck="false">
      </div>
      <div class="row">
        <label for="name">Your name</label>
        <input type="text" id="name" maxlength="24" placeholder="player" value="${escapeHtml(this.save.playerName)}" autocomplete="off" spellcheck="false">
      </div>
      <div class="row">
        <label>Character</label>
        <span>${this.characterName(this.selectedCharacter)}</span>
        <button class="back" style="margin:0" data-go="character">change</button>
      </div>
      <div id="netError" class="note bad" hidden></div>
      <button class="btn primary" id="connect">Connect</button>
      </div></div>
    `);
    this.backButton(inner, 'title');
    this.wireGoButtons(inner);
    const server = inner.querySelector<HTMLInputElement>('#server')!;
    const name = inner.querySelector<HTMLInputElement>('#name')!;
    const connect = (): void => {
      const address = server.value.trim();
      if (!address) {
        server.focus();
        return;
      }
      const playerName = name.value.trim() || 'player';
      this.save.setNet(address, playerName);
      this.callbacks.onConnect(address, playerName, this.selectedCharacter);
    };
    inner.querySelector<HTMLButtonElement>('#connect')!.addEventListener('click', connect);
    for (const field of [server, name]) {
      field.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') connect();
      });
    }
    (server.value ? name : server).focus();
  }

  /** Show a connection problem on the multiplayer screen, opening it if needed. */
  showNetError(text: string): void {
    if (this.current !== 'multiplayer') this.show('multiplayer');
    const box = this.root.querySelector<HTMLDivElement>('#netError');
    if (!box) return;
    box.textContent = text;
    box.hidden = false;
  }

  /** Update the lobby screen, opening it if a different screen is up. */
  setLobby(view: LobbyView | null): void {
    this.lobby = view;
    if (view && this.current !== 'lobby') {
      this.show('lobby');
      return;
    }
    if (this.current === 'lobby') this.renderLobby();
  }

  private renderLobby(): void {
    const view = this.lobby;
    if (!view) {
      this.shell(`<h2>Connecting&hellip;</h2><button class="btn danger" id="leave">Cancel</button>`)
        .querySelector<HTMLButtonElement>('#leave')!
        .addEventListener('click', () => this.callbacks.onLeaveMatch());
      return;
    }
    const me = view.players.find((p) => p.index === view.localIndex);
    const seats: string[] = [];
    const maxSeats = Math.max(4, ...view.players.map((p) => p.index + 1));
    for (let i = 0; i < maxSeats; i++) {
      const player = view.players.find((p) => p.index === i);
      if (!player) {
        seats.push(`<div class="seat empty"><span class="n">open seat</span></div>`);
        continue;
      }
      seats.push(`
        <div class="seat ${player.index === view.localIndex ? 'me' : ''}">
          <span class="n">${escapeHtml(player.name)}</span>
          <span class="c">${this.characterName(player.character)}</span>
          ${player.host ? '<span class="r host">host</span>' : ''}
          ${!player.connected ? '<span class="r away">reconnecting</span>' : ''}
          <span class="r ${player.ready ? 'on' : ''}">${player.ready ? 'ready' : 'not ready'}</span>
        </div>`);
    }
    const room = view.rooms.find((r) => r.id === view.config.roomId);
    const canEdit = view.isHost && view.phase !== 'playing';
    const everyoneReady = view.players.every((p) => p.ready || !p.connected);
    const inner = this.shell(`
      <button class="back">&larr; leave</button>
      <h2>${view.phase === 'playing' ? 'Match in progress' : view.phase === 'over' ? 'Match over' : 'Lobby'}</h2>
      <div class="stats">
        <div>server <b>${escapeHtml(view.address)}</b></div>
        <div>${escapeHtml(view.status)}</div>
      </div>
      <div class="panel"><div class="paper">
      <div class="seats">${seats.join('')}</div>
      <h2>Match</h2>
      <div class="row">
        <label for="lroom">Room</label>
        <select id="lroom" ${canEdit ? '' : 'disabled'}>
          ${view.rooms.map((r) => `<option value="${r.id}" ${r.id === view.config.roomId ? 'selected' : ''}>${escapeHtml(r.name)}</option>`).join('')}
        </select>
      </div>
      <div class="row">
        <label for="lmode">Mode</label>
        <select id="lmode" ${canEdit ? '' : 'disabled'}>
          <option value="coop" ${view.config.mode === 'coop' ? 'selected' : ''}>Co-op &mdash; survive together</option>
          <option value="deathmatch" ${view.config.mode === 'deathmatch' ? 'selected' : ''}>Deathmatch &mdash; every player for themselves</option>
        </select>
      </div>
      <div class="row">
        <label for="ldiff">Difficulty</label>
        <select id="ldiff" ${canEdit ? '' : 'disabled'}>
          ${DIFFICULTIES.map((d) => `<option value="${d.id}" ${d.id === view.config.difficulty ? 'selected' : ''}>${d.name}</option>`).join('')}
        </select>
      </div>
      <div class="row">
        <label for="lspeed">Game speed</label>
        <select id="lspeed" ${canEdit ? '' : 'disabled'}>
          ${GAME_SPEEDS.map((sp) => `<option value="${sp.id}" ${sp.id === view.config.gameSpeed ? 'selected' : ''}>${sp.name}</option>`).join('')}
        </select>
      </div>
      <div class="row">
        <label for="ldevils">Devils</label>
        <input type="checkbox" id="ldevils" ${view.config.devils ? 'checked' : ''} ${canEdit ? '' : 'disabled'}>
        <span class="hint">${room ? escapeHtml(room.name) : ''}</span>
      </div>
      ${
        view.phase === 'playing'
          ? `<button class="btn primary" id="rejoin">Join the match in progress</button>`
          : `<button class="btn ${me?.ready ? 'secondary' : ''}" id="ready">${me?.ready ? 'Not ready' : 'Ready'}</button>
             ${
               view.isHost
                 ? `<button class="btn primary" id="start" ${everyoneReady ? '' : 'disabled style="opacity:.5"'}>Start match</button>`
                 : `<p class="hint">Waiting for the host to start.</p>`
             }`
      }
      </div></div>
    `);
    inner.querySelector<HTMLButtonElement>('.back')!.addEventListener('click', () => this.callbacks.onLeaveMatch());
    inner.querySelector<HTMLButtonElement>('#ready')?.addEventListener('click', () => {
      this.callbacks.onLobbyReady(!(me?.ready ?? false));
    });
    inner.querySelector<HTMLButtonElement>('#start')?.addEventListener('click', () => this.callbacks.onLobbyStart());
    inner.querySelector<HTMLButtonElement>('#rejoin')?.addEventListener('click', () => this.show('none'));
    if (canEdit) {
      const roomSelect = inner.querySelector<HTMLSelectElement>('#lroom')!;
      roomSelect.addEventListener('change', () => this.callbacks.onLobbyConfigure({ roomId: roomSelect.value }));
      const mode = inner.querySelector<HTMLSelectElement>('#lmode')!;
      mode.addEventListener('change', () => this.callbacks.onLobbyConfigure({ mode: mode.value as MatchConfig['mode'] }));
      const difficulty = inner.querySelector<HTMLSelectElement>('#ldiff')!;
      difficulty.addEventListener('change', () => this.callbacks.onLobbyConfigure({ difficulty: difficulty.value }));
      const speed = inner.querySelector<HTMLSelectElement>('#lspeed')!;
      speed.addEventListener('change', () => this.callbacks.onLobbyConfigure({ gameSpeed: speed.value }));
      const devils = inner.querySelector<HTMLInputElement>('#ldevils')!;
      devils.addEventListener('change', () => this.callbacks.onLobbyConfigure({ devils: devils.checked }));
    }
  }

  // ---- debrief ------------------------------------------------------------

  private renderDebrief(result?: RunResult): void {
    if (!result) {
      this.show('title');
      return;
    }
    if (result.versus) {
      this.renderVersusDebrief(result, result.versus);
      return;
    }
    const delta = result.score - result.bestBefore;
    const verdict = result.practice
      ? `<span class="badge strong">&#9888; practice run (${result.practice}) &mdash; not recorded</span>`
      : result.bestBefore <= 0
        ? 'first run here on this difficulty'
        : result.isBest
          ? `new personal best &middot; +${delta.toLocaleString()} over the old one`
          : `${(-delta).toLocaleString()} short of your best ${result.bestBefore.toLocaleString()}`;
    const inner = this.shell(`
      <canvas class="watermark"></canvas>
      <div class="debrief">
        <h2>${result.roomName}</h2>
        <div class="sub" style="margin-bottom:0">final score</div>
        <div class="big">${result.score.toLocaleString()}</div>
        <div class="best ${result.isBest ? 'new' : ''}">${verdict}</div>
        <div class="stats">
          <div>level reached <b>${result.level}</b></div>
          <div>kills <b>${result.kills}</b></div>
          <div>peak multiplier <b>x${result.peakMultiplier}</b></div>
          <div>survived <b>${formatSeconds(result.seconds)}</b></div>
          <div>difficulty <b>${escapeHtml(this.difficultyName(result.difficulty))}</b></div>
        </div>
        <div class="stats">
          ${result.accuracy !== null ? `<div>accuracy <b>${Math.round(result.accuracy * 100)}%</b></div>` : ''}
          <div>longest streak <b>${result.longestStreak}</b></div>
          ${result.favouriteWeapon ? `<div>most kills with <b>${escapeHtml(result.favouriteWeapon)}</b></div>` : ''}
        </div>
        <div class="stats">
          ${
            result.unlockedNext
              ? '<div class="unlocked">new room unlocked</div>'
              : result.practice || result.levelsCleared >= UNLOCK_CLEARS
                ? ''
                : `<div>clear <b>${UNLOCK_CLEARS - result.levelsCleared}</b> more ${UNLOCK_CLEARS - result.levelsCleared === 1 ? 'wave' : 'waves'} here to unlock the next room</div>`
          }
        </div>
        <button class="btn primary" id="again">Play again</button>
        <button class="btn secondary" data-go="rooms">Choose another room</button>
        <button class="btn secondary" data-go="title">Main menu</button>
      </div>
    `);
    inner.querySelector<HTMLButtonElement>('#again')!.addEventListener('click', () => {
      this.callbacks.onStart(result.roomId, this.selectedCharacter);
    });
    this.wireGoButtons(inner);
    this.drawWatermark(inner.querySelector<HTMLCanvasElement>('.watermark')!);
  }

  /** A deathmatch ends with a winner, not a score: the original's "PLAYER n WINS". */
  private renderVersusDebrief(result: RunResult, versus: RunResult['versus'] & object): void {
    const winner = versus.winnerIndex >= 0 ? versus.names[versus.winnerIndex] ?? `Player ${versus.winnerIndex + 1}` : null;
    const inner = this.shell(`
      <canvas class="watermark"></canvas>
      <div class="debrief">
        <h2>${escapeHtml(result.roomName)}</h2>
        <div class="sub" style="margin-bottom:0">deathmatch</div>
        <div class="big" style="font-size:56px">${winner ? `${escapeHtml(winner)} wins` : 'draw'}</div>
        <div class="stats">
          ${versus.kills.map((k, i) => `<div>${escapeHtml(versus.names[i] ?? `Player ${i + 1}`)} <b>${k}</b></div>`).join('')}
          <div>survived <b>${formatSeconds(result.seconds)}</b></div>
        </div>
        <button class="btn primary" id="again">Rematch</button>
        <button class="btn secondary" data-go="rooms">Choose another room</button>
        <button class="btn secondary" data-go="title">Main menu</button>
      </div>
    `);
    inner.querySelector<HTMLButtonElement>('#again')!.addEventListener('click', () => {
      this.callbacks.onStart(result.roomId, this.selectedCharacter);
    });
    this.wireGoButtons(inner);
    this.drawWatermark(inner.querySelector<HTMLCanvasElement>('.watermark')!);
  }

  /** The original debrief's grey skull and crossbones, scaled to cover the screen. */
  private drawWatermark(canvas: HTMLCanvasElement): void {
    const art = this.pack.sprites['Screen_Debrief'];
    if (!art) {
      canvas.remove();
      return;
    }
    const width = window.innerWidth;
    const height = window.innerHeight;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // The symbol is a 640x480 stage with a little overhang; cover the viewport.
    const artWidth = (art.bounds.xMax - art.bounds.xMin) / 20;
    const artHeight = (art.bounds.yMax - art.bounds.yMin) / 20;
    const scale = Math.max(width / artWidth, height / artHeight);
    ctx.translate((width - artWidth * scale) / 2, (height - artHeight * scale) / 2);
    ctx.scale(scale, scale);
    ctx.translate(-art.bounds.xMin / 20, -art.bounds.yMin / 20);
    drawSprite(ctx, art, 0, 0, { scale: 1 });
  }
}
