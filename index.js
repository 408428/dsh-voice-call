/**
 * Host half of the voice-call bundle.
 *
 * The browser half owns capture, playback, and the call UI. This half owns
 * everything that needs a child process or a credential, behind two routes
 * under `/.dsh-voice-call`:
 *
 * - `POST /tts` speaks a reply. The **local** Piper voice is tried first and
 *   answers in tens of milliseconds from a resident process; the Bailian cloud
 *   voice is the fallback when the local engine is not installed.
 * - `POST /asr` recognizes a recording, through the Bailian `bl` CLI.
 *
 * The local voice is what makes a call feel like a call: a cloud round trip
 * costs seconds, and a conversation cannot afford that on every turn.
 *
 * @module dsh-voice-call
 */

import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name; the Loader row id in `cordis.patch.yml` matches it. */
export const name = 'voice-call'

/**
 * The Web route registry and the child-process service.
 *
 * `speechToText` is read with `ctx.get` rather than injected, because a profile
 * without the voice-input bundle must still load this plugin and fall back to
 * the cloud recognizer.
 */
export const inject = ['webServer', 'subprocess']

/** Absolute directory of this plugin, used to locate its bundled worker script. */
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))

/**
 * Deployment-varying speech choices.
 *
 * Declaring the schema is also what gives the Plugin Manager its config form.
 */
export const Config = z.object({
  /** Prefer the local Piper voice; the cloud voice is used only when it is unavailable. */
  localTts: z.boolean().default(true),
  /** Absolute Piper `.onnx` voice model; empty selects the default under the Harness home. */
  localTtsModel: z.string().default(''),
  /** Python interpreter that has `piper-tts` installed; empty selects the default under the Harness home. */
  localTtsPython: z.string().default(''),
  /** Bailian text-to-speech model id, used when the local voice is unavailable. */
  ttsModel: z.string().min(1).default('cosyvoice-v3-flash'),
  /** Bailian system voice id for `ttsModel`. */
  ttsVoice: z.string().min(1).default('longwan_v3'),
  /** Prefer the Harness's local SenseVoice recognizer; the cloud CLI is the fallback. */
  localAsr: z.boolean().default(true),
  /** Registered speech provider id; empty selects the deployment default (SenseVoice). */
  asrProvider: z.string().default(''),
  /** Bailian speech-recognition model id, used when no local recognizer is available. */
  asrModel: z.string().min(1).default('qwen3-asr-flash'),
  /** Language hint sent to both directions. */
  language: z.string().min(1).default('zh'),
  /** Spoken replies are truncated to this many characters before synthesis. */
  maxReplyChars: z.natural().min(1).default(300),
  /** Largest accepted recording body, in bytes. */
  maxAudioBytes: z.natural().min(46).default(4 * 1024 * 1024),
  /** Largest accepted synthesis request body, in bytes. */
  maxTextBytes: z.natural().min(1).default(16 * 1024),
  /** Wall-clock deadline for one cloud `bl` invocation. */
  commandTimeoutMs: z.natural().min(1).default(60_000),
  /** Wall-clock deadline for one local synthesis. */
  localTimeoutMs: z.natural().min(1).default(20_000),
  /** Simultaneous cloud `bl` invocations across both routes. */
  maxConcurrent: z.natural().min(1).default(2),
  /**
   * Probe model routes and rank the working ones by measured latency.
   *
   * This is what keeps a call off a broken route and on a local one: a route is
   * only chosen once it has answered a one-token request, and the quickest
   * answer wins, so a local server beats a cloud endpoint on its own merit.
   */
  probeRoute: z.boolean().default(true),
  /** Provider ids to probe, in preference order; empty probes every registered route. */
  preferredProviders: z.array(z.string()).default([]),
  /** Wall-clock deadline for one route probe. */
  probeTimeoutMs: z.natural().min(1).default(8_000),
  /** Models tried per provider before that provider is treated as unusable. */
  probeModelsPerProvider: z.natural().min(1).default(3),
  /** How long a discovered route is reused before probing again; 0 disables reuse. */
  routeTtlMs: z.natural().default(300_000),
  /**
   * Speaking-rate multiplier, 1.0 being the voice's own pace.
   *
   * A call is easier to follow at a slightly slower pace, and a fast reader
   * wants the opposite; both engines take the multiplier and invert it
   * internally as their own scale.
   */
  rate: z.number().default(1).volatile(),
  /** Directory holding selectable Piper voices; empty selects the default under the Harness home. */
  voiceDir: z.string().default(''),
  /** Directory holding uploaded reference recordings for cloning. */
  cloneDir: z.string().default(''),
  /** Directory holding characters; empty selects the default under the Harness home. */
  characterDir: z.string().default(''),
  /** The picture the 3D figure is built from; empty selects the default. */
  figureFile: z.string().default(''),

  /**
   * Whether the figure's mouth is animated from a photograph, using
   * LivePortrait. Off leaves the picture still.
   */
  portrait: z.boolean().default(false).volatile(),
  /** The Python that has LivePortrait's dependencies; empty selects the default. */
  portraitPython: z.string().default(''),
  /** The LivePortrait checkout, which supplies its `src` package and weights. */
  portraitRoot: z.string().default(''),
  /** How long one frame may take before it is abandoned. */
  portraitTimeoutMs: z.natural().min(1000).default(60_000),
  /**
   * What a call says first, when the active character has no line of its own.
   *
   * Volatile because it is edited from the settings page; a character's own line
   * still wins, since a character is a more specific instruction than the
   * deployment default.
   */
  opening: z.string().max(300).default('').volatile(),
  /**
   * The character a call is placed as; empty means no character is selected and
   * the voice settings above apply directly.
   */
  activeCharacter: z.string().default('').volatile(),
  /** Absolute path of the uploaded avatar image; empty selects the default under the Harness home. */
  avatarFile: z.string().default(''),
  /** Largest accepted avatar upload, in bytes. */
  maxAvatarBytes: z.natural().min(1).default(4 * 1024 * 1024),
  /**
   * Largest accepted clone recording, in bytes.
   *
   * Larger than {@link maxAudioBytes}, which carries browser recordings that are
   * always 16 kHz mono. A clone upload is whatever file the user has: 30 seconds
   * of stereo 44.1 kHz WAV is about 5 MB, so the smaller ceiling would refuse a
   * perfectly reasonable sample.
   */
  maxCloneBytes: z.natural().min(46).default(32 * 1024 * 1024),
  /**
   * Path of the ffmpeg binary used to convert an uploaded recording.
   *
   * A clone sample arrives in whatever format the user has. Converting here
   * accepts what they have instead of making them produce a specific one.
   */
  ffmpegPath: z.string().min(1).default('ffmpeg'),
  /**
   * Whether the cloud voice and recognizer may stand in when the local ones
   * cannot.
   *
   * Off makes a call strictly local: if the local engine is missing or fails,
   * the call reports it instead of quietly reaching a cloud API. That is the
   * setting for a deployment that must not send audio off the machine, where a
   * silent fallback would defeat the point.
   */
  cloudFallback: z.boolean().default(true).volatile(),
  /** Enable the local XTTS v2 cloning engine; requires its weights and a reference recording. */
  localClone: z.boolean().default(true),
  /**
   * Load the selected voice when the plugin starts, not on the first call.
   *
   * The clone engine needs about 75 seconds to load its weights, and paying that
   * while a caller waits for the first sentence is the difference between a call
   * that works and one that looks broken. Warming at startup moves that cost to
   * a moment when nobody is waiting. The work runs in the background, so it
   * never delays the Harness starting.
   */
  prewarm: z.boolean().default(true),
  /** Wall-clock deadline for one cloning synthesis, which is slower than Piper. */
  cloneTimeoutMs: z.natural().min(1).default(120_000),
  /**
   * The live voice selection, written by the settings page.
   *
   * These are `volatile` because Settings only accepts a write to a field
   * declared that way: the marker is what tells the config editor the value may
   * change without remounting the plugin. They are separate from the fields
   * above, which are the deployment's defaults rather than the user's choice.
   */
  localVoiceId: z.string().default('').volatile(),
  cloudVoice: z.string().default('longwan_v3').volatile(),
  cloneId: z.string().default('').volatile(),
})

/**
 * Read one configuration value, unwrapping a volatile box.
 *
 * A `volatile()` field is delivered as a box that is read with `get()` rather
 * than as the value itself, which is what lets the config editor replace it
 * without remounting the plugin. Plain fields arrive unwrapped, so both shapes
 * are accepted here and callers never have to know which kind a field is.
 *
 * @param value - the configured field.
 * @param fallback - value to use when the field is absent.
 * @returns the underlying value.
 */
function readConfig(value, fallback) {
  if (value === undefined || value === null) return fallback
  return typeof value.get === 'function' ? value.get() ?? fallback : value
}

/** Route prefix owned by this plugin. */
const ROUTE_PREFIX = '/.dsh-voice-call'

/**
 * System cloud voices offered by the default synthesis model.
 *
 * A fixed list rather than a live query: the settings page must draw its
 * selector without a network round trip, and the CLI's own listing takes
 * seconds. A voice that the deployment's model does not serve fails loudly at
 * synthesis time, which is the moment the mistake can actually be reported.
 */
const CLOUD_VOICES = [
  { id: 'longwan_v3', name: '龙婉 · 细腻柔声女' },
  { id: 'longyan_v3', name: '龙颜 · 温暖春风女' },
  { id: 'longxing_v3', name: '龙星 · 温婉邻家女' },
  { id: 'longxiaochun_v3', name: '龙小淳 · 知性积极女' },
  { id: 'longhua_v3', name: '龙华 · 元气甜美女' },
  { id: 'longanrou_v3', name: '龙安柔 · 温柔娴静女' },
  { id: 'longcheng_v3', name: '龙橙 · 智慧青年男' },
  { id: 'longze_v3', name: '龙泽 · 温暖元气男' },
  { id: 'longtian_v3', name: '龙天 · 磁性理智男' },
  { id: 'longfei_v3', name: '龙飞 · 热血磁性男' },
  { id: 'longhao_v3', name: '龙浩 · 多情忧郁男' },
  { id: 'longanyang', name: '龙安洋 · 阳光大男孩' },
]

/**
 * Apply the saved voice selection over the configured defaults.
 *
 * A failure here is not fatal: the config defaults are a working voice, so the
 * reason is logged and the call proceeds on them.
 *
 * @param ctx - plugin context carrying the settings service.
 * @param voice - the live selection to update in place.
 */
async function loadVoiceSettings(ctx, voice) {
  const settings = ctx.get('settings')
  const entry = ctx.fiber?.entry?.options?.id
  if (settings === undefined || entry === undefined) return
  try {
    // `describe` is synchronous and returns every active entry; `user` holds
    // only what was saved, so a field the user never set keeps its config
    // default instead of arriving as an empty placeholder.
    const row = settings.describe().find((entry_) => entry_.ns === entry)
    const saved = row?.user
    if (saved === null || typeof saved !== 'object') return
    // Clamped on read, because a value stored by an older version may sit
    // outside the range this one accepts, and a call must still start.
    if (typeof saved.rate === 'number') voice.rate = Math.min(2, Math.max(0.5, saved.rate))
    if (typeof saved.localVoiceId === 'string') voice.localVoiceId = saved.localVoiceId
    if (typeof saved.cloudVoice === 'string') voice.cloudVoice = saved.cloudVoice
    if (typeof saved.cloneId === 'string') voice.cloneId = saved.cloneId
    if (typeof saved.cloudFallback === 'boolean') voice.cloudFallback = saved.cloudFallback
    if (typeof saved.activeCharacter === 'string') character.id = saved.activeCharacter
  } catch (error) {
    ctx.logger.warn('voice-call could not read saved voice settings; using defaults', error)
  }
}

/**
 * Image types accepted as an avatar.
 *
 * A fixed set rather than sniffing the bytes: the type is echoed back as the
 * response's `content-type`, so an unchecked value would let an upload choose
 * how the browser interprets it.
 */
const AVATAR_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/**
 * Read the stored avatar, if any.
 *
 * The media type is kept beside the bytes rather than guessed, because the
 * response must echo the type the upload declared.
 *
 * @param config - validated plugin configuration.
 * @returns the image and its type, or undefined when none is set.
 */
async function readAvatarAt(path) {
  try {
    const bytes = await readFile(path)
    if (bytes.length === 0) return undefined
    // The type lives in a one-line sidecar; a missing or unreadable sidecar
    // falls back to PNG rather than failing, since the bytes are still valid.
    let type = 'image/png'
    try {
      const declared = (await readFile(`${path}.type`, 'utf8')).trim()
      if (AVATAR_TYPES.has(declared)) type = declared
    } catch { /* the default type stands */ }
    return { bytes, type }
  } catch {
    return undefined
  }
}

/**
 * Read the stored avatar, if any.
 *
 * @param config - validated plugin configuration.
 * @returns the image and its type, or undefined when none is set.
 */
async function readAvatar(config) {
  return await readAvatarAt(localPaths(config).avatar)
}

/**
 * Store one uploaded avatar.
 * @param ctx - plugin context, for the log line.
 * @param config - validated plugin configuration.
 * @param bytes - the image.
 * @param type - its declared media type.
 */
async function saveAvatar(ctx, config, bytes, type) {
  const path = localPaths(config).avatar
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, bytes)
  await writeFile(`${path}.type`, type, 'utf8')
  ctx.logger.info(`voice-call stored an avatar (${type}, ${bytes.length} bytes)`)
}

/**
 * Remove the stored avatar, so the call falls back to its generated one.
 * @param ctx - plugin context, for the log line.
 * @param config - validated plugin configuration.
 */
async function clearAvatar(ctx, config) {
  const path = localPaths(config).avatar
  await rm(path, { force: true })
  await rm(`${path}.type`, { force: true })
  ctx.logger.info('voice-call cleared the avatar')
}

/**
 * One character: a name, a personality, a voice, and a picture.
 *
 * A character is the unit a call is placed as. Keeping the four together in one
 * record is the point: choosing a character chooses how the agent behaves, how
 * it sounds, and what it looks like, in one action rather than three.
 *
 * @typedef {object} Character
 * @property {string} id - directory name, stable across renames.
 * @property {string} name - display name, and what the agent calls itself.
 * @property {string} personality - prose appended to the call instructions.
 * @property {object} voice - the voice selection, in the same shape as settings.
 * @property {boolean} hasAvatar - whether a picture is stored for this character.
 */

/** Directory holding every character. */
function charactersDir(config) {
  return config.characterDir || join(homeDir(), 'voice-call', 'characters')
}

/** Directory holding one character's files. */
function characterDir(config, id) {
  return join(charactersDir(config), id)
}

/**
 * Reject a character id that would escape the characters directory.
 *
 * Ids arrive from the browser, so they are checked rather than trusted: an id
 * like `../../etc` would otherwise name a directory outside the store.
 *
 * @param id - candidate id.
 * @returns the id.
 * @throws {RequestError} when it is not a plain identifier.
 */
function assertCharacterId(id) {
  if (typeof id !== 'string' || !/^char-[a-z0-9-]{1,64}$/.test(id)) {
    throw new RequestError('Unknown character', 404)
  }
  return id
}

/**
 * Reject a clone-voice id that would escape the clone directory.
 *
 * Ids arrive from the browser and name a directory to remove, so they are
 * checked rather than trusted: `../../etc` would otherwise delete outside the
 * store.
 *
 * @param id - candidate id.
 * @returns the id.
 * @throws {RequestError} when it is not a plain identifier.
 */
function assertCloneId(id) {
  if (typeof id !== 'string' || !/^clone-[a-z0-9-]{1,64}$/.test(id)) {
    throw new RequestError('Unknown voice', 404)
  }
  return id
}

/**
 * Delete one cloned voice and its recording.
 *
 * @param ctx - plugin context, for the log line.
 * @param config - validated plugin configuration.
 * @param id - clone id.
 * @returns the id that was removed.
 */
async function deleteCloneVoice(ctx, config, id) {
  const home = join(localPaths(config).cloneDir, id)
  if (!await readable(join(home, 'sample.wav'))) throw new RequestError('Unknown voice', 404)
  await rm(home, { recursive: true, force: true })
  ctx.logger.info(`voice-call deleted cloned voice ${id}`)
  return id
}

/**
 * Read one character, or undefined when it does not exist.
 * @param config - validated plugin configuration.
 * @param id - character id.
 * @returns the character, with its voice selection and avatar presence.
 */
async function readCharacter(config, id) {
  try {
    const raw = JSON.parse(await readFile(join(characterDir(config, id), 'character.json'), 'utf8'))
    return {
      id,
      name: typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : id,
      personality: typeof raw.personality === 'string' ? raw.personality : '',
      // What this character says first when a call is answered. Empty means the
      // call waits for the user, which is the old behaviour.
      opening: typeof raw.opening === 'string' ? raw.opening.slice(0, 300) : '',
      voice: {
        // Which engine the character chose. Stored explicitly because "no local
        // voice named" is not the same as "the cloud was chosen": the first
        // means use the deployment default, the second means use the cloud.
        engine: ['local', 'clone', 'cloud'].includes(raw.voice?.engine) ? raw.voice.engine : '',
        localVoiceId: typeof raw.voice?.localVoiceId === 'string' ? raw.voice.localVoiceId : '',
        cloudVoice: typeof raw.voice?.cloudVoice === 'string' ? raw.voice.cloudVoice : '',
        cloneId: typeof raw.voice?.cloneId === 'string' ? raw.voice.cloneId : '',
        // Speaking rate for this character. `null` means follow the global
        // setting: a character need not have an opinion on pace, and an absent
        // rate is not the same as asking for 1.0.
        rate: typeof raw.voice?.rate === 'number' && raw.voice.rate >= 0.5 && raw.voice.rate <= 2
          ? raw.voice.rate : null,
      },
      hasAvatar: await readable(join(characterDir(config, id), 'avatar.img')),
      at: typeof raw.at === 'string' ? raw.at : '',
    }
  } catch {
    return undefined
  }
}

/**
 * Every stored character, newest last.
 * @param config - validated plugin configuration.
 * @returns the characters, sorted by creation time then id.
 */
async function listCharacters(config) {
  let entries
  try {
    entries = await readdir(charactersDir(config), { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const character = await readCharacter(config, entry.name)
    if (character !== undefined) found.push(character)
  }
  return found.sort((left, right) => (left.at === right.at ? left.id.localeCompare(right.id) : left.at.localeCompare(right.at)))
}

/**
 * Create one character.
 * @param ctx - plugin context, for the log line.
 * @param config - validated plugin configuration.
 * @param name - display name.
 * @param personality - instructions for how the character behaves.
 * @param voice - the voice selection to start from.
 * @returns the created character.
 */
async function createCharacter(ctx, config, name, personality, voice, opening) {
  const id = `char-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const home = characterDir(config, id)
  await mkdir(home, { recursive: true })
  const label = name.trim() === '' ? '新角色' : name.trim().slice(0, 40)
  const record = {
    name: label,
    personality: personality.slice(0, 4000),
    opening: typeof opening === 'string' ? opening.slice(0, 300) : '',
    voice: {
      engine: ['local', 'clone', 'cloud'].includes(voice?.engine) ? voice.engine : '',
      localVoiceId: voice?.localVoiceId ?? '',
      cloudVoice: voice?.cloudVoice ?? '',
      cloneId: voice?.cloneId ?? '',
      rate: typeof voice?.rate === 'number' && voice.rate >= 0.5 && voice.rate <= 2 ? voice.rate : null,
    },
    at: new Date().toISOString(),
  }
  await writeFile(join(home, 'character.json'), JSON.stringify(record, null, 2), 'utf8')
  ctx.logger.info(`voice-call created character "${label}" (${id})`)
  return await readCharacter(config, id)
}

/**
 * Update one character in place, leaving unnamed fields as they were.
 * @param ctx - plugin context, for the log line.
 * @param config - validated plugin configuration.
 * @param id - character id.
 * @param patch - fields to change.
 * @returns the updated character.
 */
async function updateCharacter(ctx, config, id, patch) {
  const current = await readCharacter(config, id)
  if (current === undefined) throw new RequestError('Unknown character', 404)
  const record = {
    name: typeof patch.name === 'string' && patch.name.trim() !== '' ? patch.name.trim().slice(0, 40) : current.name,
    personality: typeof patch.personality === 'string' ? patch.personality.slice(0, 4000) : current.personality,
    opening: typeof patch.opening === 'string' ? patch.opening.slice(0, 300) : current.opening,
    voice: {
      engine: ['local', 'clone', 'cloud'].includes(patch.voice?.engine) ? patch.voice.engine : current.voice.engine,
      localVoiceId: typeof patch.voice?.localVoiceId === 'string' ? patch.voice.localVoiceId : current.voice.localVoiceId,
      cloudVoice: typeof patch.voice?.cloudVoice === 'string' ? patch.voice.cloudVoice : current.voice.cloudVoice,
      cloneId: typeof patch.voice?.cloneId === 'string' ? patch.voice.cloneId : current.voice.cloneId,
      // `null` is a value here, not an omission: it is how the editor says
      // "follow the global setting", which differs from leaving the field out.
      rate: patch.voice?.rate === null ? null
        : typeof patch.voice?.rate === 'number' && patch.voice.rate >= 0.5 && patch.voice.rate <= 2 ? patch.voice.rate
          : current.voice.rate,
    },
    at: current.at,
  }
  await writeFile(join(characterDir(config, id), 'character.json'), JSON.stringify(record, null, 2), 'utf8')
  ctx.logger.info(`voice-call updated character "${record.name}" (${id})`)
  return await readCharacter(config, id)
}

/**
 * Delete one character and everything it owns.
 * @param ctx - plugin context, for the log line.
 * @param config - validated plugin configuration.
 * @param id - character id.
 */
async function deleteCharacter(ctx, config, id) {
  await rm(characterDir(config, id), { recursive: true, force: true })
  ctx.logger.info(`voice-call deleted character ${id}`)
}

/**
 * Read the picture the 3D figure should be built from.
 *
 * The figure has its own picture because it wants a different crop from the
 * avatar. When none is set the avatar stands in, so an existing setup keeps
 * working and a user who only ever uploads one picture gets a figure anyway.
 *
 * @param config - validated plugin configuration.
 * @returns the image and its type, plus whether it came from the figure slot.
 */
async function readFigure(config) {
  const own = await readAvatarAt(localPaths(config).figure)
  if (own !== undefined) return { ...own, fromFigure: true }
  const fallback = await readAvatar(config)
  return fallback === undefined ? undefined : { ...fallback, fromFigure: false }
}

/**
 * Store one character's picture.
 * @param config - validated plugin configuration.
 * @param id - character id.
 * @param bytes - the image.
 * @param type - its declared media type.
 */
async function saveCharacterAvatar(config, id, bytes, type) {
  const home = characterDir(config, id)
  await mkdir(home, { recursive: true })
  await writeFile(join(home, 'avatar.img'), bytes)
  await writeFile(join(home, 'avatar.type'), type, 'utf8')
}

/**
 * Read one character's picture.
 * @param config - validated plugin configuration.
 * @param id - character id.
 * @returns the image and its type, or undefined when none is stored.
 */
async function readCharacterAvatar(config, id) {
  return await readAvatarAt(join(characterDir(config, id), 'avatar.img'))
}

/**
 * Wait until this plugin's saved settings can be read, then apply them.
 *
 * Settings lists only ACTIVE fibers, so during `apply` the plugin's own entry is
 * absent and the saved selection is invisible. Rather than guess when activation
 * finishes, this polls briefly for the entry to appear: the read is cheap, the
 * window is short, and success is unambiguous. A deployment with no settings
 * service, or an entry that never appears, resolves immediately so the caller
 * falls back to the configured defaults.
 *
 * @param ctx - plugin context carrying the settings service.
 * @param voice - the live selection to update in place.
 * @param signal - caller lifetime; polling stops when aborted.
 */
async function waitForSettings(ctx, voice, signal) {
  const settings = ctx.get('settings')
  const entry = ctx.fiber?.entry?.options?.id
  if (settings === undefined || entry === undefined) return
  for (let attempt = 0; attempt < 40 && !signal.aborted; attempt += 1) {
    try {
      const row = settings.describe().find((candidate) => candidate.ns === entry)
      if (row !== undefined) {
        await loadVoiceSettings(ctx, voice)
        return
      }
    } catch { /* the service may not be ready yet; the next attempt retries */ }
    await new Promise((settle) => setTimeout(settle, 250))
  }
}

/**
 * Write the voice selection into this plugin's profile entry.
 *
 * Persisting through Settings is what makes a choice outlive the process: the
 * routes hold it live, and the profile entry is what a restart reads back.
 * A deployment mounted without the Loader has no entry, and the selection then
 * lives only as long as the process -- worth a log line, not a failure.
 *
 * @param ctx - plugin context carrying the settings service.
 * @param voice - the selection to persist.
 */
async function persistVoice(ctx, voice, character) {
  const settings = ctx.get('settings')
  const entry = ctx.fiber?.entry?.options?.id
  if (settings === undefined || entry === undefined) {
    ctx.logger.warn('voice-call voice settings cannot be persisted without the settings service')
    return
  }
  await settings.update(entry, {
    rate: voice.rate,
    localVoiceId: voice.localVoiceId,
    cloudVoice: voice.cloudVoice,
    cloneId: voice.cloneId,
    cloudFallback: voice.cloudFallback,
    // Which character calls are placed as. Written with the voice because the
    // two are one decision: activating a character changes the voice too.
    ...character === undefined ? {} : { activeCharacter: character.id },
  })
}

/**
 * Persist the figure switches.
 *
 * Separate from `persistVoice` because these describe how the figure is drawn,
 * not which voice it uses; folding them into the voice write would make an
 * unrelated change rewrite the selection.
 *
 * @param ctx - plugin context carrying the settings service.
 * @param patch - the switch values to store.
 */
async function persistSwitches(ctx, patch) {
  const settings = ctx.get('settings')
  const entry = ctx.fiber?.entry?.options?.id
  if (settings === undefined || entry === undefined) return
  await settings.update(entry, patch)
}

/**
 * Store one uploaded recording as a cloneable voice.
 *
 * The sample is normalized to the 16 kHz mono PCM16 WAV the rest of the plugin
 * already validates, and saved under a directory named by the id, because that
 * directory is what `listCloneVoices` reads back.
 *
 * @param ctx - plugin context, for the log line.
 * @param config - validated plugin configuration.
 * @param audio - uploaded WAV bytes.
 * @param name - display name the user gave, possibly empty.
 * @returns the created voice entry.
 */
async function saveClone(ctx, config, canonical, name) {
  const seconds = canonical.length / 32000
  const dir = localPaths(config).cloneDir
  // A time-ordered id keeps clones distinguishable without asking the user to
  // invent a unique one, and sorting by it shows newest last. Milliseconds and a
  // random suffix are both needed: second precision collided for two uploads in
  // the same second, and one silently overwrote the other, so a test that
  // created two voices ended up with one.
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17)
  const suffix = Math.random().toString(36).slice(2, 6)
  const id = `clone-${stamp}-${suffix}`
  const home = join(dir, id)
  // The parent is created first, then the voice directory without `recursive`,
  // so a collision fails loudly instead of merging two voices into one.
  await mkdir(dir, { recursive: true })
  await mkdir(home, { recursive: false })
  await writeFile(join(home, 'sample.wav'), canonical)
  const label = name.trim() === '' ? id : name.trim().slice(0, 40)
  await writeFile(join(home, 'voice.json'), JSON.stringify({ name: label, at: new Date().toISOString(), seconds: Math.round(seconds * 10) / 10 }), 'utf8')
  ctx.logger.info(`voice-call stored clone voice "${label}" (${id}, ${seconds.toFixed(1)}s)`)
  return { id, name: label, engine: 'clone', seconds: Math.round(seconds * 10) / 10 }
}

/**
 * Run one external command and collect its output.
 *
 * Separate from {@link runCli} because that one is pinned to `bl`: this runs
 * whatever the caller names, which is what a conversion needs.
 *
 * @param ctx - plugin context owning the subprocess service.
 * @param argv - command and arguments.
 * @param cwd - working directory.
 * @param config - validated plugin config.
 * @returns exit code and both streams.
 */
async function runCommand(ctx, argv, cwd, config) {
  const signal = AbortSignal.timeout(config.commandTimeoutMs)
  const handle = ctx.subprocess.spawn({
    argv,
    cwd,
    graceMs: 1000,
    signal,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 1024 * 1024 },
      stderr: { maxBytes: 256 * 1024 },
    },
  })
  let outcome
  try {
    outcome = await handle.done
  } catch (error) {
    handle.terminate()
    await handle.waitForExit().catch(() => undefined)
    throw error
  }
  const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
  const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
  return { code: outcome.exitCode, stdout, stderr }
}

/**
 * Turn any uploaded audio into the canonical 16 kHz mono PCM16 WAV.
 *
 * A recording is whatever the user happens to have: an MP3, an M4A from a
 * phone, a WebM from the browser, or a WAV at some other rate. Rejecting those
 * puts the conversion on the user, who has no reason to know what the engine
 * wants; running ffmpeg here accepts what they have instead.
 *
 * A file that is ALREADY canonical is returned untouched, so the common case
 * costs no subprocess at all.
 *
 * @param ctx - plugin context owning the subprocess service.
 * @param config - validated plugin config.
 * @param audio - uploaded bytes.
 * @param work - per-request temp directory.
 * @returns the canonical WAV, and whether a conversion happened.
 * @throws {RequestError} when the bytes are not decodable audio.
 */
async function toCanonicalWave(ctx, config, audio, work) {
  // Fast path: already the exact shape, so no subprocess is needed.
  try {
    return { bytes: canonicalizeWave(audio), converted: false }
  } catch { /* not canonical; fall through to ffmpeg */ }
  const input = join(work, 'upload')
  const output = join(work, 'converted.wav')
  await writeFile(input, audio)
  let result
  try {
    result = await runCommand(ctx, [
      config.ffmpegPath, '-hide_banner', '-nostdin', '-y',
      '-i', input,
      // Audio only: an M4A or MP4 also carries a video track, and keeping it
      // would make ffmpeg's output a container the engine cannot read.
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-c:a', 'pcm_s16le',
      '-f', 'wav',
      output,
    ], work, config)
  } catch (error) {
    throw new RequestError(`Audio could not be converted (ffmpeg unavailable: ${error instanceof Error ? error.message : String(error)})`, 503)
  }
  if (result.code !== 0) {
    // ffmpeg's wording is aimed at a developer reading a terminal ("Error
    // opening input files: Invalid data found when processing input"), so the
    // common case gets a plain sentence and anything else keeps ffmpeg's own
    // last line, which is what identifies an unusual failure.
    const lines = result.stderr.trim().split('\n').filter((line) => line.trim() !== '')
    const detail = lines[lines.length - 1] ?? ''
    const unreadable = /Invalid data found|could not find codec|moov atom not found|No such file/i.test(detail)
    throw new RequestError(unreadable
      ? 'That file is not audio this machine can read. Try an MP3, M4A, WAV, OGG, or FLAC recording.'
      : `Audio could not be converted: ${detail || `ffmpeg exited with ${String(result.code)}`}`, 400)
  }
  const converted = await readFile(output)
  if (converted.length <= 44) throw new RequestError('The recording contained no audio', 400)
  // ffmpeg writes its own metadata chunk, so the output is canonicalized too.
  return { bytes: canonicalizeWave(converted), converted: true }
}

/**
 * Reject audio that is not a 16 kHz mono PCM16 WAV.
 *
 * The engines accept several shapes, but every consumer downstream (the
 * recognizer, the browser, the clone worker) is fed one, so the format is
 * checked once at the door rather than assumed. The check walks the chunk list
 * rather than a fixed layout, because a valid file may carry metadata chunks.
 *
 * @param audio - uploaded bytes.
 * @returns the recording's duration in seconds.
 */
function validateWave(audio) {
  return parseWave(audio).seconds
}

/**
 * Walk a WAV file's chunks and return its audio payload.
 *
 * The RIFF container allows any number of chunks between `fmt ` and `data`, and
 * real encoders use that room: ffmpeg writes a `LIST`/`INFO` metadata chunk by
 * default. Reading the file as a fixed header therefore rejects perfectly valid
 * recordings, which is what happened to the first uploaded sample -- 16 kHz mono
 * PCM16 throughout, refused because a metadata chunk sat where `data` was
 * expected. Walking the chunk list accepts what the format allows.
 *
 * @param audio - complete file bytes.
 * @returns the format fields, the audio payload, and its duration.
 * @throws {RequestError} when the file is not a readable 16 kHz mono PCM16 WAV.
 */
function parseWave(audio) {
  const bad = (why) => new RequestError(`Audio must be a 16 kHz mono PCM16 WAV recording (${why})`, 400)
  if (audio.length < 44) throw bad('too short')
  if (audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') {
    throw bad('not a RIFF/WAVE file')
  }
  let format
  let payload
  let offset = 12
  while (offset + 8 <= audio.length) {
    const id = audio.toString('ascii', offset, offset + 4)
    const declared = audio.readUInt32LE(offset + 4)
    const start = offset + 8
    // A streaming encoder may leave the size unfilled; the rest of the file is
    // then the chunk. Trusting a bogus size would either lose the audio or read
    // past the end, so it is clamped to what is actually there.
    const size = (declared === 0 || start + declared > audio.length) ? audio.length - start : declared
    if (id === 'fmt ') {
      if (size < 16) throw bad('truncated fmt chunk')
      const tag = audio.readUInt16LE(start)
      const channels = audio.readUInt16LE(start + 2)
      const sampleRate = audio.readUInt32LE(start + 4)
      const bits = audio.readUInt16LE(start + 14)
      if (tag !== 1) throw bad('not uncompressed PCM')
      if (channels !== 1) throw bad(`${String(channels)} channels, expected mono`)
      if (sampleRate !== 16000) throw bad(`${String(sampleRate)} Hz, expected 16000 Hz`)
      if (bits !== 16) throw bad(`${String(bits)}-bit, expected 16-bit`)
      format = { channels, sampleRate, bits }
    } else if (id === 'data') {
      payload = audio.subarray(start, start + size)
      // `data` normally comes last, but the walk continues so a trailing chunk
      // cannot make the payload look truncated.
      break
    }
    // Chunks are word-aligned: an odd size is followed by a pad byte.
    offset = start + size + (size % 2)
  }
  if (format === undefined) throw bad('no fmt chunk')
  if (payload === undefined) throw bad('no data chunk')
  if (payload.length === 0) throw bad('no audio in the data chunk')
  if (payload.length % 2 !== 0) throw bad('truncated sample')
  return { ...format, payload, seconds: payload.length / (16000 * 2) }
}

/**
 * Rewrite one recording as a canonical 16 kHz mono PCM16 WAV.
 *
 * The Harness's own recognizer validates a strict layout -- `fmt ` and `data`
 * adjacent at fixed offsets -- so a file that is valid but carries metadata is
 * normalized here rather than rejected. This keeps every downstream consumer on
 * one shape and makes the stored sample reproducible.
 *
 * @param audio - complete file bytes.
 * @returns a canonical WAV with only the `fmt ` and `data` chunks.
 */
function canonicalizeWave(audio) {
  const { payload } = parseWave(audio)
  const out = Buffer.alloc(44 + payload.length)
  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(36 + payload.length, 4)
  out.write('WAVE', 8, 'ascii')
  out.write('fmt ', 12, 'ascii')
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(1, 22)
  out.writeUInt32LE(16000, 24)
  out.writeUInt32LE(32000, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36, 'ascii')
  out.writeUInt32LE(payload.length, 40)
  payload.copy(out, 44)
  return out
}

/** One admission gate shared by every cloud `bl` invocation. */
class Admission {
  /** @param limit - maximum simultaneous holders. */
  constructor(limit) {
    this.limit = limit
    this.running = 0
  }

  /**
   * Run one operation while holding a slot.
   * @param operation - the work to run.
   * @returns the operation result.
   * @throws when no slot is free; the caller maps it to a busy response.
   */
  async run(operation) {
    if (this.running >= this.limit) throw new BusyError()
    this.running += 1
    try {
      return await operation()
    } finally {
      this.running -= 1
    }
  }
}

/** Raised when every admission slot is held. */
class BusyError extends Error {
  constructor() {
    super('Too many speech requests are already running')
    this.name = 'BusyError'
  }
}

/** Raised when the request body is unusable. */
class RequestError extends Error {
  /**
   * @param message - caller-facing reason.
   * @param status - HTTP status the caller should answer with.
   */
  constructor(message, status) {
    super(message)
    this.name = 'RequestError'
    this.status = status
  }
}

/** Resolve the Harness home without importing the boot package. */
function homeDir() {
  return process.env.DSH_HOME ?? join(process.env.HOME ?? tmpdir(), '.dsh')
}

/**
 * Resolve the local engine's paths, honoring explicit configuration first.
 * @param config - validated plugin configuration.
 * @returns the interpreter, worker script, and voice model paths.
 */
function localPaths(config) {
  const root = join(homeDir(), 'voice-call')
  return {
    python: config.localTtsPython || join(root, 'venv', 'bin', 'python'),
    model: config.localTtsModel || join(root, 'models', 'zh_CN-huayan-medium.onnx'),
    voiceDir: config.voiceDir || join(root, 'models'),
    cloneDir: config.cloneDir || join(root, 'voices'),
    avatar: config.avatarFile || join(root, 'avatar.img'),
    // The picture the 3D figure is built from, kept apart from the avatar: the
    // avatar is a small round thumbnail, the figure wants a face-filling crop,
    // and forcing one image to be both is why they could not be chosen apart.
    figure: config.figureFile || join(root, 'figure.img'),

    worker: join(PLUGIN_DIR, 'piper_worker.py'),
    cloneWorker: join(PLUGIN_DIR, 'xtts_worker.py'),
    // The mouth animator, the LivePortrait checkout it imports, and the
    // interpreter that has its dependencies. That interpreter is separate
    // because LivePortrait pins numpy 1.x and the speech stack needs 2.x.
    portraitWorker: join(PLUGIN_DIR, 'lp_worker.py'),
    portraitRoot: config.portraitRoot || join(root, 'liveportrait'),
    portraitPython: config.portraitPython || join(root, 'lp-venv', 'bin', 'python'),
  }
}

/**
 * Every selectable Piper voice on disk.
 *
 * A voice is an `.onnx` file beside its `.onnx.json` config; the pair is what
 * `PiperVoice.load` needs, so a lone `.onnx` is not offered.
 * @param config - validated plugin configuration.
 * @returns selectable voices, sorted by id.
 */
async function listLocalVoices(config) {
  const dir = localPaths(config).voiceDir
  let names
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const onnx = names.filter((name) => name.endsWith('.onnx'))
  const found = []
  for (const name of onnx) {
    const id = name.slice(0, -'.onnx'.length)
    if (!names.includes(`${id}.onnx.json`)) continue
    found.push({ id, name: id, path: join(dir, name), engine: 'piper' })
  }
  return found.sort((left, right) => left.id.localeCompare(right.id))
}

/**
 * Every cloned voice with a reference recording on disk.
 *
 * A clone is a directory holding the reference audio, because the recording is
 * what the engine needs at startup; the directory name is the voice's identity.
 * @param config - validated plugin configuration.
 * @returns selectable cloned voices, sorted by id.
 */
async function listCloneVoices(config) {
  const dir = localPaths(config).cloneDir
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const sample = join(dir, entry.name, 'sample.wav')
    if (!await readable(sample)) continue
    let label = entry.name
    try {
      // The label the user gave is kept beside the sample; a missing or
      // unreadable one is not worth failing over, so the id stands in.
      const meta = JSON.parse(await readFile(join(dir, entry.name, 'voice.json'), 'utf8'))
      if (typeof meta?.name === 'string' && meta.name.trim() !== '') label = meta.name.trim()
    } catch { /* the id is the fallback label */ }
    found.push({ id: entry.name, name: label, path: sample, engine: 'clone' })
  }
  return found.sort((left, right) => left.id.localeCompare(right.id))
}

/** Whether a path exists and is readable. */
async function readable(path) {
  try {
    await access(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

/**
 * One long-lived local speech process.
 *
 * Loading a local voice is the expensive part -- about a second for Piper and
 * about seventy for the XTTS clone model -- while each sentence then costs
 * well under a second. The process therefore stays resident and serves many
 * utterances, and this class owns exactly one such engine: which worker script
 * to run, which arguments it takes, and how long one request may take.
 *
 * The protocol is identical for both engines, so the request path does not
 * branch on which one is running.
 */
class LocalEngine {
  /**
   * @param ctx - plugin context owning the subprocess service.
   * @param config - validated plugin configuration.
   * @param options - the engine to run.
   * @param options.worker - absolute path to the worker script.
   * @param options.args - fixed arguments the worker takes before its protocol starts.
   * @param options.timeoutMs - deadline for one synthesis.
   * @param options.require - additional paths that must be readable.
   */
  constructor(ctx, config, options) {
    this.ctx = ctx
    this.config = config
    this.options = options
    this.child = undefined
    this.pending = new Map()
    this.buffer = ''
    this.queue = Promise.resolve()
    this.nextId = 1
    this.unavailable = false
  }

  /**
   * Resolves when the process reports readiness, rejecting if it dies first.
   *
   * Built lazily so the promise is created once per process: `start()` may be
   * entered from several queued utterances, and all of them must wait on the
   * same load rather than each starting their own process.
   */
  get ready() {
    if (this.readyPromise === undefined) {
      this.readyPromise = new Promise((resolve, reject) => {
        this.readySettle = { resolve, reject }
      })
    }
    return this.readyPromise
  }

  /** Whether this engine's files are present; cached after the first check. */
  async available() {
    if (this.unavailable) return false
    if (this.checked === undefined) {
      const paths = localPaths(this.config)
      const needed = [paths.python, this.options.worker, ...this.options.require]
      const checks = await Promise.all(needed.map((path) => readable(path)))
      this.checked = checks.every(Boolean)
      if (!this.checked) this.unavailable = true
    }
    return this.checked
  }

  /** Start the resident process and wait for its readiness line. */
  async start() {
    if (this.child !== undefined) return this.child
    const paths = localPaths(this.config)
    // An engine may name its own interpreter: LivePortrait pins numpy 1.x, which
    // the speech stack cannot share, so the two cannot run in one environment.
    const python = this.options.python ?? paths.python
    const child = spawn(python, [this.options.worker, ...this.options.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { this.consume(chunk) })
    // Every failure is attributed to the process that caused it. A replaced
    // process exits AFTER its replacement has started, so an unattributed
    // handler would reject the new process's readiness gate and every later
    // utterance would fail -- which is exactly what switching voices did.
    const failed = (error) => {
      if (this.child !== child) return
      this.fail(error instanceof Error ? error : new Error(String(error)))
    }
    child.on('error', failed)
    child.on('exit', (code) => {
      if (this.child !== child) return
      this.child = undefined
      this.fail(new Error(`${this.options.label} exited with code ${String(code)}`))
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', () => { /* diagnostics only; the protocol carries the reason */ })
    await this.ready
    return child
  }

  /** Settle every waiting caller after the process ends. */
  fail(error) {
    const waiting = [...this.pending.values()]
    this.pending.clear()
    for (const settle of waiting) settle.reject(error)
    if (this.readySettle !== undefined) {
      this.readySettle.reject(error)
      this.readySettle = undefined
      this.readyPromise = undefined
    }
  }

  /** Split the process's stdout into protocol lines. */
  consume(chunk) {
    this.buffer += chunk
    let end = this.buffer.indexOf('\n')
    while (end >= 0) {
      const line = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 1)
      this.handle(line)
      end = this.buffer.indexOf('\n')
    }
  }

  /** Route one reply line to its caller, or resolve the readiness gate. */
  handle(line) {
    if (line.trim() === '') return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message.ready === true) {
      this.readySettle?.resolve()
      this.readySettle = undefined
      return
    }
    const settle = message.id === null || message.id === undefined ? undefined : this.pending.get(message.id)
    if (settle === undefined) {
      // A load-time failure arrives with no id; it fails the readiness gate.
      if (message.error !== undefined) this.fail(new Error(message.error))
      return
    }
    this.pending.delete(message.id)
    if (message.error !== undefined) {
      settle.reject(new Error(message.error))
      return
    }
    // A speech worker answers with `wav`; the portrait worker answers with a
    // JPEG. Resolving on the presence of `wav` keeps one reply path for both.
    settle.resolve(message.wav === undefined ? message : Buffer.from(message.wav, 'base64'))
  }

  /**
   * Speak one reply.
   * @param text - reply text.
   * @param options - per-request controls.
   * @param options.rate - speaking-rate multiplier.
   * @param options.speakerWav - reference recording, for an engine that clones.
   * @returns PCM16 WAV bytes.
   */
  async speak(text, options = {}) {
    return await this.request({
      text,
      rate: options.rate ?? 1,
      ...options.speakerWav === undefined ? {} : { speaker_wav: options.speakerWav },
    })
  }

  /**
   * Send one request to the worker and await its reply.
   *
   * Shared by every worker protocol, because they differ only in the fields they
   * carry: the id, the queueing, the timeout, and the failure handling are the
   * same for a sentence and for a mesh.
   *
   * @param body - the request fields, without the id.
   * @returns the reply, whose shape depends on the worker.
   */
  async request(body, timeoutMs) {
    const run = this.queue.then(async () => {
      const child = await this.start()
      const id = String(this.nextId++)
      const settled = Promise.withResolvers()
      this.pending.set(id, settled)
      const budget = timeoutMs ?? this.options.timeoutMs
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) settled.reject(new Error(`${this.options.label} timed out`))
      }, budget)
      child.stdin.write(`${JSON.stringify({ id, ...body })}\n`)
      try {
        return await settled.promise
      } finally {
        clearTimeout(timer)
      }
    })
    // Keep the chain alive after a failure so one bad request does not wedge
    // every later one behind a rejected promise.
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Point the engine at one model, restarting the process when it changes.
   *
   * One process loads one model, so switching voices means a fresh process and
   * paying the load again. That is why the current model is remembered and a
   * repeat request for the same voice costs nothing.
   *
   * @param args - the worker arguments identifying the model.
   */
  async use(args) {
    const key = args.join('\u0000')
    if (this.argsKey === key) return
    if (this.argsKey !== undefined) this.dispose()
    this.argsKey = key
    this.options.args = args
  }

  /** Stop the resident process. */
  dispose() {
    const child = this.child
    // Cleared first: the exit handler checks this field to decide whether the
    // exit belongs to the process the engine is currently using, and a disposed
    // process is by definition no longer that one.
    this.child = undefined
    // A restarted process needs its own readiness gate, so the old one is
    // cleared even when no process had started yet.
    this.readyPromise = undefined
    this.readySettle = undefined
    if (child === undefined) return
    // Reject only the utterances queued against THIS process; a replacement's
    // waiters are separate and must be left alone.
    this.fail(new Error(`${this.options.label} stopped`))
    child.kill()
  }
}

/**
 * Read a request body with an explicit byte ceiling.
 * @param req - incoming request.
 * @param limit - maximum accepted bytes.
 * @returns the complete body.
 * @throws {RequestError} when the body exceeds the ceiling.
 */
async function readBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new RequestError('Request body is too large', 413)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** Write one JSON response. */
function json(res, status, body, extra) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
    ...extra,
  })
  res.end(payload)
}

/**
 * Run one cloud `bl` invocation and collect its output.
 * @param ctx - plugin context owning the subprocess service.
 * @param argv - complete argument vector after the executable.
 * @param cwd - working directory; the temp workspace keeps `bl` relative paths contained.
 * @param config - validated plugin config.
 * @returns exit code and captured streams.
 */
async function runCli(ctx, argv, cwd, config) {
  const signal = AbortSignal.timeout(config.commandTimeoutMs)
  const handle = ctx.subprocess.spawn({
    argv: ['bl', ...argv],
    cwd,
    graceMs: 1000,
    signal,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 4 * 1024 * 1024 },
      stderr: { maxBytes: 256 * 1024 },
    },
  })
  let outcome
  try {
    outcome = await handle.done
  } catch (error) {
    handle.terminate()
    await handle.waitForExit().catch(() => undefined)
    throw error
  }
  const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
  const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
  return { code: outcome.exitCode, stdout, stderr }
}

/**
 * Synthesize one reply through the cloud voice.
 * @param ctx - plugin context.
 * @param text - reply text, already truncated by the caller.
 * @param work - per-request temp directory.
 * @param config - validated plugin config.
 * @returns MP3 bytes.
 */
async function synthesizeCloud(ctx, text, work, config, voice) {
  const textPath = join(work, 'reply.txt')
  const audioPath = join(work, 'reply.mp3')
  await writeFile(textPath, text, 'utf8')
  const rate = voice?.rate ?? readConfig(config.rate, 1)
  const result = await runCli(ctx, [
    'speech', 'synthesize',
    '--text-file', textPath,
    '--model', config.ttsModel,
    '--voice', voice?.cloudVoice || readConfig(config.cloudVoice, config.ttsVoice),
    '--format', 'mp3',
    '--language', config.language,
    // The CLI takes a rate directly, so no inversion is needed here: only the
    // local engines express pace as a scale rather than a multiplier.
    '--rate', String(rate),
    '--out', audioPath,
    '--quiet',
  ], work, config)
  if (result.code !== 0) {
    throw new Error(`Speech synthesis failed: ${result.stderr.trim() || `exit ${String(result.code)}`}`)
  }
  return await readFile(audioPath)
}

/**
 * Resolve which engine and model the current voice selection means.
 *
 * The selection is an id plus the engine it belongs to. An id that no longer
 * exists on disk falls back to the configured default, because a voice can be
 * deleted between calls and a call must still speak.
 *
 * @param ctx - plugin context, for the fallback log line.
 * @param config - validated plugin configuration.
 * @param voice - current voice selection.
 * @returns the engine to use and the path it should load.
 */
async function resolveVoice(ctx, config, voice) {
  // An explicit engine wins outright. Without this, a character that chooses the
  // cloud voice would still get a local one, because the local branch below
  // treats "no local voice named" as "use the default local voice" -- which is
  // the right default for the deployment and the wrong answer for a character
  // that has already decided.
  if (voice.engine === 'cloud') {
    const cloud = CLOUD_VOICES.find((entry) => entry.id === (voice.cloudVoice || config.ttsVoice))
    return { engine: 'cloud', path: '', label: cloud?.name ?? (voice.cloudVoice || config.ttsVoice) }
  }
  if (voice.engine === 'local' && voice.localVoiceId !== '') {
    const voices = await listLocalVoices(config)
    const hit = voices.find((entry) => entry.id === voice.localVoiceId || entry.path === voice.localVoiceId)
    if (hit !== undefined) return { engine: 'piper', path: hit.path, label: hit.name }
    ctx.logger.warn(`voice-call local voice "${voice.localVoiceId}" is missing; using the configured voice`)
  }
  if (voice.engine === 'clone' && voice.cloneId !== '') {
    const clones = await listCloneVoices(config)
    const hit = clones.find((entry) => entry.id === voice.cloneId)
    if (hit !== undefined) return { engine: 'clone', path: hit.path, label: hit.name }
    ctx.logger.warn(`voice-call clone voice "${voice.cloneId}" is missing; using the configured voice`)
  }
  if (voice.cloneId !== '') {
    const clones = await listCloneVoices(config)
    const hit = clones.find((entry) => entry.id === voice.cloneId)
    // The label is the name the user gave the voice, which is what the agent is
    // told it is called.
    if (hit !== undefined) return { engine: 'clone', path: hit.path, label: hit.name }
    ctx.logger.warn(`voice-call clone voice "${voice.cloneId}" is missing; using the local voice`)
  }
  if (config.localTts) {
    const voices = await listLocalVoices(config)
    const wanted = voice.localVoiceId !== '' ? voice.localVoiceId : config.localTtsModel
    const hit = voices.find((entry) => entry.id === wanted || entry.path === wanted)
      ?? voices.find((entry) => entry.id === 'zh_CN-huayan-medium')
      ?? voices[0]
    if (hit !== undefined) return { engine: 'piper', path: hit.path, label: hit.name }
  }
  const cloud = CLOUD_VOICES.find((entry) => entry.id === (voice.cloudVoice || config.ttsVoice))
  return { engine: 'cloud', path: '', label: cloud?.name ?? (voice.cloudVoice || config.ttsVoice) }
}

/**
 * Recognize one recording with the Harness's own speech service.
 *
 * The deployment already runs a local SenseVoice recognizer
 * (`dsh-experimental-speech-to-text-sensevoice`), which this reuses instead of
 * shipping audio to a cloud API. Measured on this machine for 3.5 s of speech:
 * about 0.13 s locally against 1.0–1.9 s through the cloud CLI, and the audio
 * never leaves the machine.
 *
 * @param ctx - plugin context carrying the speech registry.
 * @param audio - complete WAV bytes.
 * @param config - validated plugin config.
 * @returns the recognized text.
 */
async function recognizeLocal(ctx, audio, config) {
  const speech = ctx.get('speechToText')
  if (speech === undefined) throw new Error('No local speech recognizer is registered')
  const spec = speech.resolve({
    audio,
    ...(config.asrProvider === '' ? {} : { providerId: config.asrProvider }),
    language: config.language,
  })
  const transcript = await speech.transcribe(spec, AbortSignal.timeout(config.commandTimeoutMs))
  return transcript.text.trim()
}

/**
 * Recognize one recording through the cloud CLI.
 *
 * Kept as the fallback for a deployment whose local recognizer is absent, so a
 * call still transcribes rather than failing outright.
 *
 * @param ctx - plugin context.
 * @param audio - complete WAV bytes.
 * @param work - per-request temp directory.
 * @param config - validated plugin config.
 * @returns the recognized text.
 */
async function recognizeCloud(ctx, audio, work, config) {
  const audioPath = join(work, 'utterance.wav')
  await writeFile(audioPath, audio)
  const result = await runCli(ctx, [
    'speech', 'recognize',
    '--url', audioPath,
    '--model', config.asrModel,
    '--language', config.language,
    '--quiet',
  ], work, config)
  if (result.code !== 0) {
    throw new Error(`Speech recognition failed: ${result.stderr.trim() || `exit ${String(result.code)}`}`)
  }
  return result.stdout.trim()
}

/**
 * Recognize one recording, preferring the local recognizer.
 * @param ctx - plugin context.
 * @param audio - complete WAV bytes.
 * @param work - per-request temp directory.
 * @param config - validated plugin config.
 * @returns the recognized text and which engine produced it.
 */
async function recognize(ctx, audio, work, config, allowCloud) {
  const local = ctx.get('speechToText')
  if (config.localAsr && local !== undefined) {
    try {
      return { text: await recognizeLocal(ctx, audio, config), source: 'local' }
    } catch (error) {
      // A recognizer that cannot take this audio must not cost the call its
      // hearing; fall through to the cloud and keep the reason in the log.
      if (!allowCloud) {
        throw new Error(`Local recognition failed and cloud fallback is off: ${error instanceof Error ? error.message : String(error)}`)
      }
      ctx.logger.warn('voice-call local recognition failed; using the cloud recognizer', error)
    }
  } else if (!allowCloud) {
    // No local recognizer and no permission to reach the cloud: the call cannot
    // hear, and saying so is the honest answer.
    throw new RequestError('Local recognition is unavailable and cloud fallback is off', 503)
  }
  return { text: await recognizeCloud(ctx, audio, work, config), source: 'cloud' }
}

/**
 * Probe one provider and report the first model that answers.
 * @param llm - the `llm` service.
 * @param provider - provider route to probe.
 * @param local - whether this provider is a local endpoint.
 * @param config - validated plugin config.
 * @returns the winning route, or null when nothing on the provider answered.
 */
async function probeProvider(llm, provider, config) {
  let models
  try {
    models = await llm.listModels(provider.id)
  } catch {
    return null
  }
  for (const model of models.slice(0, config.probeModelsPerProvider)) {
    const started = Date.now()
    try {
      await probeOne(llm, provider.id, model.id, config)
      return { provider: provider.id, id: model.id, name: model.name ?? model.id, ms: Date.now() - started, local: isLocalProvider(provider.id) }
    } catch {
      // A model that cannot answer one token cannot answer a call.
    }
  }
  return null
}

/**
 * Rank the model routes that actually answer, best first.
 *
 * A call cannot afford to discover a dead route mid-conversation, and the
 * catalog says nothing about whether a route works: this deployment listed a
 * route that failed every request with `112/model_error`, and a name-matching
 * heuristic chose it. So candidates are asked one trivial question and timed.
 *
 * The deployment's OWN default route is probed first and, when it answers, is
 * what the call uses. The conversation belongs on the normal model — only
 * recognition and synthesis are local — so this probe exists to prove the
 * default WORKS, not to move the call onto a different model. Probing the rest
 * only matters when the default cannot answer, in which case the quickest
 * working route is the fallback.
 *
 * @param ctx - plugin context carrying the `llm` service.
 * @param config - validated plugin config.
 * @param preferred - the deployment default route, or null when unknown.
 * @returns the chosen routes, plus a promise of the remaining ranking when the
 *   default answered and the rest were left to settle in the background.
 */
async function probeRoutes(ctx, config, preferred) {
  const llm = ctx.get('llm')
  if (llm === undefined) return { routes: [], rest: null }
  const found = []
  // The default is awaited on its own, so a quick local route cannot win a race
  // against the model the deployment actually configured.
  if (preferred !== null) {
    const hit = await probeExact(llm, preferred.provider, preferred.model, config)
    if (hit !== null) {
      found.push(hit)
      const rest = probeRest(llm, config, preferred.provider).then(rankRoutes)
      return { routes: [hit], rest }
    }
  }
  const complete = await probeRest(llm, config, null)
  return { routes: rankRoutes(complete), rest: null }
}

/**
 * Probe every provider except one already settled.
 * @param llm - the `llm` service.
 * @param config - validated plugin config.
 * @param skip - provider id to leave out, or null.
 * @returns every route that answered.
 */
async function probeRest(llm, config, skip) {
  const providers = await llm.listProviders()
  const wanted = config.preferredProviders.length === 0
    ? providers
    : providers.filter((provider) => config.preferredProviders.includes(provider.id))
  const hits = await Promise.all(
    wanted.filter((provider) => provider.id !== skip).map((provider) => probeProvider(llm, provider, config)),
  )
  return hits.filter((hit) => hit !== null)
}

/**
 * Probe one exact route and time it.
 * @param llm - the `llm` service.
 * @param provider - provider route id.
 * @param model - model id.
 * @param config - validated plugin config.
 * @returns the route with its measured latency, or null when it did not answer.
 */
async function probeExact(llm, provider, model, config) {
  const started = Date.now()
  try {
    await probeOne(llm, provider, model, config)
  } catch {
    return null
  }
  return { provider, id: model, name: model, ms: Date.now() - started, local: isLocalProvider(provider) }
}

/**
 * Rank probed routes for a conversation.
 *
 * A call's CONVERSATION belongs on a normal served model — only recognition and
 * synthesis are local — so a remote route outranks a local one even when the
 * local one answered sooner. Latency orders routes within each kind. A local
 * route stays in the list last, because a call that can only reach a local model
 * is still better than one that cannot answer at all; the caller decides whether
 * to use it.
 *
 * @param found - routes that answered.
 * @returns the same routes, preferred first.
 */
function rankRoutes(found) {
  return [...found].sort((left, right) => (Number(left.local) - Number(right.local)) || (left.ms - right.ms))
}

/**
 * Whether a provider id names a local endpoint.
 *
 * The catalog does not report locality and no deployment flag marks it, so the
 * id is the available evidence: every local server on this machine is reachable
 * by loopback or is named for the runtime serving it. A misread only costs some
 * preference order, never correctness, because the ranking is still by measured
 * latency.
 *
 * @param id - provider route id.
 * @returns whether the route appears to be local.
 */
function isLocalProvider(id) {
  return /local|127\.0\.0\.1|localhost|linke|ollama|llama|vllm|lm-?studio/i.test(id)
}

/**
 * Ask one route for a single token, to prove it can actually answer.
 *
 * The answer token is required, not merely the absence of an error: a reasoning
 * model with thinking left on spends its whole budget on reasoning and never
 * emits spoken text, which is exactly the failure that makes such a route
 * unusable on a call. A route that finishes without one has not been proved.
 *
 * @param llm - the `llm` service.
 * @param provider - provider route id.
 * @param model - model id.
 * @param config - validated plugin config.
 * @returns after the route produced an answer token.
 */
async function probeOne(llm, provider, model, config) {
  const signal = AbortSignal.timeout(config.probeTimeoutMs)
  const call = await llm.prepareCall({ provider, model, maxTokens: 1 }, signal)
  let answered = false
  for await (const chunk of llm.stream({
    ...call.config,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    maxTokens: 1,
    signal,
  })) {
    if (chunk.type === 'text-delta') { answered = true; continue }
    if (chunk.type === 'finish') {
      if (chunk.reason.kind === 'error') throw new Error(chunk.reason.failure.message)
      if (chunk.reason.kind === 'aborted') throw new Error('probe aborted')
    }
  }
  if (!answered) throw new Error('the route produced no answer token')
}

/**
 * Register the speech routes, the shared admission gate, and the local voice.
 * @param ctx - plugin context carrying the Web route registry.
 * @param config - validated {@link Config}.
 */
export function apply(ctx, config) {
  const admission = new Admission(config.maxConcurrent)
  /**
   * The deployment's voice preferences, resolved once per call.
   *
   * These start from the plugin config and are replaced by whatever the
   * settings page last saved, so a change takes effect on the next call without
   * a restart. One object is shared by the routes, which is what keeps the
   * settings page and the speech path from disagreeing.
   */
  const voice = {
    rate: readConfig(config.rate, 1),
    localVoiceId: readConfig(config.localVoiceId, config.localTtsModel),
    cloudVoice: readConfig(config.cloudVoice, config.ttsVoice),
    cloneId: readConfig(config.cloneId, ''),
    /** Whether the cloud engines may stand in for a local failure. */
    cloudFallback: readConfig(config.cloudFallback, true),
    /**
     * The selected voice's display name, kept in sync for the prompt variable.
     *
     * Resolving the voice reads the filesystem, but a prompt variable must
     * answer synchronously, so the name is computed whenever the selection can
     * have changed and cached here.
     */
    label: '',
  }
  /**
   * The character a call is placed as, or null when none is selected.
   *
   * A character is a whole persona: it owns a voice, a picture, and the
   * instructions that shape how the agent behaves. When one is active its voice
   * wins over the settings above, because choosing a character is meant to
   * choose all three at once; the settings remain the fallback for a deployment
   * that uses no characters at all.
   */
  const character = { id: readConfig(config.activeCharacter, ''), record: null }
  /**
   * Load the active character's record, if one is selected.
   *
   * Re-read on every call rather than cached for the process: a character's
   * voice or picture can be edited between calls, and a stale record would make
   * the change appear to do nothing.
   */
  const refreshCharacter = async () => {
    if (character.id === '') { character.record = null; return }
    const record = await readCharacter(config, character.id)
    if (record === undefined) {
      // A deleted character must not leave the call pointing at nothing.
      ctx.logger.warn(`voice-call character "${character.id}" is missing; using the voice settings`)
      character.record = null
      return
    }
    character.record = record
  }
  /**
   * The voice a call should use, character first.
   *
   * @returns the effective selection, and whether a character supplied it.
   */
  const effectiveVoice = () => {
    if (character.record === null) return { ...voice, fromCharacter: false }
    const picked = character.record.voice
    return {
      ...voice,
      // The character's engine decides which branch `resolveVoice` takes. An
      // empty engine means the character named no voice, so the deployment's own
      // settings apply and the local-preference default stands.
      engine: picked.engine,
      // An empty field on the character falls through to the setting, so a
      // character that only names a clone still gets the configured cloud voice.
      localVoiceId: picked.localVoiceId !== '' ? picked.localVoiceId : voice.localVoiceId,
      cloudVoice: picked.cloudVoice !== '' ? picked.cloudVoice : voice.cloudVoice,
      cloneId: picked.cloneId !== '' ? picked.cloneId : voice.cloneId,
      // A character's pace wins while it is in use; null follows the setting.
      rate: picked.rate ?? voice.rate,
      fromCharacter: true,
    }
  }
  /**
   * Apply the saved selection once, on the first request that needs it.
   *
   * Not done during `apply`: `settings.describe()` lists only ACTIVE fibers, and
   * this plugin's own fiber is still activating while `apply` runs, so the read
   * would silently miss its own entry. Deferring to the first request also means
   * a deployment mounted without the Loader never pays for the read.
   */
  let voiceLoaded = false
  const ensureVoice = async () => {
    if (voiceLoaded) return
    voiceLoaded = true
    await loadVoiceSettings(ctx, voice)
  }
  /**
   * Read one volatile setting as it stands right now.
   *
   * `ensureVoice` is a one-shot, so a setting changed later would be invisible to
   * it. These few values are cheap, so they are asked for on every request
   * rather than cached with the voice selection.
   */
  const liveSetting = async (name, fallback) => {
    const settings = ctx.get('settings')
    const entry = ctx.fiber?.entry?.options?.id
    if (settings === undefined || entry === undefined) return readConfig(config[name], fallback)
    try {
      const described = settings.describe().find((item) => item.ns === entry)
      const value = described?.value?.[name]
      // The stored value decides its own type; a missing one falls through.
      if (value !== undefined && value !== null) return value
    } catch { /* fall through to the config default */ }
    return readConfig(config[name], fallback)
  }
  const piper = new LocalEngine(ctx, config, {
    label: 'local voice',
    worker: localPaths(config).worker,
    args: [],
    timeoutMs: config.localTimeoutMs,
    require: [],
  })
  const clone = new LocalEngine(ctx, config, {
    label: 'clone engine',
    worker: localPaths(config).cloneWorker,
    args: [],
    timeoutMs: config.cloneTimeoutMs,
    require: [],
  })
  /**
   * Which picture the portrait engine is currently loaded for.
   *
   * The engine holds the appearance feature and source keypoints for one face,
   * so it is only restarted when the picture changes.
   */
  const portraitCache = { key: '' }
  /**
   * The mouth animator, which turns the source picture into frames.
   *
   * Kept apart from the speech engines because it loads a different stack:
   * LivePortrait is a PyTorch pipeline with its own Python environment, and a
   * call that never shows a face must not pay for loading it.
   */
  const portrait = new LocalEngine(ctx, config, {
    label: 'portrait engine',
    worker: localPaths(config).portraitWorker,
    args: [localPaths(config).figure, localPaths(config).portraitRoot],
    python: localPaths(config).portraitPython,
    timeoutMs: config.portraitTimeoutMs,
    require: [],
  })
  ctx.effect(() => () => { piper.dispose(); clone.dispose(); portrait.dispose() }, 'voice-call local voices')
  /**
   * Cached route ranking. Probing costs a request per provider, so the answer is
   * held for `routeTtlMs` and shared by every call in between.
   */
  let routes = { at: 0, value: [], inflight: null, key: '' }
  /**
   * Publish the selected voice's name as a prompt variable.
   *
   * A preset's persona can then say `{{voice}}`, and the agent learns what it is
   * called from the deployment's own state rather than from a value someone has
   * to remember to update in the preset. Global variables reach every scope, so
   * registering here is enough for the call preset to interpolate it.
   *
   * The value is read from the cached label because a prompt variable must answer
   * synchronously, while resolving a voice reads the filesystem. An empty label
   * resolves to the generic word so a call is never told its voice is blank.
   */
  ctx.effect(() => {
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt === undefined) return () => {}
    const disposers = [
      systemPrompt.variable('voice', () => voice.label === '' ? '你的声音' : voice.label),
      // The character's own fields. A deployment with no character resolves to
      // a generic assistant rather than an empty name, so a persona that opens
      // with "You are {{character}}" still reads as a sentence. The personality
      // stays empty in that case, which drops to a blank line rather than
      // inventing a character the deployment never chose.
      systemPrompt.variable('character', () => character.record?.name || '一个语音助手'),
      systemPrompt.variable('character_personality', () => character.record?.personality ?? ''),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'voice-call prompt variables')

  /**
   * Resolve the selected voice's name once, for the prompt variable.
   *
   * Kept separate from pre-warming because the two answer different questions:
   * the label is needed before the FIRST prompt is assembled, while loading the
   * engine is only needed before the first sentence is spoken. A call can
   * therefore ask "who are you" correctly even with pre-warming off, and the
   * first reply does not race a background task to learn its own name.
   */
  let labelReady
  const ensureLabel = () => {
    labelReady ??= (async () => {
      await waitForSettings(ctx, voice, new AbortController().signal)
      await refreshCharacter()
      voice.label = (await resolveVoice(ctx, config, effectiveVoice())).label
    })().catch((error) => {
      ctx.logger.warn('voice-call could not resolve the voice name', error)
    })
    return labelReady
  }
  ctx.effect(() => {
    // Started eagerly: the answer is only needed at the first prompt, and this
    // costs a directory listing rather than a model load.
    void ensureLabel()
    return () => {}
  }, 'voice-call voice label')

  /**
   * Load the selected voice in the background at startup.
   *
   * Only the selected engine is warmed: loading both would hold two models in
   * memory for no gain, and the deployment only ever speaks with one. A failure
   * is not fatal -- the first call then loads the engine itself, which is what
   * would have happened without this -- so the reason is logged and nothing else
   * changes.
   *
   * The saved selection cannot be read while `apply` is still running, because
   * Settings lists only active entries and this plugin is not active yet. The
   * read therefore waits for the entry to appear rather than loading the
   * configured default and warming the wrong voice.
   */
  ctx.effect(() => {
    const lifetime = new AbortController()
    void (async () => {
      if (!config.prewarm) return
      await ensureLabel()
      if (lifetime.signal.aborted) return
      await refreshCharacter()
      const chosen = await resolveVoice(ctx, config, effectiveVoice())
      if (lifetime.signal.aborted) return
      const started = Date.now()
      try {
        if (chosen.engine === 'clone') {
          // Started once, with the reference carried per request afterwards.
          await clone.use([config.language])
          await clone.start()
        } else if (chosen.engine === 'piper') {
          await piper.use([chosen.path, `${chosen.path}.json`])
          await piper.start()
        } else {
          // Nothing local is selected, so there is nothing to load.
          return
        }
        if (lifetime.signal.aborted) return
        ctx.logger.info(`voice-call pre-warmed the ${chosen.engine} voice in ${((Date.now() - started) / 1000).toFixed(1)}s`)
      } catch (error) {
        if (lifetime.signal.aborted) return
        ctx.logger.warn('voice-call could not pre-warm the voice; the first call will load it instead', error)
      }
    })()
    return () => { lifetime.abort(new Error('voice-call disposed')) }
  }, 'voice-call pre-warm')

  const dispose = ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      const route = new URL(req.url || '/', 'http://localhost').pathname
      const work = await mkdtemp(join(tmpdir(), 'dsh-voice-call-'))
      try {
        if (route === `${ROUTE_PREFIX}/tts` && req.method === 'POST') {
          const body = await readBody(req, config.maxTextBytes)
          const text = body.toString('utf8').trim().slice(0, config.maxReplyChars)
          if (text === '') throw new RequestError('Nothing to synthesize', 400)
          await ensureVoice()
          let audio
          let source = 'cloud'
          await refreshCharacter()
          const effective = effectiveVoice()
          const chosen = await resolveVoice(ctx, config, effective)
          voice.label = chosen.label
          // The pace comes from the effective selection, so a character with its
          // own rate speaks at that rate and one without follows the setting.
          const rate = effective.rate
          if (chosen.engine === 'clone') {
            try {
              // The reference recording travels with the request, so one
              // resident XTTS model serves every cloned voice. Restarting per
              // voice would cost another ~75 s load for no benefit, since the
              // model is the same and only the reference audio differs.
              await clone.use([config.language])
              audio = await clone.speak(text, { rate, speakerWav: chosen.path })
              source = 'clone'
            } catch (error) {
              if (!voice.cloudFallback) {
                throw new RequestError(`Cloned-voice synthesis failed and cloud fallback is off: ${error instanceof Error ? error.message : String(error)}`, 502)
              }
              ctx.logger.warn('voice-call clone synthesis failed; using the cloud voice', error)
            }
          } else if (chosen.engine === 'piper') {
            try {
              // The voice is chosen per request, so the engine adopts that
              // model first; a switch restarts the process.
              await piper.use([chosen.path, `${chosen.path}.json`])
              audio = await piper.speak(text, { rate })
              source = 'local'
            } catch (error) {
              // A broken local engine must not cost the call its voice; fall
              // back to the cloud and keep the reason in the Host log. With the
              // fallback off, the failure is the answer instead.
              if (!voice.cloudFallback) {
                throw new RequestError(`Local synthesis failed and cloud fallback is off: ${error instanceof Error ? error.message : String(error)}`, 502)
              }
              ctx.logger.warn('voice-call local synthesis failed; using the cloud voice', error)
            }
          }
          if (audio === undefined) {
            // Reached when the selected engine is the cloud voice, or when a
            // local failure was allowed to fall back.
            if (!voice.cloudFallback && chosen.engine === 'cloud') {
              throw new RequestError('No local voice is available and cloud fallback is off', 503)
            }
            audio = await admission.run(() => synthesizeCloud(ctx, text, work, config, { ...effective, rate }))
          }
          res.writeHead(200, {
            'content-type': source === 'cloud' ? 'audio/mpeg' : 'audio/wav',
            'cache-control': 'no-store',
            'x-voice-source': source,
            'content-length': audio.length,
          })
          res.end(audio)
          return
        }
        if (route === `${ROUTE_PREFIX}/asr` && req.method === 'POST') {
          const audio = await readBody(req, config.maxAudioBytes)
          if (audio.length === 0) throw new RequestError('No audio was sent', 400)
          const result = await admission.run(() => recognize(ctx, audio, work, config, voice.cloudFallback))
          json(res, 200, { text: result.text, source: result.source }, { 'x-voice-source': result.source })
          return
        }
        if (route === `${ROUTE_PREFIX}/voices` && req.method === 'GET') {
          await ensureVoice()
          // Everything the settings page needs to draw its controls, in one
          // read: the selectable voices, the engine each belongs to, and the
          // current selection.
          const [locals, clones] = await Promise.all([listLocalVoices(config), listCloneVoices(config)])
          json(res, 200, {
            voices: [
              ...locals.map((entry) => ({ id: entry.id, name: entry.name, engine: 'piper' })),
              ...clones.map((entry) => ({ id: entry.id, name: entry.name, engine: 'clone' })),
            ],
            cloudVoices: CLOUD_VOICES,
            settings: {
              rate: voice.rate,
              localVoiceId: voice.localVoiceId,
              cloudVoice: voice.cloudVoice,
              cloneId: voice.cloneId,
              cloudFallback: voice.cloudFallback,
              portrait: await liveSetting('portrait', false),
              opening: await liveSetting('opening', ''),
            },
          })
          return
        }
        if (route === `${ROUTE_PREFIX}/settings` && req.method === 'POST') {
          // A settings write from the page. Only the named fields change, so a
          // partial update cannot silently reset the others.
          await ensureVoice()
          const body = await readBody(req, config.maxTextBytes)
          let patch
          try {
            patch = JSON.parse(body.toString('utf8'))
          } catch {
            throw new RequestError('Settings must be a JSON object', 400)
          }
          if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
            throw new RequestError('Settings must be a JSON object', 400)
          }
          if (patch.rate !== undefined) {
            const rate = Number(patch.rate)
            if (!Number.isFinite(rate) || rate < 0.5 || rate > 2) {
              throw new RequestError('Rate must be between 0.5 and 2.0', 400)
            }
            voice.rate = rate
          }
          if (typeof patch.localVoiceId === 'string') voice.localVoiceId = patch.localVoiceId
          if (typeof patch.cloudVoice === 'string') voice.cloudVoice = patch.cloudVoice
          if (typeof patch.cloneId === 'string') voice.cloneId = patch.cloneId
          if (typeof patch.cloudFallback === 'boolean') voice.cloudFallback = patch.cloudFallback
          // The figure settings are not part of the voice selection: they live
          // in the profile entry directly, the same way the voice does.
          const figurePatch = {
            ...typeof patch.portrait === 'boolean' ? { portrait: patch.portrait } : {},
            ...typeof patch.opening === 'string' ? { opening: patch.opening.slice(0, 300) } : {},
          }
          if (Object.keys(figurePatch).length > 0) {
            await persistSwitches(ctx, figurePatch)
            // A new switch changes how the next frame is built.
            if (typeof patch.portrait === 'boolean') portraitCache.key = ''
          }
          // The prompt variable follows the selection, so the agent's name for
          // itself changes with the voice rather than at the next call.
          await refreshCharacter()
          voice.label = (await resolveVoice(ctx, config, effectiveVoice())).label
          // The selection outlives the process, so it is written to the profile
          // entry the same way the speech plugins persist their own choices.
          // The active character is passed too: omitting it would clear a
          // selection this write was never asked to change.
          await persistVoice(ctx, voice, character)
          json(res, 200, { settings: { rate: voice.rate, localVoiceId: voice.localVoiceId, cloudVoice: voice.cloudVoice, cloneId: voice.cloneId, cloudFallback: voice.cloudFallback } })
          return
        }
        if (route === `${ROUTE_PREFIX}/clone` && req.method === 'POST') {
          // Clone a voice from an uploaded recording. The sample is kept so the
          // engine can re-read it, because XTTS needs the reference audio on
          // every synthesis rather than a derived speaker embedding.
          const body = await readBody(req, config.maxCloneBytes)
          if (body.length === 0) throw new RequestError('No audio was sent', 400)
          const name = new URL(req.url || '/', 'http://localhost').searchParams.get('name') ?? ''
          // Whatever format arrived is converted here, so the sample is stored
          // in the one shape every consumer downstream expects.
          const { bytes, converted } = await toCanonicalWave(ctx, config, body, work)
          const created = await saveClone(ctx, config, bytes, name)
          json(res, 201, { voice: created, converted })
          return
        }
        if (route.startsWith(`${ROUTE_PREFIX}/voices/`) && req.method === 'DELETE') {
          const id = assertCloneId(route.slice(`${ROUTE_PREFIX}/voices/`.length))
          await ensureVoice()
          await deleteCloneVoice(ctx, config, id)
          // A deleted voice must not stay selected, or the next call resolves a
          // voice that is no longer there. The character's own copy of the
          // selection is cleared too, since it may name the same voice.
          let cleared = false
          if (voice.cloneId === id) {
            voice.cloneId = ''
            voice.localVoiceId = voice.localVoiceId !== '' ? voice.localVoiceId : config.localTtsModel
            cleared = true
          }
          if (character.record !== null && character.record.voice.cloneId === id) {
            await updateCharacter(ctx, config, character.id, { voice: { cloneId: '' } })
            await refreshCharacter()
            cleared = true
          }
          voice.label = (await resolveVoice(ctx, config, effectiveVoice())).label
          if (cleared) await persistVoice(ctx, voice, character)
          json(res, 200, { deleted: id, cleared })
          return
        }
        if (route === `${ROUTE_PREFIX}/opening` && req.method === 'GET') {
          // The line the call speaks first, and whose voice says it. Read when a
          // call opens, so editing a character applies to the next call.
          //
          // A character's own line wins over the deployment default: a character
          // is a more specific instruction than "whatever this deployment says".
          // The default is what makes the feature work with no character at all.
          await ensureVoice()
          await refreshCharacter()
          const record = character.record
          const fromCharacter = record === null ? '' : record.opening.trim()
          const fromSettings = await liveSetting('opening', '')
          const opening = fromCharacter !== '' ? fromCharacter : (typeof fromSettings === 'string' ? fromSettings.trim() : '')
          json(res, 200, {
            name: record === null ? '' : record.name,
            opening,
            // Which one supplied it, so a surprising greeting can be traced to
            // the character or to the deployment setting.
            source: fromCharacter !== '' ? 'character' : (opening !== '' ? 'settings' : 'none'),
          }, { 'cache-control': 'no-store' })
          return
        }
        if (route === `${ROUTE_PREFIX}/characters` && req.method === 'GET') {
          // Everything the characters page needs in one read: the roster, which
          // one is active, and the voice options a character can choose from.
          const [roster, locals, clones] = await Promise.all([
            listCharacters(config), listLocalVoices(config), listCloneVoices(config),
          ])
          json(res, 200, {
            characters: roster,
            activeCharacter: character.id,
            // What "follow the voice settings" resolves to, so the editor can
            // show the real number instead of a placeholder.
            settingsRate: voice.rate,
            voices: [
              ...locals.map((entry) => ({ id: entry.id, name: entry.name, engine: 'piper' })),
              ...clones.map((entry) => ({ id: entry.id, name: entry.name, engine: 'clone' })),
            ],
            cloudVoices: CLOUD_VOICES,
          })
          return
        }
        if (route === `${ROUTE_PREFIX}/characters` && req.method === 'POST') {
          const body = await readBody(req, config.maxTextBytes)
          let patch
          try {
            patch = JSON.parse(body.toString('utf8'))
          } catch {
            throw new RequestError('A character must be a JSON object', 400)
          }
          if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
            throw new RequestError('A character must be a JSON object', 400)
          }
          const created = await createCharacter(ctx, config, String(patch.name ?? ''), String(patch.personality ?? ''), patch.voice, String(patch.opening ?? ''))
          json(res, 201, { character: created })
          return
        }
        if (route.startsWith(`${ROUTE_PREFIX}/characters/`) && route.endsWith('/avatar')) {
          const id = assertCharacterId(route.slice(`${ROUTE_PREFIX}/characters/`.length, -'/avatar'.length))
          if (await readCharacter(config, id) === undefined) throw new RequestError('Unknown character', 404)
          if (req.method === 'GET' || req.method === 'HEAD') {
            const stored = await readCharacterAvatar(config, id)
            if (stored === undefined) {
              if (req.method === 'HEAD') { res.writeHead(200, { 'x-avatar': 'none' }); res.end(); return }
              json(res, 200, { avatar: null }, { 'cache-control': 'no-store' })
              return
            }
            if (req.method === 'HEAD') { res.writeHead(200, { 'x-avatar': stored.type }); res.end(); return }
            res.writeHead(200, { 'content-type': stored.type, 'cache-control': 'no-store', 'content-length': stored.bytes.length })
            res.end(stored.bytes)
            return
          }
          if (req.method === 'POST') {
            const type = String(req.headers['content-type'] ?? '').split(';')[0].trim()
            if (!AVATAR_TYPES.has(type)) throw new RequestError(`Avatar must be one of: ${[...AVATAR_TYPES].join(', ')}`, 400)
            const bytes = await readBody(req, config.maxAvatarBytes)
            if (bytes.length === 0) throw new RequestError('No image was sent', 400)
            await saveCharacterAvatar(config, id, bytes, type)
            json(res, 201, { avatar: { type, bytes: bytes.length } })
            return
          }
          if (req.method === 'DELETE') {
            await rm(join(characterDir(config, id), 'avatar.img'), { force: true })
            await rm(join(characterDir(config, id), 'avatar.type'), { force: true })
            json(res, 200, { avatar: null })
            return
          }
        }
        if (route.startsWith(`${ROUTE_PREFIX}/characters/`) && req.method === 'PATCH') {
          const id = assertCharacterId(route.slice(`${ROUTE_PREFIX}/characters/`.length))
          const body = await readBody(req, config.maxTextBytes)
          let patch
          try {
            patch = JSON.parse(body.toString('utf8'))
          } catch {
            throw new RequestError('A character must be a JSON object', 400)
          }
          const updated = await updateCharacter(ctx, config, id, patch ?? {})
          // Editing the active character changes what the next call sounds like,
          // so its cached record and voice name are refreshed at once.
          if (character.id === id) { await refreshCharacter(); voice.label = (await resolveVoice(ctx, config, effectiveVoice())).label }
          json(res, 200, { character: updated })
          return
        }
        if (route.startsWith(`${ROUTE_PREFIX}/characters/`) && req.method === 'DELETE') {
          const id = assertCharacterId(route.slice(`${ROUTE_PREFIX}/characters/`.length))
          await deleteCharacter(ctx, config, id)
          // Deleting the active character clears the selection, so a call is not
          // left pointing at a record that no longer exists.
          if (character.id === id) {
            character.id = ''
            character.record = null
            voice.label = (await resolveVoice(ctx, config, voice)).label
            await persistVoice(ctx, voice, character)
          }
          json(res, 200, { deleted: id })
          return
        }
        if (route === `${ROUTE_PREFIX}/active-character` && req.method === 'POST') {
          const body = await readBody(req, config.maxTextBytes)
          let patch
          try {
            patch = JSON.parse(body.toString('utf8'))
          } catch {
            throw new RequestError('Expected a JSON object', 400)
          }
          const wanted = String(patch?.id ?? '')
          if (wanted !== '' && await readCharacter(config, wanted) === undefined) {
            throw new RequestError('Unknown character', 404)
          }
          character.id = wanted
          await refreshCharacter()
          voice.label = (await resolveVoice(ctx, config, effectiveVoice())).label
          await persistVoice(ctx, voice, character)
          json(res, 200, { activeCharacter: character.id, voice: voice.label })
          return
        }
        if (route === `${ROUTE_PREFIX}/portrait/frame` && req.method === 'POST') {
          // One animated frame, for a given mouth opening.
          //
          // Frames are pulled rather than pushed: the browser asks for the next
          // one when it is ready, so a slow GPU throttles the animation instead
          // of building a queue of stale frames.
          if (!await liveSetting('portrait', false)) {
            throw new RequestError('The portrait animator is switched off', 409)
          }
          const body = await readBody(req, config.maxTextBytes)
          let wanted
          try {
            wanted = JSON.parse(body.toString('utf8'))
          } catch {
            throw new RequestError('Expected a JSON object', 400)
          }
          // The engine's useful range runs above 1: an opening of 1.0 changes
          // only 0.03% of the frame, while 3.0 is a wide open mouth.
          const opening = Math.max(0, Math.min(3, Number(wanted?.open ?? 0)))
          await ensureVoice()
          const stored = await readFigure(config)
          if (stored === undefined) throw new RequestError('There is no picture to animate', 400)
          // The key names the picture, so replacing it restarts the engine with
          // the new face rather than animating the old one.
          const key = createHash('sha256').update(stored.bytes).digest('hex').slice(0, 24)
          if (portraitCache.key !== key) {
            const image = join(work, 'portrait-source.img')
            await writeFile(image, stored.bytes)
            await portrait.use([image, localPaths(config).portraitRoot])
            portraitCache.key = key
          }
          const started = Date.now()
          const reply = await portrait.request({ open: opening }, config.portraitTimeoutMs)
          json(res, 200, {
            frame: reply.jpeg,
            open: opening,
            ms: Date.now() - started,
          }, { 'cache-control': 'no-store' })
          return
        }
        if (route === `${ROUTE_PREFIX}/portrait` && req.method === 'HEAD') {
          // Whether the animator can run at all, so the call can choose between
          // a moving mouth and a still picture before it asks for a frame.
          const enabled = await liveSetting('portrait', false)
          const stored = await readFigure(config)
          const available = enabled && stored !== undefined
          res.writeHead(200, {
            'x-portrait': available ? 'ready' : 'none',
            'x-portrait-reason': !enabled ? 'disabled' : stored === undefined ? 'no-picture' : 'ready',
          })
          res.end()
          return
        }
        if (route === `${ROUTE_PREFIX}/figure` && (req.method === 'GET' || req.method === 'HEAD')) {
          // The picture the 3D figure is built from, on its own route so the
          // settings page can preview it without asking for a mesh.
          const stored = await readFigure(config)
          if (stored === undefined) {
            if (req.method === 'HEAD') { res.writeHead(200, { 'x-figure': 'none' }); res.end(); return }
            json(res, 200, { figure: null }, { 'cache-control': 'no-store' })
            return
          }
          if (req.method === 'HEAD') {
            res.writeHead(200, { 'x-figure': stored.type, 'x-figure-source': stored.fromFigure ? 'own' : 'avatar' })
            res.end()
            return
          }
          res.writeHead(200, {
            'content-type': stored.type,
            'cache-control': 'no-store',
            'content-length': stored.bytes.length,
          })
          res.end(stored.bytes)
          return
        }
        if (route === `${ROUTE_PREFIX}/figure` && req.method === 'POST') {
          const type = String(req.headers['content-type'] ?? '').split(';')[0].trim()
          if (!AVATAR_TYPES.has(type)) throw new RequestError(`Picture must be one of: ${[...AVATAR_TYPES].join(', ')}`, 400)
          const bytes = await readBody(req, config.maxAvatarBytes)
          if (bytes.length === 0) throw new RequestError('No image was sent', 400)
          const path = localPaths(config).figure
          await mkdir(dirname(path), { recursive: true })
          await writeFile(path, bytes)
          await writeFile(`${path}.type`, type, 'utf8')
          // A new picture means the animator must rebuild its source features.
          portraitCache.key = ''
          ctx.logger.info(`voice-call stored a figure picture (${type}, ${String(bytes.length)} bytes)`)
          json(res, 201, { figure: { type, bytes: bytes.length } })
          return
        }
        if (route === `${ROUTE_PREFIX}/figure` && req.method === 'DELETE') {
          const path = localPaths(config).figure
          await rm(path, { force: true })
          await rm(`${path}.type`, { force: true })
          portraitCache.key = ''
          json(res, 200, { figure: null })
          return
        }
        if (route === `${ROUTE_PREFIX}/call-avatar` && (req.method === 'GET' || req.method === 'HEAD')) {
          // What a call should actually show: the active character's picture
          // when it has one, otherwise the deployment's own. Kept separate from
          // `/avatar` because the settings page must keep editing the GLOBAL
          // picture even while a character is in use -- otherwise opening
          // settings would silently offer to replace the character's image.
          await refreshCharacter()
          const fromCharacter = character.record === null ? undefined : await readCharacterAvatar(config, character.id)
          const stored = fromCharacter ?? await readAvatar(config)
          if (stored === undefined) {
            if (req.method === 'HEAD') { res.writeHead(200, { 'x-avatar': 'none' }); res.end(); return }
            json(res, 200, { avatar: null }, { 'cache-control': 'no-store' })
            return
          }
          if (req.method === 'HEAD') { res.writeHead(200, { 'x-avatar': stored.type }); res.end(); return }
          res.writeHead(200, {
            'content-type': stored.type,
            'cache-control': 'no-store',
            'content-length': stored.bytes.length,
          })
          res.end(stored.bytes)
          return
        }
        if (route === `${ROUTE_PREFIX}/avatar` && (req.method === 'GET' || req.method === 'HEAD')) {
          // The overlay and the settings page both read the picture back through
          // this one route, so a change shows up in both without a second copy.
          const stored = await readAvatar(config)
          if (stored === undefined) {
            // A HEAD answers the same question with no body, which is what the
            // settings page needs to know whether a picture is set.
            if (req.method === 'HEAD') { res.writeHead(200, { 'x-avatar': 'none' }); res.end(); return }
            json(res, 200, { avatar: null }, { 'cache-control': 'no-store' })
            return
          }
          if (req.method === 'HEAD') { res.writeHead(200, { 'x-avatar': stored.type }); res.end(); return }
          res.writeHead(200, {
            'content-type': stored.type,
            'cache-control': 'no-store',
            // A new upload must not be answered from a stale cache, and the
            // picture is keyed by its own bytes rather than a version.
            'content-length': stored.bytes.length,
          })
          res.end(stored.bytes)
          return
        }
        if (route === `${ROUTE_PREFIX}/avatar` && req.method === 'POST') {
          // The image is sent as raw bytes with its media type in the header,
          // which avoids a multipart parser for a single field.
          const type = String(req.headers['content-type'] ?? '').split(';')[0].trim()
          if (!AVATAR_TYPES.has(type)) {
            throw new RequestError(`Avatar must be one of: ${[...AVATAR_TYPES].join(', ')}`, 400)
          }
          const body = await readBody(req, config.maxAvatarBytes)
          if (body.length === 0) throw new RequestError('No image was sent', 400)
          await saveAvatar(ctx, config, body, type)
          json(res, 201, { avatar: { type, bytes: body.length } })
          return
        }
        if (route === `${ROUTE_PREFIX}/avatar` && req.method === 'DELETE') {
          await clearAvatar(ctx, config)
          json(res, 200, { avatar: null })
          return
        }
        if (route === `${ROUTE_PREFIX}/route` && req.method === 'GET') {
          // The client asks which model a call should use, naming the deployment
          // default it read from the catalog. The probe proves that route
          // answers; only when it does not is another one chosen.
          if (!config.probeRoute) { json(res, 200, { routes: [] }); return }
          const url = new URL(req.url || '/', 'http://localhost')
          const preferred = url.searchParams.get('provider') !== null && url.searchParams.get('model') !== null
            ? { provider: url.searchParams.get('provider'), model: url.searchParams.get('model') }
            : null
          const cacheKey = preferred === null ? '' : `${preferred.provider}/${preferred.model}`
          if (config.routeTtlMs > 0 && routes.value.length > 0 && routes.key === cacheKey && Date.now() - routes.at < config.routeTtlMs) {
            json(res, 200, { routes: routes.value, cached: true })
            return
          }
          // Concurrent callers join one probe instead of each starting their own.
          // The promise is held in a local so a caller arriving after it settles
          // still awaits the probe it was meant to join.
          let pending = routes.inflight
          if (pending === null) {
            pending = (async () => {
              const { routes: best, rest } = await probeRoutes(ctx, config, preferred)
              routes = { at: Date.now(), value: best, inflight: null, key: cacheKey }
              // A full ranking that arrived after the early exit replaces the
              // single local route, so later calls see every working option.
              if (rest !== null) {
                void rest.then((complete) => {
                  if (complete.length > 0 && routes.value === best) {
                    routes = { at: Date.now(), value: complete, inflight: null, key: cacheKey }
                  }
                }).catch(() => undefined)
              }
              return best
            })()
            routes = { ...routes, inflight: pending }
          }
          const best = await pending
          json(res, 200, { routes: best })
          return
        }
        json(res, 404, { error: 'not found' })
      } catch (error) {
        const status = error instanceof BusyError ? 429
          : error instanceof RequestError ? error.status
            : 502
        // A rejected request is the caller's business; only an unexpected
        // failure is worth a Host log line.
        if (status === 502) ctx.logger.warn('voice-call request failed', error)
        json(res, status, { error: error instanceof Error ? error.message : String(error) })
      } finally {
        // The child processes are settled before this runs; only the temp files remain.
        await rm(work, { recursive: true, force: true }).catch(() => undefined)
      }
    },
  })
  ctx.effect(() => dispose, 'voice-call routes')
}
