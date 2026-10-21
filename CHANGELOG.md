# Changelog

Notable changes to this plugin. The version follows the plugin's own progress,
not any external standard.

## 0.3.0 — 2026-10-21

The first release meant for other people.

### A call the character starts

- **Characters speak first.** Each character has a "First words" line that it says
  the moment a call is answered, so a call greets you instead of waiting to be
  spoken to. The line is synthesized directly, so a greeting costs no model round
  trip and works before the route has been decided.
- **A deployment-wide greeting**, used when the character has no line of its own:
  character, then deployment, then nothing.

### A face that moves, and only one

- **LivePortrait animates the picture's mouth.** The photograph stays the person
  in the photograph and the mouth is rebuilt per frame, rather than a region of
  the image being stretched. Measured: driving the lips changes 0.15% of the
  pixels, all of them around the mouth.
- **Frames are pulled and only while speaking**, so a ~14 fps engine is usable and
  a quiet call costs no GPU at all. A still frame is fetched first, so a quiet
  call shows a face rather than an empty box.
- **The photo relief and the VRM figure were removed.** They competed for the
  same panel and the wrong one could win.

### Voices

- **Cloned voices can be removed**, and removing one clears the selection and any
  character that named it.
- **Clone ids are unique.** They were second-precision, so two uploads in the
  same second silently overwrote each other.
- **An uploaded recording is converted with ffmpeg**, so MP3, M4A, OGG, FLAC,
  Opus, and any WAV rate or channel count all work.
- **Switching cloned voices no longer reloads the model.** One resident XTTS
  serves every cloned voice: 73.5 s became 0.4 s.

### Fixes

- A replaced engine no longer kills its replacement.
- The cloud-fallback switch, which lets a call be kept entirely local.
- A setting typed into a field is kept while the request is in flight.
- A stale stored value no longer stops the plugin loading, which had taken the
  whole service down.

### Install

Models are not in the repository; `scripts/fetch-models.sh` fetches them. Speech
recognition needs nothing: it uses the Harness's own `speechToText` service.

## 0.1.0 — 2026-10-15

First working voice call: a sidebar call button, accept and hang-up, local Piper
speech with a cloud fallback, and a fresh tool-free conversation per call.