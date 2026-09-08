/**
 * Front-end screens: title, arena select, character select, instructions,
 * options, the pause screen and the post-run debrief.
 *
 * These are real DOM rather than canvas drawing. Menus are text and lists, and
 * the browser already does text, focus, keyboard navigation and scrolling far
 * better than hand-rolled canvas widgets would.
 *
 * The look follows the original's own screens, decoded from the SWF: white
 * paper, heavy black uppercase headings, red for anything you can press, grey
 * panels framing a white sheet for the room grid, the brown floor band along
 * the bottom of the title, a grey skull watermarking the debrief, and the
 * pause screen as a dark overlay with a brown band over the frozen game.
 *
 * Arena thumbnails and character portraits are the exception to "no canvas":
 * both are drawn from the same data the game uses, so what the menu shows is
 * what you get; the original's own bitmaps replace them when present.
 */
import type { ArtPack, ExtractedRoom, LobbyPlayer, MatchConfig, RoomPhase } from '@boxhead/shared';
import { CHARACTERS, DIFFICULTIES, GAME_SPEEDS } from '@boxhead/shared';
import { drawComposed, type TextureSwap } from '../render/VectorModel.js';
import { ClipIndex, composePose, type Layer } from '../render/Rig.js';
import { drawSprite } from '../render/SpriteRenderer.js';
import type { SaveData } from '../state/SaveData.js';
import { UNLOCK_LEVEL } from '../state/SaveData.js';
import { assetUrl } from '../assets/AssetSource.js';
import { CHARACTER_PALETTES } from '../render/HeadArt.js';

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
  isBest: boolean;
  unlockedNext: boolean;
  /** Why the run did not count for high scores, or null when it did. */
  practice: string | null;
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
  onResume: () => void;
  /** Restart the current run in the same arena. */
  onRestart: () => void;
  /** Abandon the current run and return to the title. */
  onQuit: () => void;
  onVolume: (value: number) => void;
  onMuted: (value: boolean) => void;
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

const DISPLAY = '"Arial Black", Impact, "Segoe UI Black", "Helvetica Neue", Arial, sans-serif';
const BODY = '"Segoe UI", system-ui, -apple-system, Roboto, Helvetica, Arial, sans-serif';

const STYLE = `
  .menu {
    position: fixed; inset: 0; z-index: 20; display: none;
    background: #ffffff; color: #141414; overflow-y: auto;
    font: 15px/1.45 ${BODY};
  }
  .menu.on { display: block; animation: menuIn .16s ease-out; }
  @keyframes menuIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  /* The floor band along the bottom of the original's title screen. */
  .menu::after { content: ''; position: fixed; left: 0; right: 0; bottom: 0; height: 34px;
                 background: #8f3a14; border-top: 5px solid #5a230a; pointer-events: none; }
  .menu .inner { max-width: 940px; margin: 0 auto; padding: 22px 28px 70px; position: relative; }
  .menu.centered .inner { text-align: center; }
  .menu.centered .btn { margin-left: auto; margin-right: auto; text-align: center; }

  .menu h1 { margin: 0; font: 900 58px/1 ${DISPLAY}; text-transform: uppercase; color: #141414;
             letter-spacing: .01em; }
  .menu img.logo { display: block; width: min(460px, 78%); height: auto; margin: 0 auto 2px;
                   filter: drop-shadow(0 6px 10px rgba(0,0,0,.18)); }
  .menu .sub { margin: 6px 0 26px; color: #7b7b7b; letter-spacing: .2em; text-transform: uppercase;
               font-size: 12px; font-weight: 700; }
  .menu h2 { font: 900 22px/1.1 ${DISPLAY}; text-transform: uppercase; color: #141414; margin: 0 0 16px; }
  .menu .back { color: #c9001a; cursor: pointer; background: none; border: 0; padding: 0;
                margin-bottom: 22px; font: 800 13px ${BODY}; text-transform: uppercase; letter-spacing: .12em; }
  .menu .back:hover { color: #141414; }

  .btn { display: block; width: 100%; max-width: 440px; text-align: left; background: #e2001a; color: #fff;
         border: 0; border-radius: 5px; padding: 13px 18px 12px; margin: 0 0 13px; cursor: pointer;
         font: 900 19px/1.15 ${DISPLAY}; text-transform: uppercase; letter-spacing: .03em;
         box-shadow: 0 5px 0 #7d000f; transition: transform .07s, box-shadow .07s, background .12s; }
  .btn:hover, .btn:focus { background: #ff1f38; transform: translateY(-2px); box-shadow: 0 7px 0 #7d000f; outline: none; }
  .btn:active { transform: translateY(3px); box-shadow: 0 2px 0 #7d000f; }
  .btn .k { display: block; margin-top: 3px; font: 13px/1.3 ${BODY}; text-transform: none; letter-spacing: 0;
            color: rgba(255,255,255,.88); font-weight: 400; }
  .btn.secondary { background: #1e1e1e; box-shadow: 0 5px 0 #000; }
  .btn.secondary:hover, .btn.secondary:focus { background: #383838; box-shadow: 0 7px 0 #000; }
  .btn.danger { background: #fff; color: #b00016; border: 2px solid #e2001a; box-shadow: 0 5px 0 #d6d6d6; }
  .btn.danger:hover, .btn.danger:focus { background: #fff3f4; box-shadow: 0 7px 0 #d6d6d6; }
  .btn.danger .k { color: #8a4a52; }

  .stats { display: flex; flex-wrap: wrap; gap: 8px 28px; margin-bottom: 26px; color: #6d6d6d;
           font-size: 12px; text-transform: uppercase; letter-spacing: .1em; font-weight: 700; }
  .menu.centered .stats { justify-content: center; }
  .stats b { color: #141414; }

  /* The grey panel and white sheet of the original's room select. */
  .panel { background: #cfcfcf; border-radius: 10px; padding: 14px; }
  .paper { background: #fff; border-radius: 6px; padding: 14px; }
  .grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); }
  .card { background: #fff; border: 2px solid #dedede; border-radius: 6px; padding: 8px; cursor: pointer;
          text-align: left; color: inherit; font: inherit; box-shadow: 0 3px 0 #dedede;
          transition: transform .07s, border-color .12s, box-shadow .12s; }
  .card:hover:not(.locked), .card:focus:not(.locked) { border-color: #e2001a; transform: translateY(-2px);
          box-shadow: 0 6px 0 #f4b6bd; outline: none; }
  .card.locked { opacity: .42; cursor: not-allowed; }
  .card.on { border-color: #e2001a; box-shadow: 0 3px 0 #e2001a; }
  .card canvas, .card img.art { display: block; width: 100%; height: auto; border-radius: 4px; background: #efefef; }
  /* The display rule above would otherwise beat the hidden attribute, and both would show. */
  .card canvas[hidden], .card img.art[hidden] { display: none; }
  .card .t { margin-top: 8px; font: 900 14px ${DISPLAY}; text-transform: uppercase; color: #141414; }
  .card .d { color: #7b7b7b; font-size: 12px; margin-top: 2px; }
  .card .best { color: #b00016; font-size: 12px; margin-top: 2px; font-weight: 700; }

  .keys { display: grid; grid-template-columns: 140px 1fr; gap: 9px 20px; color: #333; margin-bottom: 26px;
          max-width: 760px; }
  .keys dt { color: #b00016; font-weight: 800; text-transform: uppercase; font-size: 12px; letter-spacing: .06em;
             padding-top: 2px; }
  .keys dd { margin: 0; }
  .row { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; }
  .row label { color: #444; min-width: 130px; font-weight: 800; text-transform: uppercase; font-size: 12px;
               letter-spacing: .08em; }
  .row input[type=range] { flex: 1; max-width: 260px; accent-color: #e2001a; }
  .row input[type=checkbox] { width: 18px; height: 18px; accent-color: #e2001a; }
  .row select { font: 600 14px ${BODY}; padding: 7px 10px; border: 2px solid #dedede; border-radius: 5px;
                background: #fff; color: #141414; }
  .row select:focus { border-color: #e2001a; outline: none; }
  .row input[type=text] { flex: 1; max-width: 340px; font: 600 15px ${BODY}; padding: 8px 10px;
                          border: 2px solid #dedede; border-radius: 5px; color: #141414; background: #fff;
                          color-scheme: light; }
  .row input[type=text]:focus { border-color: #e2001a; outline: none; }
  .row .hint { color: #7b7b7b; font-size: 12px; }
  .note { background: #fff3d6; border: 1px solid #f0c76a; color: #8a5a00; border-radius: 5px;
          padding: 10px 14px; margin: 0 0 16px; max-width: 560px; font-size: 13px; line-height: 1.5; }
  .note.bad { background: #ffe9ec; border-color: #f4b6bd; color: #b00016; }
  .seats { display: grid; gap: 8px; margin: 0 0 22px; max-width: 560px; }
  .seat { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-radius: 6px;
          background: #f3f3f3; border: 2px solid #e6e6e6; }
  .seat.me { border-color: #e2001a; }
  .seat.empty { color: #9a9a9a; border-style: dashed; }
  .seat .n { font: 900 15px ${DISPLAY}; text-transform: uppercase; flex: 1; }
  .seat .c { color: #7b7b7b; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
  .seat .r { font: 800 11px ${BODY}; text-transform: uppercase; letter-spacing: .08em; padding: 2px 8px;
             border-radius: 3px; background: #dedede; color: #444; }
  .seat .r.on { background: #1f9d3a; color: #fff; }
  .seat .r.host { background: #141414; color: #fff; }
  .seat .r.away { background: #f0c76a; color: #5a3d00; }
  .row select:disabled { opacity: .55; }
  .badge { display: inline-block; margin-left: 10px; padding: 2px 8px; border-radius: 3px;
           background: #fff3d6; color: #8a5a00; border: 1px solid #f0c76a; font: 700 11px ${BODY};
           text-transform: uppercase; letter-spacing: .06em; vertical-align: middle; }
  .badge.strong { background: #e2001a; color: #fff; border-color: #e2001a; }

  /* Pause: the game stays visible under a dark sheet with the original's brown band. */
  .menu.overlay { background: rgba(0,0,0,.72); }
  .menu.overlay::before { content: ''; position: fixed; top: 0; left: 0; right: 0; height: 44px;
                          background: rgba(153,51,0,.9); border-bottom: 3px solid rgba(0,0,0,.35); }
  .menu.overlay::after { display: none; }
  .menu.overlay .inner { padding-top: 70px; }
  .sheet { background: #fff; border-radius: 10px; padding: 28px 30px 20px; max-width: 480px; margin: 0 auto;
           box-shadow: 0 16px 44px rgba(0,0,0,.45); text-align: left; }
  .sheet h1 { font-size: 46px; margin-bottom: 4px; }
  .sheet .btn { max-width: none; }

  /* Debrief: a grey skull under the score, as the original had it. */
  .watermark { position: fixed; inset: 0; z-index: -1; pointer-events: none; opacity: .38; }
  .debrief .big { font: 900 80px/1 ${DISPLAY}; color: #e2001a; margin: 4px 0 6px; letter-spacing: .01em;
                  text-shadow: 0 5px 0 #7d000f; }
  .debrief .best { color: #1e1e1e; letter-spacing: .16em; text-transform: uppercase; font-size: 12px;
                   font-weight: 800; margin-bottom: 26px; }
  .debrief .best.new { color: #b00016; }
`;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export class Menus {
  private readonly root: HTMLDivElement;
  private current: Screen = 'none';
  /** Where a secondary screen (options, how to play) returns to. */
  private origin: Screen = 'title';
  private selectedCharacter: string;
  private selectedRoom: string;
  /** True while seated on a server; changes what pause and quit mean. */
  inMatch = false;
  private lobby: LobbyView | null = null;

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
    this.root.classList.toggle('centered', screen === 'title' || screen === 'debrief');
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

  private shell(inner: string): HTMLDivElement {
    this.root.innerHTML = `<div class="inner">${inner}</div>`;
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
    const logo = this.screens?.logo;
    const inner = this.shell(`
      <h1 ${logo ? 'hidden' : ''}>BOXHEAD</h1>
      ${logo ? `<img class="logo" src="${assetUrl(`bitmaps/${logo}`)}" alt="Boxhead">` : ''}
      <div class="sub">2Play &middot; single player &middot; survive the rooms</div>
      <div class="stats">
        <div>best <b>${best.score.toLocaleString()}</b>${bestRoom ? ` in ${bestRoom.name}` : ''}</div>
        <div>rooms unlocked <b>${Math.min(this.save.unlockedRooms, this.rooms.length)}</b> / ${this.rooms.length}</div>
      </div>
      <button class="btn" data-go="rooms">Play
        <span class="k">choose a room &middot; ${this.characterName(this.selectedCharacter)} &middot; ${this.difficultyName()}${
          this.save.practiceReason ? ` &middot; practice (${this.save.practiceReason}) &#9888;` : ''
        }</span></button>
      <button class="btn secondary" data-go="multiplayer">Multiplayer
        <span class="k">join a server &middot; co-op or deathmatch</span></button>
      <button class="btn secondary" data-go="character">Character
        <span class="k">currently ${this.characterName(this.selectedCharacter)}</span></button>
      <button class="btn secondary" data-go="options">Options
        <span class="k">difficulty, game speed, devils, sound</span></button>
      <button class="btn secondary" data-go="instructions">How to play</button>
    `);
    this.wireGoButtons(inner);
    // If the logo file is missing, the text heading comes back.
    const image = inner.querySelector<HTMLImageElement>('img.logo');
    image?.addEventListener('error', () => {
      image.remove();
      inner.querySelector('h1')?.removeAttribute('hidden');
    });
  }

  private characterName(id: string): string {
    return CHARACTERS.find((c) => c.id === id)?.name ?? id;
  }

  private difficultyName(): string {
    return DIFFICULTIES.find((d) => d.id === this.save.difficulty)?.name ?? 'Beginner';
  }

  // ---- arena select -------------------------------------------------------

  private renderRooms(): void {
    const cards = this.rooms
      .map((room, index) => {
        const record = this.save.recordFor(room.id);
        const unlocked = this.save.isRoomUnlocked(index);
        const best = record.score > 0
          ? `best ${record.score.toLocaleString()} &middot; level ${record.level}`
          : 'not played';
        const icon = this.screens?.levelIcons[room.id];
        return `
          <button class="card ${unlocked ? '' : 'locked'}" data-room="${room.id}"
                  ${unlocked ? '' : 'disabled'}>
            <canvas data-map="${room.id}" width="360" height="200"></canvas>
            ${icon ? `<img class="art" src="${assetUrl(`bitmaps/${icon}`)}" alt="" hidden>` : ''}
            <div class="t">${index + 1}. ${room.name}</div>
            <div class="d">${room.width}&times;${room.height} &middot; ${room.blocks.length} blocks</div>
            <div class="best">${unlocked ? best : `reach level ${UNLOCK_LEVEL} to unlock`}</div>
          </button>`;
      })
      .join('');

    const inner = this.shell(`
      <button class="back">&larr; back</button>
      <h2>Choose a room</h2>
      <div class="stats">
        <div>playing as <b>${this.characterName(this.selectedCharacter)}</b></div>
        <div>difficulty <b>${this.difficultyName()}</b></div>
        ${this.save.practiceReason ? `<div><span class="badge strong">&#9888; practice run &mdash; ${this.save.practiceReason}</span></div>` : ''}
      </div>
      <div class="panel"><div class="paper"><div class="grid">${cards}</div></div></div>
    `);
    this.backButton(inner, 'title');

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
        <button class="btn" id="resume">Resume
          <span class="k">Esc</span></button>
        <button class="btn secondary" id="restart" ${this.inMatch ? 'hidden' : ''}>Restart room
          <span class="k">same room, same character &mdash; this run's score is kept</span></button>
        <button class="btn secondary" data-go="options">Options</button>
        <button class="btn secondary" data-go="instructions">How to play</button>
        <button class="btn danger" id="quit">${this.inMatch ? 'Leave match' : 'Quit to menu'}
          <span class="k">${this.inMatch ? 'your seat is freed for someone else' : "this run's score is kept"}</span></button>
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
      <dl class="keys">
        <dt>W A S D</dt><dd>move</dd>
        <dt>mouse</dt><dd>aim</dd>
        <dt>click / space</dt><dd>fire &mdash; most guns fire once per press; hold to charge a grenade</dd>
        <dt>1 &ndash; 0</dt><dd>select weapon</dd>
        <dt>Q / E, wheel</dt><dd>cycle weapons</dd>
        <dt>P</dt><dd>quick pause</dd>
        <dt>Escape</dt><dd>pause menu: resume, restart, options, quit</dd>
        <dt>R</dt><dd>restart the run (while paused)</dd>
        <dt>M</dt><dd>mute</dd>
        <dt>F3</dt><dd>performance stats</dd>
      </dl>
      <h2>Surviving</h2>
      <dl class="keys">
        <dt>Multiplier</dt><dd>Every kill raises it by one; stop killing and it drains,
          faster the higher it climbs. Weapons and upgrades are awarded at multiplier
          thresholds &mdash; the UZI at x5, the shotgun at x10, the railgun at x70 &mdash;
          and kept for the rest of the run.</dd>
        <dt>Levels</dt><dd>Clear a wave to level up. Each level is bigger and faster;
          zombies at level 40 move five times as fast as at level 1.</dd>
        <dt>Health</dt><dd>Regenerates on its own, fully in thirty seconds. There are no
          health crates.</dd>
        <dt>Ammo</dt><dd>Only the pistol is unlimited. Every fifth kill of a quick streak
          drops a crate, as does every devil; a crate refills one weapon you carry.</dd>
        <dt>Barrels</dt><dd>Solid, and they block zombies as well as you. One shot sets
          one off. Place your own with key 4 once earned, and lead zombies into them.</dd>
        <dt>Barricades</dt><dd>Fake walls (key 6) buy time. Zombies chew through them
          when going around would take too long, so leave an opening.</dd>
      </dl>
    `);
    this.backButton(inner, this.origin);
  }

  private renderOptions(): void {
    const inner = this.shell(`
      <button class="back">&larr; back</button>
      <h2>Options</h2>
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
      <h2 style="margin-top:30px">Sound</h2>
      <div class="row">
        <label for="vol">Volume</label>
        <input type="range" id="vol" min="0" max="100" value="${Math.round(this.save.volume * 100)}">
        <span id="volVal">${Math.round(this.save.volume * 100)}%</span>
      </div>
      <div class="row">
        <label for="mute">Mute</label>
        <input type="checkbox" id="mute" ${this.save.muted ? 'checked' : ''}>
      </div>
      <h2 style="margin-top:30px">Progress</h2>
      <div class="stats">
        <div>rooms unlocked <b>${Math.min(this.save.unlockedRooms, this.rooms.length)}</b> / ${this.rooms.length}</div>
        <div>combined best <b>${this.save.totalBest.toLocaleString()}</b></div>
      </div>
      <button class="btn danger" id="reset">Reset scores and unlocks
        <span class="k">this cannot be undone</span></button>
    `);
    this.backButton(inner, this.origin);

    const volume = inner.querySelector<HTMLInputElement>('#vol')!;
    const volumeValue = inner.querySelector<HTMLSpanElement>('#volVal')!;
    volume.addEventListener('input', () => {
      const value = Number(volume.value) / 100;
      volumeValue.textContent = `${volume.value}%`;
      this.save.setVolume(value);
      this.callbacks.onVolume(value);
    });

    const mute = inner.querySelector<HTMLInputElement>('#mute')!;
    mute.addEventListener('change', () => {
      this.save.setMuted(mute.checked);
      this.callbacks.onMuted(mute.checked);
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
      <p style="max-width:560px;color:#444;margin:0 0 18px">
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
      <button class="btn" id="connect">Connect
        <span class="k">joins the lobby; the host picks the room and mode</span></button>
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
          ? `<button class="btn" id="rejoin">Join the match in progress</button>`
          : `<button class="btn ${me?.ready ? 'secondary' : ''}" id="ready">${me?.ready ? 'Not ready' : 'Ready'}
               <span class="k">everyone must be ready before the host can start</span></button>
             ${
               view.isHost
                 ? `<button class="btn" id="start" ${everyoneReady ? '' : 'disabled style="opacity:.5"'}>Start match
                      <span class="k">${everyoneReady ? 'everyone is ready' : 'waiting for players to ready up'}</span></button>`
                 : `<p style="color:#7b7b7b">Waiting for the host to start.</p>`
             }`
      }
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
    const record = this.save.recordFor(result.roomId);
    const inner = this.shell(`
      <canvas class="watermark"></canvas>
      <div class="debrief">
        <h2>${result.roomName}</h2>
        <div class="sub" style="margin-bottom:0">final score</div>
        <div class="big">${result.score.toLocaleString()}</div>
        <div class="best ${result.isBest ? 'new' : ''}">${
          result.practice
            ? `<span class="badge strong">&#9888; practice run (${result.practice}) &mdash; not recorded</span>`
            : result.isBest ? 'new personal best' : `best ${record.score.toLocaleString()}`
        }</div>
        <div class="stats">
          <div>level reached <b>${result.level}</b></div>
          <div>kills <b>${result.kills}</b></div>
          ${result.unlockedNext ? '<div style="color:#b00016">new room unlocked</div>' : ''}
        </div>
        <button class="btn" id="again">Play again
          <span class="k">${result.roomName}, same character</span></button>
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
