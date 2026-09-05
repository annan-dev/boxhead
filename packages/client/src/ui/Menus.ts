/**
 * Front-end screens: title, arena select, character select, instructions,
 * options and the post-run debrief.
 *
 * These are real DOM rather than canvas drawing. Menus are text and lists, and
 * the browser already does text, focus, keyboard navigation and scrolling far
 * better than hand-rolled canvas widgets would.
 *
 * Arena thumbnails and character portraits are the exception: both are drawn
 * from the same data the game uses, so what the menu shows is what you get.
 */
import type { ArtPack, ExtractedRoom } from '@boxhead/shared';
import { CHARACTERS } from '@boxhead/shared';
import { drawComposed, type TextureSwap } from '../render/VectorModel.js';
import { ClipIndex, composePose, type Layer } from '../render/Rig.js';
import type { SaveData } from '../state/SaveData.js';
import { UNLOCK_LEVEL } from '../state/SaveData.js';

export type Screen =
  | 'title'
  | 'rooms'
  | 'character'
  | 'instructions'
  | 'options'
  | 'debrief'
  | 'none';

export interface RunResult {
  roomId: string;
  roomName: string;
  score: number;
  level: number;
  kills: number;
  isBest: boolean;
  unlockedNext: boolean;
}

export interface MenuCallbacks {
  onStart: (roomId: string, characterId: string) => void;
  onResume: () => void;
  onVolume: (value: number) => void;
  onMuted: (value: boolean) => void;
}

const STYLE = `
  .menu {
    position: fixed; inset: 0; z-index: 20; display: none;
    background: radial-gradient(circle at 50% 30%, #1b1d22 0%, #0a0b0d 70%);
    color: #dfe3e8; overflow-y: auto;
    font: 14px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  .menu.on { display: block; }
  .menu .inner { max-width: 940px; margin: 0 auto; padding: 40px 24px 64px; }
  .menu h1 { margin: 0; font-size: 54px; letter-spacing: .22em; font-weight: 800;
             color: #e8e2d6; text-shadow: 0 3px 0 #7a1d16, 0 4px 18px rgba(0,0,0,.7); }
  .menu .sub { margin: 6px 0 34px; color: #6f7883; letter-spacing: .18em;
               text-transform: uppercase; font-size: 11px; }
  .menu h2 { font-size: 12px; letter-spacing: .18em; text-transform: uppercase;
             color: #8b939e; margin: 0 0 16px; }
  .menu .back { color: #6f7883; cursor: pointer; background: none; border: 0;
                font: inherit; padding: 0; margin-bottom: 22px; }
  .menu .back:hover { color: #dfe3e8; }
  .btn { display: block; width: 100%; text-align: left; background: #191c21;
         border: 1px solid #2c313a; color: #dfe3e8; font: inherit; cursor: pointer;
         padding: 14px 18px; border-radius: 6px; margin-bottom: 10px;
         transition: border-color .12s, background .12s, transform .12s; }
  .btn:hover, .btn:focus { border-color: #a8372a; background: #20242b; outline: none; }
  .btn .k { color: #6f7883; font-size: 11px; display: block; margin-top: 3px;
            letter-spacing: .04em; }
  .btn.primary { border-color: #8d3327; background: #24191a; }
  .btn.primary:hover { background: #2e1d1d; }
  .stats { display: flex; gap: 26px; margin-bottom: 30px; color: #6f7883; font-size: 12px; }
  .stats b { color: #ffd88a; font-weight: 600; }
  .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); }
  .card { background: #191c21; border: 1px solid #2c313a; border-radius: 6px;
          padding: 10px; cursor: pointer; text-align: left; color: inherit;
          font: inherit; transition: border-color .12s, background .12s; }
  .card:hover:not(.locked), .card:focus:not(.locked) { border-color: #a8372a;
          background: #20242b; outline: none; }
  .card.locked { opacity: .38; cursor: not-allowed; }
  .card.on { border-color: #d0a13a; background: #221f18; }
  .card canvas { display: block; width: 100%; border-radius: 4px; background: #101216; }
  .card .t { margin-top: 8px; color: #cdd4dd; }
  .card .d { color: #6f7883; font-size: 11px; margin-top: 2px; }
  .card .best { color: #ffd88a; font-size: 11px; margin-top: 2px; }
  .keys { display: grid; grid-template-columns: 130px 1fr; gap: 8px 18px;
          color: #9aa3ad; margin-bottom: 26px; }
  .keys dt { color: #ffd88a; }
  .keys dd { margin: 0; }
  .row { display: flex; align-items: center; gap: 14px; margin-bottom: 16px; }
  .row label { color: #8b939e; min-width: 120px; }
  .row input[type=range] { flex: 1; max-width: 260px; }
  .danger { border-color: #5d2a24; color: #d98b7f; }
  .debrief .big { font-size: 40px; color: #ffcf4a; margin: 4px 0 2px; }
  .debrief .best { color: #7fd88a; letter-spacing: .1em; text-transform: uppercase;
                   font-size: 11px; margin-bottom: 24px; }
`;

export class Menus {
  private readonly root: HTMLDivElement;
  private current: Screen = 'none';
  private selectedCharacter: string;
  private selectedRoom: string;

  constructor(
    parent: HTMLElement,
    private readonly pack: ArtPack,
    private readonly rooms: ExtractedRoom[],
    private readonly save: SaveData,
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

    // Escape backs out of a screen, or opens the menu during play.
    window.addEventListener('keydown', (event) => {
      if (event.code !== 'Escape') return;
      if (this.current === 'none') return;
      if (this.current === 'title' || this.current === 'debrief') return;
      event.preventDefault();
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
    this.current = screen;
    this.root.classList.toggle('on', screen !== 'none');
    if (screen === 'none') {
      this.root.innerHTML = '';
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
      case 'debrief':
        this.renderDebrief(result);
        break;
      default:
        break;
    }
  }

  private shell(inner: string): HTMLDivElement {
    this.root.innerHTML = `<div class="inner">${inner}</div>`;
    return this.root.querySelector<HTMLDivElement>('.inner')!;
  }

  private backButton(container: HTMLElement, to: Screen): void {
    const button = container.querySelector<HTMLButtonElement>('.back');
    button?.addEventListener('click', () => this.show(to));
  }

  // ---- title --------------------------------------------------------------

  private renderTitle(): void {
    const best = this.save.bestOverall;
    const bestRoom = this.rooms.find((room) => room.id === best.roomId);
    const inner = this.shell(`
      <h1>BOXHEAD</h1>
      <div class="sub">survive the rooms</div>
      <div class="stats">
        <div>best <b>${best.score.toLocaleString()}</b>${bestRoom ? ` in ${bestRoom.name}` : ''}</div>
        <div>arenas unlocked <b>${Math.min(this.save.unlockedRooms, this.rooms.length)}</b> / ${this.rooms.length}</div>
      </div>
      <button class="btn primary" data-go="rooms">Play
        <span class="k">choose an arena and a character</span></button>
      <button class="btn" data-go="character">Character
        <span class="k">currently ${this.characterName(this.selectedCharacter)}</span></button>
      <button class="btn" data-go="instructions">How to play</button>
      <button class="btn" data-go="options">Options</button>
    `);
    for (const button of inner.querySelectorAll<HTMLButtonElement>('[data-go]')) {
      button.addEventListener('click', () => this.show(button.dataset.go as Screen));
    }
  }

  private characterName(id: string): string {
    return CHARACTERS.find((c) => c.id === id)?.name ?? id;
  }

  // ---- arena select -------------------------------------------------------

  private renderRooms(): void {
    const cards = this.rooms
      .map((room, index) => {
        const record = this.save.recordFor(room.id);
        const unlocked = this.save.isRoomUnlocked(index);
        const best = record.score > 0
          ? `best ${record.score.toLocaleString()} · level ${record.level}`
          : 'not played';
        return `
          <button class="card ${unlocked ? '' : 'locked'}" data-room="${room.id}"
                  ${unlocked ? '' : 'disabled'}>
            <canvas data-map="${room.id}" width="360" height="200"></canvas>
            <div class="t">${index + 1}. ${room.name}</div>
            <div class="d">${room.width}x${room.height} · ${room.blocks.length} blocks</div>
            <div class="best">${unlocked ? best : `reach level ${UNLOCK_LEVEL} to unlock`}</div>
          </button>`;
      })
      .join('');

    const inner = this.shell(`
      <button class="back">&larr; back</button>
      <h2>Choose an arena</h2>
      <div class="grid">${cards}</div>
    `);
    this.backButton(inner, 'title');

    for (const canvas of inner.querySelectorAll<HTMLCanvasElement>('[data-map]')) {
      const room = this.rooms.find((r) => r.id === canvas.dataset.map);
      if (room) this.drawMinimap(canvas, room);
    }
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

    ctx.fillStyle = '#101216';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#2a2d33';
    ctx.fillRect(offsetX, offsetY, room.width * scale, room.height * scale);

    ctx.fillStyle = '#767c86';
    for (const block of room.blocks) {
      ctx.fillRect(
        offsetX + block.x * scale,
        offsetY + block.y * scale,
        Math.max(1, block.w * scale),
        Math.max(1, block.h * scale),
      );
    }
    // Spawn markers, so the shape of a run is readable before playing it.
    ctx.fillStyle = '#a8372a';
    for (const spot of room.spawns.zombies) {
      ctx.fillRect(offsetX + spot.x * scale - 1, offsetY + spot.y * scale - 1, 3, 3);
    }
    ctx.fillStyle = '#4fa9d8';
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
          <div class="t">${character.name}</div>
          <div class="d">cosmetic only &mdash; same stats</div>
        </button>`,
    ).join('');

    const inner = this.shell(`
      <button class="back">&larr; back</button>
      <h2>Choose a character</h2>
      <div class="grid">${cards}</div>
    `);
    this.backButton(inner, 'title');

    for (const canvas of inner.querySelectorAll<HTMLCanvasElement>('[data-portrait]')) {
      const id = canvas.dataset.portrait!;
      this.drawPortrait(canvas, id);
    }
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
    ctx.fillStyle = '#101216';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const clips = new ClipIndex(this.pack.clips);
    const character = CHARACTERS.find((c) => c.id === characterId);
    const base = clips.get('Player', 'Stand');
    if (!base) return;

    // Three-quarter view, which shows the face and the held weapon.
    const direction = Math.round(base.directions * 0.1) % base.directions;
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
    drawComposed(ctx, composed.parts, {
      scale: 1.5,
      art: { textures: this.pack.textures, swap },
    });
    ctx.restore();
  }

  // ---- instructions and options ------------------------------------------

  private renderInstructions(): void {
    const inner = this.shell(`
      <button class="back">&larr; back</button>
      <h2>How to play</h2>
      <dl class="keys">
        <dt>W A S D</dt><dd>move</dd>
        <dt>mouse</dt><dd>aim</dd>
        <dt>click / space</dt><dd>fire</dd>
        <dt>1 &ndash; 0</dt><dd>select weapon</dd>
        <dt>Q / E</dt><dd>cycle weapons</dd>
        <dt>P</dt><dd>pause</dd>
        <dt>R</dt><dd>restart the run</dd>
        <dt>M</dt><dd>mute</dd>
        <dt>Escape</dt><dd>menu</dd>
        <dt>F3</dt><dd>performance stats</dd>
      </dl>
      <h2>Surviving</h2>
      <dl class="keys">
        <dt>Levels</dt><dd>Clear a wave to level up. Each level grants new weapons
          and upgrades &mdash; the UZI at level 2, the shotgun at 3, and on from there.</dd>
        <dt>Ammo</dt><dd>Only the pistol is unlimited. Crates refill weapons you have
          already earned, so a gun you have not unlocked will never drop.</dd>
        <dt>Barrels</dt><dd>Shoot them to set off a chain. Place your own with key 4
          once unlocked, and lead zombies into them.</dd>
        <dt>Barricades</dt><dd>Fake walls (key 6) buy time. Zombies chew through them
          when going around would take too long, so leave an opening.</dd>
        <dt>Score</dt><dd>Kills close together multiply. Keep the streak going for a
          higher multiplier &mdash; it decays if you stop.</dd>
      </dl>
    `);
    this.backButton(inner, 'title');
  }

  private renderOptions(): void {
    const inner = this.shell(`
      <button class="back">&larr; back</button>
      <h2>Options</h2>
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
        <div>arenas unlocked <b>${Math.min(this.save.unlockedRooms, this.rooms.length)}</b> / ${this.rooms.length}</div>
        <div>combined best <b>${this.save.totalBest.toLocaleString()}</b></div>
      </div>
      <button class="btn danger" id="reset">Reset scores and unlocks
        <span class="k">this cannot be undone</span></button>
    `);
    this.backButton(inner, 'title');

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

    inner.querySelector<HTMLButtonElement>('#reset')!.addEventListener('click', () => {
      // Destructive and one click away, so make it deliberate.
      if (!window.confirm('Erase every high score and re-lock all arenas?')) return;
      this.save.reset();
      this.renderOptions();
    });
  }

  // ---- debrief ------------------------------------------------------------

  private renderDebrief(result?: RunResult): void {
    if (!result) {
      this.show('title');
      return;
    }
    const record = this.save.recordFor(result.roomId);
    const inner = this.shell(`
      <div class="debrief">
        <h2>${result.roomName}</h2>
        <div class="sub" style="margin-bottom:6px">final score</div>
        <div class="big">${result.score.toLocaleString()}</div>
        <div class="best">${result.isBest ? 'new personal best' : `best ${record.score.toLocaleString()}`}</div>
        <div class="stats">
          <div>level reached <b>${result.level}</b></div>
          <div>kills <b>${result.kills}</b></div>
          ${result.unlockedNext ? '<div style="color:#7fd88a">new arena unlocked</div>' : ''}
        </div>
        <button class="btn primary" id="again">Play again
          <span class="k">${result.roomName}, same character</span></button>
        <button class="btn" data-go="rooms">Choose another arena</button>
        <button class="btn" data-go="title">Main menu</button>
      </div>
    `);
    inner.querySelector<HTMLButtonElement>('#again')!.addEventListener('click', () => {
      this.callbacks.onStart(result.roomId, this.selectedCharacter);
    });
    for (const button of inner.querySelectorAll<HTMLButtonElement>('[data-go]')) {
      button.addEventListener('click', () => this.show(button.dataset.go as Screen));
    }
  }
}
