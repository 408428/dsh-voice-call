# Voice call — 语音通话插件

A WeChat-style voice call with the agent, inside the DeepSeek Harness Web UI.

侧边栏底部、设置按钮上方的电话按钮打开通话界面：有头像、接听和挂断键，智能体说的话会念出来，双方说的话实时转成文字。每次通话都会新建一个对话，并自动切到最快的模型、关闭思考，回复还会边生成边念。

## What it does

- **Call button** at the sidebar foot, directly above Settings. It starts a
  **new conversation**, or reuses the blank one an earlier call left behind, so
  repeated calls do not accumulate conversations.
- **Call screen** rendered frame-wide: avatar with a speaking ring, call phase,
  live microphone level, call timer, and a running transcript.
- **Incoming / active phases**: the green accept button answers, the red button
  declines or hangs up; while active a third button mutes the microphone.
- **Hands-free turns**: your speech is segmented by silence, recognized, and
  queued to the agent; each finished agent turn is synthesized and played, and
  detection resumes afterwards.
- **Voice mode per call**: the conversation is bound to a **tool-free** agent
  preset, so it answers instead of running shell and file tools. This is the
  single largest latency fix: with the standard presets, "你好" was answered with
  32 tool calls and 124 seconds of wall-clock time.
- **The conversation model is verified, not replaced**: the deployment's own
  model is probed with one token, and is only switched away from when it cannot
  answer.
- **A 30-second reply deadline**: if the answer has not started within 30 s, the
  call says so and resumes listening, and the late reply is dropped instead of
  being played at someone who stopped waiting. The next thing you say is
  answered normally.
- **Sentence-by-sentence speech**: reply text is spoken as it streams, so the
  agent starts talking while it is still writing instead of after the whole turn.

## How it works

| File | Responsibility |
|---|---|
| `index.js` (Host) | Two routes under `/.dsh-voice-call`: `POST /tts` (text → audio) and `POST /asr` (WAV → text). Synthesis prefers the local voice; recognition uses the `bl` CLI. |
| `piper_worker.py` (Host) | The resident local voice: loads a Piper model once and answers many utterances over a line protocol. |
| `client.js` (Client) | Microphone capture with silence segmentation, playback, the session bridge, and the slot registrations. |

Speech recognition is not implemented in this plugin: the Host half runs the
`bl` CLI that already holds the user's Bailian API key in
`~/.bailian/config.json`, so the plugin carries no credential of its own.

### Local voice

The local engine is what makes a call feel like a call. Measured on this
machine for a 20-character Chinese sentence:

| Engine | Warm latency |
|---|---|
| Local Piper (`zh_CN-huayan-medium`) | **~0.04–0.08 s** |
| Bailian `cosyvoice-v3-flash` | ~1.4–2.5 s |

Loading the model costs about a second, which is why the worker stays resident.
Install it once:

```sh
python3 -m venv ~/.dsh/voice-call/venv
~/.dsh/voice-call/venv/bin/pip install piper-tts
mkdir -p ~/.dsh/voice-call/models
# download a voice, e.g. zh_CN-huayan-medium.onnx and its .onnx.json
```

Without these files the plugin falls back to the cloud voice automatically, so a
missing local engine degrades latency rather than breaking the call.

Speech recognition uses the same audio contract as the built-in voice-input
feature: 16 kHz mono PCM16 WAV, resampled in the browser.

## Configuration

Every value is a `bl` CLI argument, changeable from the Plugin Manager's config
form or from `cordis.patch.yml`:

| Key | Default | Meaning |
|---|---|---|
| `localTts` | `true` | Prefer the local Piper voice |
| `localTtsModel` | `''` | Voice model path; empty selects the default under the Harness home |
| `localTtsPython` | `''` | Interpreter with `piper-tts`; empty selects the default under the Harness home |
| `ttsModel` | `cosyvoice-v3-flash` | Bailian text-to-speech model (fallback) |
| `ttsVoice` | `longwan_v3` | System voice id for that model |
| `asrModel` | `qwen3-asr-flash` | Bailian speech-recognition model |
| `language` | `zh` | Language hint for both directions |
| `maxReplyChars` | `300` | Reply characters sent to synthesis |
| `maxAudioBytes` | `4194304` | Largest accepted recording |
| `maxTextBytes` | `16384` | Largest accepted synthesis request |
| `commandTimeoutMs` | `60000` | Deadline for one `bl` invocation |
| `maxConcurrent` | `2` | Simultaneous `bl` invocations |

List the voices a model offers with:

```sh
bl speech synthesize --list-voices --model cosyvoice-v3-flash
```

## Why a call used to be slow

Three separate causes, found by reading real call transcripts rather than
guessing. Speech synthesis was never one of them: the local Piper voice answers
a sentence in about 40 ms.

1. **The coding preset.** Calls were left on the default preset, whose agent
   holds `tool-bash`, `tool-fs`, and the rest, and uses them. Measured on a real
   call, the greeting "你好" produced **32 tool calls and 123.7 seconds** before
   the user gave up. `preset-voice-call` is the fix: `persona` with
   `complete: true` and no tools at all, which also suppresses the runtime
   context and skill catalog that invite tool use.

2. **A model that answers nothing.** With the tools gone, the next call showed
   the real second cause: the route picker had chosen `qoder/mmodel`, which
   failed **five retries** with `112/model_error` and then ended the turn. The
   picker was matching route *names* against `/flash|turbo|nano|.../`, which
   says nothing about whether a route works. The Host now **probes** the
   deployment's own model with a one-token request and only switches away from
   it when it cannot answer.

## The voice knows its own name

The selected voice's name is published as the `{{voice}}` prompt variable, so the
call preset's persona can refer to it:

```
You are a spoken voice assistant on a phone call, and your voice
is called {{voice}}.
```

Asking "who are you" therefore answers with the name the user gave the voice
("灰原哀"), rather than a generic reply. The name comes from the deployment's own
selection — renaming a clone in Settings changes the answer on the next call,
with nothing to keep in sync by hand.

The variable is registered on the Host, where global prompt variables reach every
scope; `agent-loop` publishes `{{provider}}` and `{{model}}` the same way. Its
value is cached rather than resolved per assembly, because a prompt variable must
answer synchronously while resolving a voice reads the filesystem, and it falls
back to a generic word so a call is never told its voice is blank.

## Which model a call uses

**The conversation stays on the model the deployment configured.** Only the two
speech directions are local:

| Stage | Engine |
| --- | --- |
| Recognition | local SenseVoice through the Harness `speechToText` service |
| The conversation | **the deployment's own model, unchanged** |
| Synthesis | local Piper voice |

Measured here for 3.5 s of speech, recognition is **0.13 s locally** against
**1.0–1.9 s** through the cloud CLI, and the audio never leaves the machine.
Synthesis is **0.04–0.05 s** locally against roughly 1.4–2.5 s in the cloud.

The **model** is never replaced while it works. Its **thinking level** is
lowered for a call, because a spoken turn cannot wait on the profile-wide
`reasoningEffort: high` that makes every sentence think for a minute: a call asks
for `low`, or `off` where the model offers it, and only when the profile
explicitly set a higher level. An unset effort is left alone, since the
deployment expressed no preference there.

The route is switched only in two cases, both of which mean the configured model
is unusable:

- **The default cannot answer.** It is listed in the catalog but every request
  fails, as this deployment's default once did. The Host probes it with one
  token; when that fails, the quickest route that does answer is used instead,
  and the call screen says which.
- **The default failed earlier in this call.** A route can probe healthy and
  fail later, so a failure observed on a live call bans that route for the rest
  of the call and another is chosen.

When the default answers, nothing is selected at all and the call runs exactly
as the deployment intends.

## Voice settings

The plugin adds a **Voice call** page to Settings, where the voice is chosen and
tuned. Changes apply to the next call and survive a restart.

| Control | What it does |
| --- | --- |
| **Speaking rate** | 0.5–2.0, where 1.0 is the voice's own pace. Both engines take it: Piper as an inverse `length_scale`, the cloud CLI as `--rate`. |
| **Voice** | Local Piper voices (every `.onnx` pair under the voice directory) and cloned voices, in one list. |
| **Cloud voice** | One of 12 system voices, used when no local voice is available. |
| **Clone from a recording** | Upload 6–30 s of speech in any common audio format to create a voice. It is converted on this machine and never uploaded anywhere. |
| **Allow the cloud to stand in** | Whether a local failure may fall back to the cloud voice and recognizer. See below. |
| **Call picture** | Upload a PNG, JPEG, WebP, or GIF to replace the generated avatar. It is stored on this machine, and removing it restores the generated one. |

### Keeping a call local

Recognition and synthesis each prefer a local engine and fall back to the cloud
when one is missing or fails. **Allow the cloud to stand in** turns that fallback
off, so a call stays entirely on this machine:

| | On (default) | Off |
| --- | --- | --- |
| A local engine works | local | local |
| A local engine fails | cloud, with a log line | the call reports the failure |
| No local engine at all | cloud | the call reports the failure |

Off is the setting for a deployment that must not send audio anywhere: a silent
fallback would defeat that, because the failure is exactly the case where audio
would leave the machine. Measured on this machine, the refusal reaches the
browser as HTTP 503 with **zero** cloud invocations.

### The call picture

The overlay shows a generated avatar by default: a colour derived from the
session and its initial. Uploading a picture replaces it, and **Remove** puts the
generated one back. The image is served from the plugin's own route rather than
inlined into the page, so it is fetched once and cached by the browser, and a
replacement is requested with a fresh revision rather than answered from cache.

Accepted types are PNG, JPEG, WebP, and GIF, up to 4 MB. The type is validated
against that list rather than sniffed from the bytes, because it is echoed back
as the response's `content-type`: an unchecked value would let an upload choose
how the browser interprets it.

### Voice cloning

An upload does not have to be a WAV. **Any common audio format is converted on
this machine** with ffmpeg — MP3, M4A, OGG, FLAC, Opus, or a WAV at another rate
or channel count — because the user has no reason to know which shape the engine
wants. A file that is already canonical is stored untouched, so the common case
costs no subprocess. A file that is not audio at all is still refused, with a
sentence naming the formats that work.

Measured here, every one of those formats produced a sample the engine cloned
from and that recognized back to the original sentence.

Cloning runs **locally** through Coqui XTTS v2, so a cloned voice needs no cloud
account and the recording never leaves the machine. It is much heavier than
Piper: the model is about 1.8 GB and takes about **75 seconds to load**, after
which a sentence costs about **0.3 s**.

One loaded model serves **every** cloned voice, because only the reference
recording differs between them and that travels with each request. Switching
between two cloned voices therefore costs nothing after the first load: measured
here, 灰原哀 answered in 75.6 s (the load) and 贾维斯 in **0.4 s**.

That load happens at **startup**, not on the first call (`prewarm: true`). The
worker stays resident exactly like the Piper one, so a call's first sentence
costs about 0.8 s rather than 75 s. Measured here:

| | first sentence | later sentences |
| --- | --- | --- |
| with pre-warm | **0.76 s** | 0.24 s |
| without | 73.0 s | 0.24 s |

The warm-up runs in the background and never delays the Harness starting. It
also waits until the plugin is active before reading the saved voice, because
Settings lists only active entries and an earlier read would warm the wrong one.

The one-time setup, in the same venv Piper uses:

```sh
~/.dsh/voice-call/venv/bin/pip install coqui-tts torch torchaudio torchcodec pypinyin
# The weights are fetched through a mirror; see xtts_worker.py for why.
```

Without that install the page still works and simply reports that cloning is
unavailable; the local and cloud voices are unaffected.

## Requirements

- A microphone, and browser permission for it.
- The `bl` CLI on `PATH` with a configured API key (`bl auth status`), for
  recognition and for the cloud fallback voice.
- Bailian speech access on the account behind that key.
- Optionally, the local Piper engine described above, which removes the cloud
  voice from the reply path entirely.

## Known limitations

- **A call answers; it does not start one.** The agent only speaks after you do,
  because the plugin has no push channel from the Host into an idle call.
- **A call reuses a blank call Session, or creates one.** Repeated calls do not
  accumulate conversations, but a call Session that has already had turns is
  left alone.
- **The conversation model is the deployment's own.** A call does not pick a
  faster model for you; it only switches when the configured one cannot answer,
  because moving the conversation onto another model is not the plugin's
  decision to make. Probing costs one request, cached for `routeTtlMs`.
- **A clone upload is converted with ffmpeg.** The plugin runs `ffmpeg` from
  `PATH`; set `ffmpegPath` if it lives elsewhere. Without ffmpeg, only a file
  that is already 16 kHz mono PCM16 WAV can be used, and the upload reports why.
- **Cloning is local and slow to load.** The model takes about 75 s to load and
  about 1.8 GB of memory. This happens once at startup (`prewarm: true`); with
  pre-warming off, the first sentence of the first call waits that long. A
  voice's recording is stored under the plugin's data directory and re-read on
  each synthesis, because XTTS needs the reference audio rather than a derived
  embedding.
- **The cloud fallback is on by default.** With it off, a missing or broken local
  engine fails the call rather than reaching the cloud — that is the point, but
  it does mean a call can be silent if the local engine is not installed.
- **Recognition is local when the voice-input bundle is installed.** The plugin
  uses `speechToText` through `ctx.get`, so a profile without it still loads and
  falls back to the cloud CLI.
- **Session reuse needs the preset to be visible.** A call Session is recognized
  by its `voice-call` preset in the projection; until that preset exists in the
  composition — or before the first call records it — each call creates a new
  conversation.
- **"Existing" means blank and carrying the voice preset.** A call Session that
  has already had turns is not reused, because its preset is locked and its
  history belongs to that conversation.
- **Replies are spoken from `turn/end` text only.** Tool calls, reasoning, and
  approval prompts are not narrated, and a turn that ends with no text stays
  silent.
- **One call at a time**, and it is tied to the session it was placed from.
- **Silence segmentation is energy-based.** The threshold is calibrated from the
  median room level at call start, biased toward sensitivity: a false start costs
  one empty transcription, while a threshold above speech costs the whole call. In
  a room whose noise floor is louder than normal speech the call will hear the
  noise instead of you; use a headset or a quieter room.
- **Barge-in is not supported**: playback is not interrupted by speaking, and
  detection is suspended while a reply plays.
- **A microphone that reports digital silence for three seconds** raises an
  explicit notice rather than waiting forever, which distinguishes a device or
  permission problem from ordinary quiet.
