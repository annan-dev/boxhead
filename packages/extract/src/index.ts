/**
 * boxhead-extract -- rebuilds the game's art and audio from a SWF.
 *
 * The output is written outside the repo's tracked tree (see .gitignore): the
 * assets are the original author's copyrighted work, so the pipeline runs from
 * your own copy of the file and nothing is ever committed.
 *
 *   npm run extract -- <path-to.swf> [--out DIR]
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  readSwf,
  spriteTags,
  parseExportAssets,
  TagCode,
  type SwfTag,
} from './swf/Reader.js';
import { decodeAvm1, type Avm1Object } from './swf/Avm1Decoder.js';
import { buildClip, validate, type ArtPack, type Clip } from './ModelBuilder.js';
import { decodeLossless } from './swf/BitmapDecoder.js';
import {
  bitmapsInFrame,
  bitmapsPerFrame,
  buildSprite,
  buildTexture,
  indexDefinitions,
} from './SpriteExtractor.js';
import { extractRooms } from './RoomExtractor.js';
import type { SpriteArt, Texture } from '@boxhead/shared';
import { encodePng } from './png.js';

const SOUND_FORMATS = ['uncompressed', 'adpcm', 'mp3', 'uncompressed-le', 'nellymoser16', 'nellymoser8', 'nellymoser', 'speex'];
const SOUND_RATES = [5512, 11025, 22050, 44100];

function parseArgs(argv: string[]): { swf: string; out: string } {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const outFlag = argv.indexOf('--out');
  const swf = positional[0];
  if (!swf) {
    process.stderr.write('usage: npm run extract -- <path-to.swf> [--out DIR]\n');
    process.exit(2);
  }
  const out = outFlag >= 0 ? argv[outFlag + 1] : undefined;
  // npm runs workspace scripts from the package directory, so resolve user
  // paths against wherever the command was actually typed.
  const base = process.env.INIT_CWD ?? process.cwd();
  return { swf: resolve(base, swf), out: resolve(base, out ?? 'assets') };
}

/** Depth-first walk over every tag, descending into sprites. */
function* allTags(tags: SwfTag[]): Generator<SwfTag> {
  for (const tag of tags) {
    yield tag;
    if (tag.code === TagCode.DefineSprite) yield* allTags(spriteTags(tag.body));
  }
}

function main(): void {
  const { swf: swfPath, out } = parseArgs(process.argv.slice(2));
  const file = readFileSync(swfPath);
  const sha256 = createHash('sha256').update(file).digest('hex');
  const swf = readSwf(file);

  process.stdout.write(`${basename(swfPath)}  SWF v${swf.version}  ${swf.frameRate}fps\n`);
  process.stdout.write(`sha256 ${sha256}\n\n`);

  const tags = [...allTags(swf.tags)];

  // Exported symbol names, used to name sounds and bitmaps.
  const exports = new Map<number, string>();
  for (const tag of tags) {
    if (tag.code === TagCode.ExportAssets) {
      for (const [id, name] of parseExportAssets(tag.body)) exports.set(id, name);
    }
  }

  // ---- models -------------------------------------------------------------
  // The art database is the single largest action block in the file.
  let artBlob: Buffer | null = null;
  for (const tag of tags) {
    if (tag.code === TagCode.DoAction && (!artBlob || tag.body.length > artBlob.length)) {
      artBlob = tag.body;
    }
  }
  if (!artBlob) throw new Error('no DoAction blocks found; is this the right SWF?');

  const decoded = decodeAvm1(artBlob);
  if (decoded.warnings.size > 0) {
    for (const [key, count] of decoded.warnings) {
      process.stdout.write(`  note: unhandled ${key} x${count}\n`);
    }
  }

  const clips: Clip[] = [];
  for (const item of decoded.pushed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const clip = buildClip(item as Avm1Object);
    if (clip) clips.push(clip);
  }

  // ---- face textures ------------------------------------------------------
  // Materials that name a MovieClip carry the printed detail (faces, jackets).
  // Resolve each one to flattened vector paths.
  const wanted = new Set<string>();
  for (const clip of clips) {
    for (const material of clip.materials) {
      if (material.clip) wanted.add(material.clip);
    }
  }
  // The generic faces above are placeholders the original recolours per
  // character. The real art ships as sibling symbols -- Swat_Body_Front,
  // Zombie_Skin_Color and so on -- so take those too.
  const SKIN_PATTERN = /^(Swat|Bond|GIJOE|Bambo|Zombie|Devil)_(Body|Head)_(Front|Back|Side|Top)$/;
  const COLOR_PATTERN = /^(Swat|Bond|GIJOE|Bambo|Zombie|Devil)_(Skin|Hair)_Color$/;
  for (const name of exports.values()) {
    if (SKIN_PATTERN.test(name) || COLOR_PATTERN.test(name)) wanted.add(name);
  }
  const defs = indexDefinitions(swf.tags);
  const idByName = new Map<string, number>();
  for (const [id, name] of exports) idByName.set(name, id);

  const textures: Record<string, Texture> = {};
  const missingTextures: string[] = [];
  for (const name of [...wanted].sort()) {
    const id = idByName.get(name);
    const texture = id === undefined ? null : buildTexture(name, id, defs);
    if (texture) textures[name] = texture;
    else missingTextures.push(name);
  }
  const layerCount = Object.values(textures).reduce((n, t) => n + t.layers.length, 0);
  const pathCount = Object.values(textures).reduce(
    (n, t) => n + t.layers.reduce((m, l) => m + l.paths.length, 0),
    0,
  );
  process.stdout.write(
    `textures ${Object.keys(textures).length}/${wanted.size} resolved, ` +
      `${layerCount} layers, ${pathCount} paths\n`,
  );
  if (missingTextures.length > 0) {
    process.stdout.write(`         unresolved: ${missingTextures.join(', ')}\n`);
  }

  // ---- world art ----------------------------------------------------------
  // Wall blocks, objects, pickups and effects are ordinary Flash symbols. The
  // wall pieces are three-faced boxes, which is where the original's chunky 3D
  // look comes from; several others are animated and keep every frame.
  // Screen_Debrief is the one menu screen worth keeping as vector art: its
  // grey skull and crossbones watermarks the end-of-run screen.
  const WORLD_PATTERN =
    /^(Piece\.|Object\.(Wall|Barrel|Mine|ChargePack|Pickup|LaserNode)$|Effect\.|Shot\.(Rocket|Grenade|ClusterShell|Devastator|DLaser)$|\w+\.MuzzleFlash$|Screen_Debrief$)/;
  const sprites: Record<string, SpriteArt> = {};
  const missingSprites: string[] = [];
  for (const [id, name] of exports) {
    if (!WORLD_PATTERN.test(name) || name.endsWith('.wav')) continue;
    const sprite = buildSprite(name, id, defs);
    if (sprite) sprites[name] = sprite;
    else missingSprites.push(name);
  }
  const spriteFrames = Object.values(sprites).reduce((n, s) => n + s.frames.length, 0);
  const spritePaths = Object.values(sprites).reduce(
    (n, s) => n + s.frames.reduce((m, f) => m + f.layers.reduce((k, l) => k + l.paths.length, 0), 0),
    0,
  );
  process.stdout.write(
    `world    ${Object.keys(sprites).length} symbols, ${spriteFrames} frames, ${spritePaths} paths
`,
  );
  if (missingSprites.length > 0) {
    process.stdout.write(`         unresolved: ${missingSprites.join(', ')}
`);
  }

  // ---- arenas -------------------------------------------------------------
  // The ROOM_Single_* symbols hold the real level layouts: block placements and
  // spawn markers, which beat any hand-authored approximation.
  const rooms = extractRooms(exports, defs);
  const totalBlocks = rooms.reduce((n, r) => n + r.blocks.length, 0);
  const totalSpawns = rooms.reduce(
    (n, r) => n + Object.values(r.spawns).reduce((m, list) => m + list.length, 0),
    0,
  );
  process.stdout.write(
    `rooms    ${rooms.length} arenas, ${totalBlocks} blocks, ${totalSpawns} spawn markers
`,
  );
  for (const room of rooms) {
    const solid = room.tiles.reduce((n, t) => n + t, 0);
    process.stdout.write(
      `         ${room.id}  ${String(room.width).padStart(4)}x${String(room.height).padStart(4)}px  ` +
        `${String(room.blocks.length).padStart(3)} blocks  ${String(solid).padStart(4)} solid cells  ` +
        `${room.spawns.zombies.length} zspawn ${room.spawns.players.length} pspawn
`,
    );
  }

  const pack: ArtPack = {
    version: 1,
    source: { file: basename(swfPath), sha256, frameRate: swf.frameRate },
    clips,
    textures,
    sprites,
    rooms,
  };

  const report = validate(pack);
  const { stats } = report;
  process.stdout.write(
    `models   ${stats.clips} clips, ${stats.poses} poses, ${stats.parts} parts, ` +
      `${stats.faces} faces, ${stats.vertices} vertices\n`,
  );
  if (!report.ok) {
    process.stdout.write('  VALIDATION PROBLEMS:\n');
    for (const problem of report.problems) process.stdout.write(`    - ${problem}\n`);
  }

  mkdirSync(out, { recursive: true });
  mkdirSync(join(out, 'bitmaps'), { recursive: true });
  mkdirSync(join(out, 'sounds'), { recursive: true });

  const artJson = JSON.stringify(pack);
  writeFileSync(join(out, 'art.json'), artJson);
  process.stdout.write(`         art.json ${(artJson.length / 1024 / 1024).toFixed(2)} MB\n\n`);

  // ---- bitmaps ------------------------------------------------------------
  let bitmapCount = 0;
  const bitmapIndex: Array<{ id: number; name: string; width: number; height: number }> = [];
  /** Written file per bitmap id, for the screen-art manifest below. */
  const bitmapFiles = new Map<number, string>();
  for (const tag of tags) {
    const isLossless =
      tag.code === TagCode.DefineBitsLossless || tag.code === TagCode.DefineBitsLossless2;
    if (!isLossless) continue;
    const bitmap = decodeLossless(tag.body, tag.code === TagCode.DefineBitsLossless2);
    if (!bitmap) continue;
    const name = exports.get(bitmap.id) ?? `bitmap_${bitmap.id}`;
    const safe = name.replace(/[^A-Za-z0-9._-]/g, '_');
    writeFileSync(
      join(out, 'bitmaps', `${safe}.png`),
      encodePng(bitmap.width, bitmap.height, bitmap.rgba),
    );
    bitmapIndex.push({ id: bitmap.id, name, width: bitmap.width, height: bitmap.height });
    bitmapFiles.set(bitmap.id, `${safe}.png`);
    bitmapCount += 1;
  }
  // DefineBits images carry no tables of their own; they share a single
  // JPEGTables blob. Splice them: tables minus their trailing EOI, then the
  // image data minus its leading SOI.
  const tablesTag = tags.find((t) => t.code === 8 && t.body.length > 2);
  const tables = tablesTag ? tablesTag.body.subarray(0, -2) : null;
  for (const tag of tags) {
    if (tag.code !== TagCode.DefineBits || tag.body.length < 4) continue;
    const id = tag.body.readUInt16LE(0);
    const payload = tag.body.subarray(2);
    const jpeg = tables ? Buffer.concat([tables, payload.subarray(2)]) : payload;
    const name = exports.get(id) ?? `bitmap_${id}`;
    const file = `${name.replace(/[^A-Za-z0-9._-]/g, '_')}.jpg`;
    writeFileSync(join(out, 'bitmaps', file), jpeg);
    bitmapIndex.push({ id, name, width: 0, height: 0 });
    bitmapFiles.set(id, file);
    bitmapCount += 1;
  }

  writeFileSync(join(out, 'bitmaps', 'index.json'), JSON.stringify(bitmapIndex, null, 2));
  process.stdout.write(`bitmaps  ${bitmapCount} written\n`);

  // ---- screen art ---------------------------------------------------------
  // The menus' own pictures: the logo, one icon per arena (LevelIcons_Single
  // shows one frame per room, in room order) and the character portraits,
  // which are bitmaps placed on the select screen in character order.
  const screens: {
    logo: string | null;
    levelIcons: Record<string, string>;
    portraits: Record<string, string>;
  } = { logo: null, levelIcons: {}, portraits: {} };

  const logoId = idByName.get('Screen_Main');
  const logoBitmaps = logoId === undefined ? [] : bitmapsInFrame(logoId, defs);
  const logoFile = logoBitmaps.map((id) => bitmapFiles.get(id)).find((f) => f?.endsWith('.png'));
  screens.logo = logoFile ?? null;

  const iconsId = idByName.get('LevelIcons_Single');
  const iconsDef = iconsId === undefined ? undefined : defs.get(iconsId);
  if (iconsDef) {
    const frames = bitmapsPerFrame(iconsDef.body, defs);
    rooms.forEach((room, index) => {
      const file = frames[index]?.map((id) => bitmapFiles.get(id)).find((f) => f !== undefined);
      if (file) screens.levelIcons[room.id] = file;
    });
  }

  // Portraits are the 400x400 bitmaps, placed in the character-select order.
  const portraitIds = bitmapIndex
    .filter((b) => b.width === 400 && b.height === 400)
    .map((b) => b.id)
    .sort((a, b) => a - b);
  const CHARACTER_ORDER = ['swat', 'bond', 'gijoe', 'bambo'];
  portraitIds.forEach((id, index) => {
    const character = CHARACTER_ORDER[index];
    const file = bitmapFiles.get(id);
    if (character && file) screens.portraits[character] = file;
  });

  writeFileSync(join(out, 'bitmaps', 'screens.json'), JSON.stringify(screens, null, 2));
  process.stdout.write(
    `screens  logo ${screens.logo ?? 'none'}, ${Object.keys(screens.levelIcons).length} level icons, ` +
      `${Object.keys(screens.portraits).length} portraits\n`,
  );

  // ---- sounds -------------------------------------------------------------
  // Report formats first; only raw PCM can be written without a codec.
  const soundIndex: Array<Record<string, unknown>> = [];
  const formatTally = new Map<string, number>();
  for (const tag of tags) {
    if (tag.code !== TagCode.DefineSound || tag.body.length < 7) continue;
    const id = tag.body.readUInt16LE(0);
    const flags = tag.body[2]!;
    const format = SOUND_FORMATS[flags >> 4] ?? `unknown(${flags >> 4})`;
    const rate = SOUND_RATES[(flags >> 2) & 3] ?? 5512;
    const sixteenBit = ((flags >> 1) & 1) === 1;
    const stereo = (flags & 1) === 1;
    const sampleCount = tag.body.readUInt32LE(3);
    const name = exports.get(id) ?? `sound_${id}`;
    formatTally.set(format, (formatTally.get(format) ?? 0) + 1);
    soundIndex.push({
      id,
      name,
      format,
      rate,
      bits: sixteenBit ? 16 : 8,
      channels: stereo ? 2 : 1,
      sampleCount,
      bytes: tag.body.length - 7,
    });
    const safeName = name.replace(/[^A-Za-z0-9._-]/g, '_').replace(/_wav$|\.wav$/i, '');
    if (format === 'mp3') {
      // MP3 payloads open with a 2-byte seekSamples field before the frames;
      // dropping it yields a file decodeAudioData() accepts directly.
      writeFileSync(join(out, 'sounds', `${safeName}.mp3`), tag.body.subarray(9));
    } else {
      writeFileSync(join(out, 'sounds', `${safeName}.${format}.bin`), tag.body.subarray(7));
    }
  }
  writeFileSync(join(out, 'sounds', 'index.json'), JSON.stringify(soundIndex, null, 2));
  const tally = [...formatTally].map(([f, c]) => `${c} ${f}`).join(', ');
  process.stdout.write(`sounds   ${soundIndex.length} written (${tally || 'none'})\n`);

  process.stdout.write(`\nwrote to ${out}\n`);
  if (!report.ok) process.exitCode = 1;
}

main();
