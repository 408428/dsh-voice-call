/**
 * Browser half of the voice-call bundle.
 *
 * Registers two seats: a phone button in the session header that places a call,
 * and a frame-wide overlay in `shell.overlay` that draws the call screen. The
 * overlay owns capture, playback, and the turn bridge; the Host half only
 * synthesizes and recognizes speech over `/.dsh-voice-call`.
 *
 * The file is one IIFE registering a lazy factory through
 * `window.__ModuleLoader__.load`, which is the documented shape for a client
 * bundle. React comes from the module table, so nothing is bundled twice.
 */
;(function () {
  window.__ModuleLoader__.load({
    id: '@local/dsh-voice-call',
    factory(require) {
      const React = require('react')
      const h = React.createElement
      const { useSyncExternalStore, useCallback, useEffect, useRef, useState } = React

      /** Locale namespace owned by this plugin. */
      const NS = 'voice-call'

      /** Visible copy, keyed so both languages stay complete. */
      const DICT = {
        en: {
          'action.call': 'Voice call',
          'action.accept': 'Accept',
          'action.decline': 'Decline',
          'action.hangUp': 'Hang up',
          'action.mute': 'Mute',
          'action.unmute': 'Unmute',
          'phase.incoming': 'Incoming voice call',
          'phase.calling': 'Calling…',
          'phase.active': 'On call',
          'phase.ending': 'Ending call…',
          'hint.accept': 'Tap the green button to answer',
          'hint.listening': 'Listening — just speak',
          'hint.speaking': 'Speaking…',
          'hint.thinking': 'Thinking…',
          'hint.transcribing': 'Recognizing…',
          'hint.muted': 'Microphone muted',
          'hint.connecting': 'Connecting to the agent…',
          'hint.device': 'Mic: {name}',
          'notice.noMic': 'Microphone is unavailable or permission was denied.',
          'notice.silentMic': 'The microphone is open but reports no sound. Check the input device and system volume.',
          'notice.newCallFailed': 'Could not start a new conversation: {message}',
          'notice.fastModeFailed': 'Fast mode is unavailable; using the default model: {message}',
          'notice.presetFailed': 'Voice mode could not be applied; using the default preset: {message}',
          'notice.presetMismatch': 'Voice mode applied as "{selected}" instead of "{requested}".',
          'notice.slowReply': 'The reply is taking too long, so the call will keep listening. Send it again if you still need an answer.',
          'route.verified': '{name} · verified',
          'hint.preset': 'Mode: Voice call',
          'settings.nav': 'Voice call',
          'settings.title': 'Voice',
          'settings.intro': 'How the voice call plugin speaks. Changes apply to the next call.',
          'settings.rate': 'Speaking rate',
          'settings.rateHint': '1.0 is the voice\'s own pace. Lower is slower, higher is faster.',
          'settings.engine': 'Voice',
          'settings.engineHint': 'Local voices answer in about 50 ms. A cloned voice answers in about 0.3 s once loaded, and takes about 75 s to load the first time.',
          'settings.cloudVoice': 'Cloud voice',
          'settings.cloudHint': 'Used when no local voice is available.',
          'settings.localGroup': 'Local voices',
          'settings.cloneGroup': 'Cloned voices',
          'settings.noLocal': 'No local voice models found.',
          'settings.noClone': 'No cloned voices yet. Upload a recording below.',
          'settings.voiceRemove': 'Remove this voice',
          'settings.voiceRemoveConfirm': 'Remove the voice "{name}"? Its recording is deleted from this machine.',
          'settings.voiceRemoved': 'The voice "{name}" was removed.',
          'settings.clone': 'Clone a voice from a recording',
          'settings.cloneHint': 'Upload 6-30 seconds of clear speech in any common audio format (MP3, M4A, WAV, OGG, FLAC). It is converted on this machine and never uploaded anywhere.',
          'settings.cloneName': 'Name for this voice',
          'settings.cloneNamePlaceholder': 'For example: my voice',
          'settings.cloneChoose': 'Choose a recording',
          'settings.cloneUpload': 'Create voice',
          'settings.cloneWorking': 'Creating…',
          'settings.cloneOk': 'Voice "{name}" is ready.',
          'settings.cloneConverted': 'Voice "{name}" is ready. The recording was converted to 16 kHz mono on this machine.',
          'settings.cloneFailed': 'Could not create the voice: {message}',
          'settings.loadFailed': 'Could not read the voice settings: {message}',
          'settings.saveFailed': 'Could not save: {message}',
          'settings.saved': 'Saved.',
          'settings.loading': 'Loading…',
          'settings.avatar': 'Call picture',
          'settings.avatarHint': 'Shown while a call is in progress. PNG, JPEG, WebP, or GIF, up to 4 MB. The image is stored on this machine.',
          'settings.avatarChoose': 'Choose an image',
          'settings.avatarUpload': 'Use this picture',
          'settings.avatarClear': 'Remove',
          'settings.avatarWorking': 'Uploading…',
          'settings.avatarOk': 'The call picture is set.',
          'settings.avatarCleared': 'The call picture was removed.',
          'settings.figure': '3D figure picture',
          'settings.figureHint': 'The picture the 3D figure is built from. Use a clear, front-facing face that fills the frame; it is separate from the avatar above, which is only a thumbnail.',
          'settings.figureChoose': 'Choose a picture',
          'settings.figureUpload': 'Use for the 3D figure',
          'settings.figureWorking': 'Uploading...',
          'settings.figureClear': 'Remove',
          'settings.figureOk': 'The 3D figure picture is set.',
          'settings.figureCleared': 'The 3D figure picture was removed; the avatar stands in.',
          'settings.figureBorrowed': 'No picture of its own yet, so the avatar above is being used. A face-filling picture gives the figure much more to work with.',
          'settings.figureFailed': 'Could not save the picture: {message}',
          'settings.avatarFailed': 'Could not set the picture: {message}',
          'characters.nav': 'Characters',
          'characters.intro': 'A character is a name, a personality, a voice, a picture, and a pace. Choose one and every call is placed as that character.',
          'characters.active': 'In use',
          'characters.use': 'Use this character',
          'characters.none': 'No character in use: calls use the voice settings above.',
          'characters.empty': 'No characters yet. Create one to give a call its own personality, voice, and picture.',
          'characters.create': 'New character',
          'characters.edit': 'Edit',
          'characters.delete': 'Delete',
          'characters.save': 'Save',
          'characters.cancel': 'Cancel',
          'characters.name': 'Name',
          'characters.namePlaceholder': 'For example: 灰原哀',
          'characters.personality': 'Personality',
          'characters.personalityHint': 'How this character talks and behaves. Written into the call instructions as {{character_personality}}.',
          'characters.personalityPlaceholder': 'For example: 说话简洁冷静，偶尔带点毒舌，但本质上是关心对方的。',
          'characters.voice': 'Voice',
          'characters.voiceHint': 'Which voice this character speaks with. The cloud voice follows the cloud-voice setting below.',
          'characters.rate': 'Speaking rate',
          'characters.rateHint': 'How fast this character talks. 1.00 is the voice\'s own pace.',
          'characters.rateFollow': 'Follow the voice settings ({value})',
          'characters.rateOwn': 'This character sets its own rate',
          'characters.voiceDefault': 'Follow the voice settings',
          'characters.cloudVoice': 'Cloud voice',
          'characters.avatar': 'Picture',
          'characters.avatarChoose': 'Choose an image',
          'characters.avatarClear': 'Remove picture',
          'characters.avatarHint': 'Shown on the call screen while this character is in use. PNG, JPEG, WebP, or GIF, up to 4 MB. Stored on this machine.',
          'characters.avatarChosen': 'A picture is ready to save',
          'characters.saved': 'Saved.',
          'characters.avatarOk': 'Picture updated.',
          'characters.failed': 'Could not save: {message}',
          'characters.confirmDelete': 'Delete this character? Its picture and settings are removed.',
          'settings.portrait': 'Animate the picture',
          'settings.portraitOn': 'On: the mouth moves with the audio. LivePortrait rebuilds each frame from the picture, so the face stays the same; it runs about 14 fps and only while speaking.',
          'settings.portraitOff': 'Off: the picture is shown flat, with the mouth bent by a depth mesh. That is faster but the mouth is stretched pixels rather than a rebuilt face.',
          'settings.fallback': 'Allow the cloud to stand in',
          'settings.fallbackOn': 'On: if a local engine is missing or fails, the cloud voice and recognizer are used instead.',
          'settings.fallbackOff': 'Off: a call stays entirely local. If a local engine fails, the call reports it instead of sending audio to a cloud API.',
          'call.newTitle': 'New voice call',
          'hint.route': 'Model: {name}',
          'notice.asrFailed': 'Could not recognize the recording: {message}',
          'notice.ttsFailed': 'Could not speak the reply: {message}',
          'notice.promptFailed': 'The agent did not accept the message: {message}',
          'notice.timeout': 'The agent did not finish the turn in time.',
          'notice.empty': 'No speech was recognized; try again.',
          'you': 'You',
          'agent': 'Assistant',
        },
        zh: {
          'action.call': '语音通话',
          'action.accept': '接听',
          'action.decline': '挂断',
          'action.hangUp': '挂断',
          'action.mute': '静音',
          'action.unmute': '取消静音',
          'phase.incoming': '语音来电',
          'phase.calling': '正在呼叫…',
          'phase.active': '通话中',
          'phase.ending': '正在挂断…',
          'hint.accept': '点绿色按钮接听',
          'hint.listening': '正在聆听，请说话',
          'hint.speaking': '正在说话…',
          'hint.thinking': '思考中…',
          'hint.transcribing': '识别中…',
          'hint.muted': '麦克风已静音',
          'hint.connecting': '正在连接智能体…',
          'hint.device': '麦克风：{name}',
          'notice.noMic': '麦克风不可用，或权限被拒绝。',
          'notice.silentMic': '麦克风已打开但收不到任何声音，请检查输入设备和系统音量。',
          'notice.newCallFailed': '无法新建对话：{message}',
          'notice.fastModeFailed': '快速模式不可用，改用默认模型：{message}',
          'notice.presetFailed': '语音模式没有生效，改用默认预设：{message}',
          'notice.presetMismatch': '语音模式实际生效的是"{selected}"，不是"{requested}"。',
          'notice.slowReply': '回复太久了，通话先继续聆听。如果还需要答案，请再说一次。',
          'route.verified': '{name} · 已验证',
          'hint.preset': '模式：语音通话',
          'settings.nav': '语音通话',
          'settings.title': '声音',
          'settings.intro': '语音通话插件怎么说话。改动从下一次通话开始生效。',
          'settings.rate': '语速',
          'settings.rateHint': '1.0 是声音本身的语速。数值越小越慢，越大越快。',
          'settings.engine': '声线',
          'settings.engineHint': '本地声线约 50 毫秒出声。复刻声线加载后约 0.3 秒出声，首次加载约需 75 秒。',
          'settings.cloudVoice': '云端声线',
          'settings.cloudHint': '本地声线不可用时使用。',
          'settings.localGroup': '本地声线',
          'settings.cloneGroup': '复刻声线',
          'settings.noLocal': '没有找到本地声线模型。',
          'settings.noClone': '还没有复刻声线。在下面上传一段录音即可。',
          'settings.voiceRemove': '移除此声线',
          'settings.voiceRemoveConfirm': '移除声线"{name}"？它在本机的录音会被删除。',
          'settings.voiceRemoved': '声线"{name}"已移除。',
          'settings.clone': '上传录音生成声线',
          'settings.cloneHint': '上传 6-30 秒清晰的说话录音，常见音频格式都行（MP3、M4A、WAV、OGG、FLAC）。转换在本机完成，录音不会上传到任何地方。',
          'settings.cloneName': '给这个声线起个名字',
          'settings.cloneNamePlaceholder': '例如：我的声音',
          'settings.cloneChoose': '选择录音',
          'settings.cloneUpload': '生成声线',
          'settings.cloneWorking': '正在生成…',
          'settings.cloneOk': '声线"{name}"已就绪。',
          'settings.cloneConverted': '声线"{name}"已就绪。录音已在本机转换为 16 kHz 单声道。',
          'settings.cloneFailed': '生成声线失败：{message}',
          'settings.loadFailed': '读取声音设置失败：{message}',
          'settings.saveFailed': '保存失败：{message}',
          'settings.saved': '已保存。',
          'settings.loading': '加载中…',
          'settings.avatar': '通话头像',
          'settings.avatarHint': '通话时显示。支持 PNG、JPEG、WebP、GIF，最大 4 MB。图片只保存在本机。',
          'settings.avatarChoose': '选择图片',
          'settings.avatarUpload': '使用这张图片',
          'settings.avatarClear': '移除',
          'settings.avatarWorking': '上传中…',
          'settings.avatarOk': '通话头像已设置。',
          'settings.avatarCleared': '通话头像已移除。',
          'settings.figure': '3D 形象图片',
          'settings.figureHint': '用来生成 3D 形象的图片。请用正面、脸占满画面的照片；它和上面的头像分开，头像是小缩略图。',
          'settings.figureChoose': '选择图片',
          'settings.figureUpload': '用作 3D 形象',
          'settings.figureWorking': '上传中...',
          'settings.figureClear': '移除',
          'settings.figureOk': '3D 形象图片已设置。',
          'settings.figureCleared': '3D 形象图片已移除，改用头像。',
          'settings.figureBorrowed': '还没有单独的图片，目前用的是上面的头像。换成脸占满画面的图片效果会好很多。',
          'settings.figureFailed': '保存图片失败：{message}',
          'settings.avatarFailed': '设置头像失败：{message}',
          'characters.nav': '角色',
          'characters.intro': '一个角色 = 名字 + 性格 + 声线 + 头像 + 语速。选中一个角色后，通话就以这个角色的身份进行。',
          'characters.active': '使用中',
          'characters.use': '使用这个角色',
          'characters.none': '当前没有使用角色：通话使用上面的声音设置。',
          'characters.empty': '还没有角色。新建一个，让它有自己的性格、声线和头像。',
          'characters.create': '新建角色',
          'characters.edit': '编辑',
          'characters.delete': '删除',
          'characters.save': '保存',
          'characters.cancel': '取消',
          'characters.name': '名字',
          'characters.namePlaceholder': '例如：灰原哀',
          'characters.personality': '性格',
          'characters.personalityHint': '这个角色怎么说话、怎么表现。会作为 {{character_personality}} 写进通话指令。',
          'characters.personalityPlaceholder': '例如：说话简洁冷静，偶尔带点毒舌，但本质上是关心对方的。',
          'characters.voice': '声线',
          'characters.voiceHint': '这个角色用哪个声音说话。选「云端声线」时使用下面的云端声线设置。',
          'characters.rate': '语速',
          'characters.rateHint': '这个角色说话的快慢。1.00 是声音本身的语速。',
          'characters.rateFollow': '跟随声音设置（{value}）',
          'characters.rateOwn': '这个角色单独设置语速',
          'characters.voiceDefault': '跟随声音设置',
          'characters.cloudVoice': '云端声线',
          'characters.avatar': '头像',
          'characters.avatarChoose': '选择图片',
          'characters.avatarClear': '移除头像',
          'characters.avatarHint': '使用这个角色时显示在通话界面。支持 PNG、JPEG、WebP、GIF，最大 4 MB。只保存在本机。',
          'characters.avatarChosen': '已选好图片，保存后生效',
          'characters.saved': '已保存。',
          'characters.avatarOk': '头像已更新。',
          'characters.failed': '保存失败：{message}',
          'characters.confirmDelete': '删除这个角色？它的头像和设置会一起删除。',
          'settings.portrait': '照片口型动画',
          'settings.portraitOn': '开启：嘴会跟着声音动。LivePortrait 会从照片逐帧重建，所以长相不变；约 14 fps，只在说话时渲染。',
          'settings.portraitOff': '关闭：显示平面照片，嘴部靠深度网格弯曲。更快，但嘴是拉伸的像素而不是重建的脸。',
          'settings.fallback': '本地不可用时使用云端',
          'settings.fallbackOn': '开启：本地引擎缺失或失败时，改用云端声线和识别。',
          'settings.fallbackOff': '关闭：通话完全在本地进行。本地引擎失败时会直接报错，而不会把音频发往云端 API。',
          'call.newTitle': '新的语音通话',
          'hint.route': '模型：{name}',
          'notice.asrFailed': '语音识别失败：{message}',
          'notice.ttsFailed': '语音合成失败：{message}',
          'notice.promptFailed': '智能体没有接受这条消息：{message}',
          'notice.timeout': '智能体长时间没有结束这一轮。',
          'notice.empty': '没有识别到语音，请再说一次。',
          'you': '我',
          'agent': '智能体',
        },
      }

      /** Resolve one dictionary key, falling back to English and then the key. */
      function translate(locale, key, params) {
        const table = DICT[locale] ?? DICT.en
        const template = table[key] ?? DICT.en[key] ?? key
        if (params === undefined) return template
        return template.replace(/\{(\w+)\}/g, (match, name) => (
          params[name] === undefined ? match : String(params[name])
        ))
      }

      /** Silence long enough to end one utterance, in milliseconds. */
      const SILENCE_MS = 700
      /** Shortest accepted utterance, in milliseconds. */
      const MIN_SPEECH_MS = 300
      /** Longest single utterance, in milliseconds. */
      const MAX_SPEECH_MS = 15_000
      /** Ambient calibration window at call start, in milliseconds. */
      const CALIBRATION_MS = 500
      /** Audio level sampling interval, in milliseconds. */
      const TICK_MS = 80
      /** How long a microphone may report pure digital silence before the call says so. */
      const SILENT_MIC_MS = 3000
      /** Lowest speech threshold, used in a quiet room. */
      const MIN_THRESHOLD = 0.008
      /** Highest speech threshold, so a loud room cannot make the call deaf. */
      const MAX_THRESHOLD = 0.08
      /** Agent reply deadline after a prompt, in milliseconds. */
      // The call's own deadline for a reply. It is deliberately far shorter than
      // the Host's turn budget: waiting two minutes for one sentence is the
      // failure this exists to prevent, and 30 s is the target the user set.
      const TURN_TIMEOUT_MS = 30_000
      /** Characters of agent reply that are spoken. */
      const SPOKEN_CHARS = 400
      /** Characters that end a sentence and can be spoken immediately. */
      const SENTENCE_END = /[。！？!?；;\n]/
      /** Characters that close a sentence after its terminator. */
      const CLOSER = /["'”’）)】》」』]/
      /** Preset identity a call binds its Session to; declared in `cordis.patch.yml`. */
      const VOICE_PRESET_ID = 'voice-call'

      /** Minimal observable store; the overlay subscribes through useSyncExternalStore. */
      function createStore(initial) {
        let state = initial
        const listeners = new Set()
        return {
          getSnapshot: () => state,
          subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
          set: (patch) => {
            state = { ...state, ...patch }
            for (const listener of [...listeners]) listener()
          },
        }
      }

      /**
       * Create a promise with its resolvers, without relying on
       * `Promise.withResolvers`, which older browsers do not implement.
       * @returns the promise plus its settle functions.
       */
      function deferred() {
        let resolve
        let reject
        const promise = new Promise((res, rej) => { resolve = res; reject = rej })
        // The readiness promise can settle with no waiter, so a rejection must
        // never surface as an unhandled rejection.
        promise.catch(() => undefined)
        return { promise, resolve, reject }
      }

      /** Deterministic accent colour so one session keeps one avatar. */
      function hueOf(seed) {
        let hash = 0
        for (let index = 0; index < seed.length; index++) hash = (hash * 31 + seed.charCodeAt(index)) % 360
        return hash
      }

      /** First visible character of a title, used as the avatar initial. */
      function initialOf(title) {
        const trimmed = (title ?? '').trim()
        return trimmed === '' ? '?' : [...trimmed][0]
      }

      /** Join the text blocks of one assistant message. */
      function textOfMessage(message) {
        const blocks = message?.content ?? []
        return blocks.filter((block) => block?.type === 'text').map((block) => block.text).join('').trim()
      }

      /** Encode mono floating-point samples as the PCM16 WAV the Host accepts. */
      function encodeWave(samples) {
        const bytes = new Uint8Array(44 + samples.length * 2)
        const view = new DataView(bytes.buffer)
        const text = (at, value) => { for (let index = 0; index < value.length; index++) bytes[at + index] = value.charCodeAt(index) }
        text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ')
        view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
        view.setUint32(24, 16000, true); view.setUint32(28, 32000, true)
        view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data')
        view.setUint32(40, samples.length * 2, true)
        for (let index = 0; index < samples.length; index++) {
          const value = Math.max(-1, Math.min(1, samples[index]))
          view.setInt16(44 + index * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true)
        }
        return bytes
      }

      /** Decode one recorded blob and resample it to the 16 kHz mono WAV the Host expects. */
      async function toWave(blob) {
        const context = new AudioContext()
        try {
          const decoded = await context.decodeAudioData(await blob.arrayBuffer())
          const frames = Math.max(1, Math.min(Math.floor(decoded.duration * 16000), 16000 * 30))
          const offline = new OfflineAudioContext(1, frames, 16000)
          const source = offline.createBufferSource()
          source.buffer = decoded
          source.connect(offline.destination)
          source.start()
          return encodeWave((await offline.startRendering()).getChannelData(0))
        } finally {
          await context.close().catch(() => undefined)
        }
      }

      /**
       * Microphone capture with silence-boundary segmentation.
       *
       * One MediaRecorder runs per utterance: the analyser decides when speech
       * starts and when the following silence ends it. Recognition and playback
       * both suspend detection, so the agent never hears itself.
       */
      function createCapture(handlers) {
        let stream
        let context
        let analyser
        let samples
        let timer
        let recorder
        let chunks = []
        let speechStart = 0
        let silenceSince = 0
        let calibrationEnd = 0
        /** Levels observed during calibration; the median estimates the room floor. */
        let calibrationLevels = []
        let threshold = MIN_THRESHOLD
        let busy = false
        let suspended = false
        let stopped = false
        /** Ticks since calibration where the microphone produced no usable signal. */
        let silentTicks = 0

        /** Release the microphone and every node derived from it. */
        async function stop() {
          stopped = true
          clearInterval(timer)
          if (recorder && recorder.state === 'recording') recorder.stop()
          recorder = undefined
          stream?.getTracks().forEach((track) => { track.stop() })
          stream = undefined
          analyser = undefined
          const closing = context
          context = undefined
          if (closing && closing.state !== 'closed') await closing.close().catch(() => undefined)
        }

        /** Stop the current recorder and hand the utterance to the caller. */
        function finish() {
          const active = recorder
          if (!active || active.state !== 'recording') return
          recorder = undefined
          // Hold detection until this utterance has been delivered, so the tail
          // of the same speech cannot open a second recording.
          busy = true
          active.stop()
        }

        /** Start one recorder for the utterance that just began. */
        function begin() {
          if (stopped || recorder) return
          chunks = []
          speechStart = Date.now()
          silenceSince = 0
          const active = new MediaRecorder(stream)
          recorder = active
          active.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data) }
          active.onerror = () => { if (recorder === active) { recorder = undefined; busy = false } }
          active.onstop = () => {
            const blob = new Blob(chunks, { type: active.mimeType })
            chunks = []
            if (stopped || blob.size === 0 || Date.now() - speechStart < MIN_SPEECH_MS) { busy = false; return }
            Promise.resolve(handlers.onUtterance(blob)).catch(() => undefined).finally(() => { busy = false })
          }
          active.start()
        }

        /** A smoothed envelope of the input level, for the mouth. */
        let smoothedLevel = 0
        /** A slow-decaying peak, so the mouth opening adapts to this microphone. */
        let peak = 0

        /** One analyser tick: measure, calibrate, and drive the segment state machine. */
        function tick() {
          if (stopped || !analyser) return
          analyser.getFloatTimeDomainData(samples)
          let sum = 0
          for (const sample of samples) sum += sample * sample
          const level = Math.sqrt(sum / samples.length)
          handlers.onLevel(level)
          // The mouth follows a smoothed envelope, not the raw RMS: the raw
          // number jumps within a single syllable, and a mouth driven by it
          // vibrates instead of opening. An asymmetric average rises quickly
          // (so a syllable starts promptly) and falls slowly (so it does not
          // snap shut between syllables).
          smoothedLevel = level > smoothedLevel
            ? smoothedLevel + (level - smoothedLevel) * 0.5
            : smoothedLevel + (level - smoothedLevel) * 0.12
          // Track a slow-decaying peak, so the mapping adapts to this speaker's
          // microphone rather than to a number chosen on one machine.
          peak = Math.max(smoothedLevel, peak * 0.995)
          const fraction = peak > 0.01 ? smoothedLevel / peak : 0
          // Measured against the engine: an opening of 1.0 changes 0.03% of the
          // frame and is almost invisible, 2.0 is a clear open mouth, and 3.0 is
          // wide. So the useful range sits above 1, not below it.
          handlers.onMouth?.(Math.min(2.4, Math.max(0, fraction * 2.4)))
          if (Date.now() < calibrationEnd) {
            calibrationLevels.push(level)
            return
          }
          if (calibrationLevels.length > 0) {
            // The MEDIAN, not the maximum: one cough or door slam during the
            // calibration window must not raise the threshold above normal
            // speech and leave the call deaf for its whole duration.
            // The multiplier is deliberately low. A false start costs one empty
            // transcription the call recovers from; a threshold above speech
            // costs the whole call, which is the failure this guards against.
            const sorted = [...calibrationLevels].sort((left, right) => left - right)
            const median = sorted[Math.floor(sorted.length / 2)]
            threshold = Math.max(MIN_THRESHOLD, Math.min(median * 1.5, MAX_THRESHOLD))
            calibrationLevels = []
          }
          if (suspended || busy) return
          // A microphone that never reports any signal is a device or permission
          // problem, not silence; say so instead of waiting forever.
          if (level < 1e-5) {
            silentTicks += 1
            if (silentTicks === Math.ceil(SILENT_MIC_MS / TICK_MS)) handlers.onSilent?.()
          } else {
            silentTicks = 0
          }
          if (recorder === undefined) {
            if (level > threshold) begin()
            return
          }
          if (level > threshold) silenceSince = 0
          else if (silenceSince === 0) silenceSince = Date.now()
          if (silenceSince !== 0 && Date.now() - silenceSince > SILENCE_MS) finish()
          else if (Date.now() - speechStart > MAX_SPEECH_MS) finish()
        }

        return {
          /** Acquire the microphone and start segmentation. */
          async start() {
            stream = await navigator.mediaDevices.getUserMedia({
              audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
              video: false,
            })
            // The acquired device's name is the fastest way to spot the common
            // "the call is listening to the wrong microphone" failure.
            const track = stream.getAudioTracks()[0]
            handlers.onDevice?.(track?.label ?? '')
            track?.addEventListener?.('ended', () => { handlers.onSilent?.() })
            context = new AudioContext()
            analyser = context.createAnalyser()
            analyser.fftSize = 1024
            samples = new Float32Array(analyser.fftSize)
            context.createMediaStreamSource(stream).connect(analyser)
            // Web Audio renders a graph only along a path that reaches the
            // destination, so an analyser used purely as a meter must still be
            // connected through a muted sink. Without this the analyser reports
            // zeros forever and no utterance is ever detected.
            const sink = context.createGain()
            sink.gain.value = 0
            analyser.connect(sink)
            sink.connect(context.destination)
            // Autoplay policy can start the context suspended, which also stops
            // the analyser from producing frames.
            if (context.state === 'suspended') await context.resume().catch(() => undefined)
            calibrationEnd = Date.now() + CALIBRATION_MS
            timer = setInterval(tick, TICK_MS)
          },
          /** Suspend or resume detection without releasing the microphone. */
          setSuspended(value) { suspended = value },
          stop,
        }
      }

      /**
       * One call: session bridge, capture, playback, and the observable state the UI draws.
       * @param ctx - Client plugin context.
       * @param store - state store the overlay subscribes to.
       * @param session - the declared `remote.session` namespace service.
       * @param agentPresets - the declared `remote.agentPresets` namespace service.
       * @param sessions - the `sessions` service, for reusing an earlier call Session.
       * @param openSession - selects the created Session in the Conversation view.
       * @param createSession - creates a Session through the object-layer face.
       * @param t - namespace-bound translator for call-screen copy.
       * @returns call controls and the dispose hook.
       */
      function createCall(ctx, store, session, agentPresets, sessions, openSession, createSession, t) {
        let lifetime = new AbortController()
        let capture
        let audio
        let audioUrl
        let generation = 0
        let elapsedTimer
        let loop
        /**
         * Settles once the session stream has delivered its opening snapshot.
         * A prompt admitted before that would race the snapshot, so every send
         * waits here first.
         */
        let ready = deferred()
        /**
         * When this turn's reply must have STARTED, or 0 when none is awaited.
         *
         * The deadline covers the wait for the answer to begin, not the whole
         * reply: once the first sentence is being spoken the call is working,
         * and talking for a while is exactly what a call is for.
         */
        let replyDueAt = 0
        /**
         * Counts abandoned waits.
         *
         * A turn is spoken only while this number is the one it started under,
         * so output from a turn the call stopped waiting for is dropped. It is
         * deliberately NOT the call generation: bumping that would end the
         * session stream and leave the call mute for the rest of its life.
         */
        let abandonCount = 0
        /**
         * Routes that failed during this call, by `provider/model`.
         *
         * A route can be probed healthy and still fail later, so a failure
         * observed on a live call is remembered and never chosen again by this
         * call. The next prompt then re-routes instead of failing the same way
         * for the rest of the conversation.
         */
        const failedRoutes = new Set()
        /** The route the call is currently answering on, or null. */
        let activeRoute = null
        /**
         * The in-flight route decision, or null.
         *
         * The first prompt must not go out before the route is chosen: the
         * deployment default is exactly the route this exists to avoid, so a
         * prompt admitted too early would be answered by the broken model the
         * probe was meant to reject.
         */
        let routeReady = null
        /**
         * Abandon count the current wait started under. Output is spoken only
         * while this still matches, so text from an abandoned wait is dropped
         * while the next prompt's own turn is spoken normally.
         */
        let waitBaseline = 0

        /** Start waiting for a reply. */
        function armDeadline() {
          replyDueAt = Date.now() + TURN_TIMEOUT_MS
          waitBaseline = abandonCount
        }

        /** The answer has begun, so the wait is over. */
        function disarmDeadline() {
          replyDueAt = 0
        }

        /**
         * Give up on a reply that never started within the call's deadline.
         *
         * A call is not a place to wait. When nothing has been spoken within
         * {@link TURN_TIMEOUT_MS} of the prompt, the call says so and resumes
         * listening; the abandoned turn's output is then dropped rather than
         * played at someone who has stopped waiting for it. The stream stays
         * open, so the next thing the user says is answered normally.
         */
        const deadlineTimer = setInterval(() => {
          if (replyDueAt === 0 || Date.now() <= replyDueAt) return
          disarmDeadline()
          abandonCount += 1
          store.set({ activity: 'listening', notice: { key: 'notice.slowReply' } })
        }, 500)
        ctx.effect(() => () => { clearInterval(deadlineTimer) }, 'voice-call reply deadline')

        /**
         * Speak one sentence and play it to completion.
         *
         * Sentences are spoken as they are produced rather than after the whole
         * turn, which is most of the difference between a call that feels live
         * and one that pauses for several seconds before answering.
         *
         * @param text - one sentence, already trimmed.
         * @param run - call generation; a stale run stops without playing.
         */
        async function speak(text, run) {
          const body = text.slice(0, SPOKEN_CHARS)
          if (body === '' || run !== generation) return
          store.set({ activity: 'speaking' })
          capture?.setSuspended(true)
          let url
          try {
            const response = await fetch('/.dsh-voice-call/tts', { method: 'POST', body, signal: lifetime.signal })
            if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `HTTP ${String(response.status)}`)
            if (run !== generation) return
            url = URL.createObjectURL(await response.blob())
            const playing = new Audio(url)
            audio = playing
            await new Promise((resolve) => {
              playing.onended = resolve
              playing.onerror = resolve
              playing.play().catch(resolve)
            })
          } catch (error) {
            if (!lifetime.signal.aborted) store.set({ notice: { key: 'notice.ttsFailed', params: { message: String(error?.message ?? error) } } })
          } finally {
            if (url !== undefined) URL.revokeObjectURL(url)
            audioUrl = url
            if (audio === undefined || audio.src === url) audio = undefined
            if (run === generation) {
              // Restore detection to what the user asked for: a muted call must
              // stay muted after a reply finishes playing.
              capture?.setSuspended(store.getSnapshot().muted)
              store.set({ activity: 'listening' })
            }
          }
        }

        /**
         * Split accumulated reply text into complete sentences, keeping the tail.
         *
         * Chinese and Western terminators both end a sentence, and a closing
         * quote after the mark belongs to the sentence it closes.
         * @param text - accumulated reply text.
         * @returns complete sentences and the unfinished remainder.
         */
        function splitSentences(text) {
          const sentences = []
          let start = 0
          for (let index = 0; index < text.length; index++) {
            if (!SENTENCE_END.test(text[index])) continue
            // Absorb trailing closing punctuation and whitespace.
            let end = index + 1
            while (end < text.length && CLOSER.test(text[end])) end += 1
            const sentence = text.slice(start, end).trim()
            if (sentence !== '') sentences.push(sentence)
            start = end
            index = end - 1
          }
          return { sentences, rest: text.slice(start) }
        }

        /** Recognize one utterance and send it to the agent. */
        async function onUtterance(blob) {
          const run = generation
          store.set({ activity: 'transcribing' })
          try {
            const wave = await toWave(blob)
            const response = await fetch('/.dsh-voice-call/asr', {
              method: 'POST', body: wave, headers: { 'content-type': 'audio/wav' }, signal: lifetime.signal,
            })
            if (!response.ok) throw new Error((await response.json().catch(() => null))?.error ?? `HTTP ${String(response.status)}`)
            if (run !== generation) return
            const text = (await response.json()).text?.trim() ?? ''
            if (text === '') { store.set({ activity: 'listening', notice: { key: 'notice.empty' } }); return }
            store.set({ lines: [...store.getSnapshot().lines, { role: 'you', text }], notice: null })
            await send(text, run)
          } catch (error) {
            if (!lifetime.signal.aborted) {
              store.set({ activity: 'listening', notice: { key: 'notice.asrFailed', params: { message: String(error?.message ?? error) } } })
            }
          }
        }

        /**
         * Admit one recognized utterance as a queued prompt.
         *
         * The reply deadline starts HERE, not on the `turn/start` echo: a call
         * is already waiting the moment it has spoken, and an echo that never
         * arrives must not leave the call hanging.
         */
        async function send(text, run) {
          const sessionId = store.getSnapshot().sessionId
          if (sessionId === null) return
          store.set({ activity: 'thinking' })
          await ready.promise
          if (run !== generation || lifetime.signal.aborted) return
          // Let the route decision land first, so the reply comes from the
          // probed model rather than the deployment default.
          if (routeReady !== null) await routeReady
          if (run !== generation || lifetime.signal.aborted) return
          // Arm before admission settles: the call is already waiting, and the
          // deadline must not depend on a `turn/start` echo that may never come.
          armDeadline()
          const response = await session.prompt({
            requestId: `voice-call-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text }],
            clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }, lifetime.signal)
          if (run !== generation) return
          if (!response.ok) disarmDeadline()
          if (!response.ok) {
            store.set({ activity: 'listening', notice: { key: 'notice.promptFailed', params: { message: response.error.message } } })
          }
        }

        /**
         * Follow the session and speak each agent turn.
         *
         * The opening snapshot is skipped: it carries history, and speaking it
         * would replay the conversation. The prompt is sent only after the
         * snapshot arrives, so no live frame can be missed.
         *
         * Speech follows the reply as it is produced. `assistant-stream` frames
         * carry live text deltas, so each finished sentence is spoken while the
         * model is still writing the next one; the durable `assistant/message`
         * is a fallback for a reply that never streamed.
         */
        async function followSession(signal) {
          const sessionId = store.getSnapshot().sessionId
          let spoken = ''
          let pending = ''
          /** Speak whatever complete sentences the buffer now holds. */
          const drain = async (final) => {
            const { sentences, rest } = splitSentences(pending)
            pending = final ? '' : rest
            const queue = final && rest.trim() !== '' ? [...sentences, rest.trim()] : sentences
            for (const sentence of queue) {
              if (generation !== run || signal.aborted) return
              // The call stopped waiting for this turn: drop the rest of it.
              if (abandonCount !== waitBaseline) { pending = ''; return }
              // The answer has begun: the call is no longer waiting.
              disarmDeadline()
              spoken += sentence
              store.set({ lines: [...store.getSnapshot().lines.filter((line) => line.role !== 'agent-live'), { role: 'agent', text: spoken }] })
              await speak(sentence, generation)
            }
          }
          const run = generation
          try {
            const stream = session.follow({ address: { kind: 'session', sessionId }, assistantStream: true }, signal)
            let opened = false
            for await (const frame of stream) {
              if (!opened) {
                opened = true
                ready.resolve()
                store.set({ activity: 'listening' })
                continue
              }
              if (frame.type === 'assistant-stream') {
                // Live text deltas arrive as the model writes them.
                const chunk = frame.frame?.chunk ?? frame.frame
                if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
                  pending += chunk.text
                  // No re-arm here. The wait started when the prompt was sent;
                  // re-arming would adopt the current abandon count, which is
                  // exactly what lets an abandoned turn slip through and be
                  // spoken after the call stopped waiting for it.
                  await drain(false)
                }
                continue
              }
              if (frame.type !== 'event') continue
              const event = frame.event
              if (event.type === 'turn/start') { spoken = ''; pending = '' }
              else if (event.type === 'assistant/message') {
                // A turn that streamed already spoke its sentences; one that did
                // not is spoken now, in full, as a single fallback.
                const full = textOfMessage(event.data.message)
                if (full !== '' && spoken === '') { pending = full; await drain(true) }
              } else if (event.type === 'turn/end') {
                disarmDeadline()
                await drain(true)
                spoken = ''
                pending = ''
                if (generation === run) {
                  store.set({ activity: 'listening' })
                  // A turn that ended in failure names a route that cannot
                  // answer, so this call stops using it and picks another.
                  if (event.data?.reason?.kind === 'error' && activeRoute !== null) {
                    failedRoutes.add(activeRoute)
                    activeRoute = null
                    routeReady = useFastRoute(sessionId)
                  }
                }
              }
            }
          } catch (error) {
            // A stream failure is a call failure; rethrowing would only reach the
            // caller that already recorded it in the store.
            ready.reject(error)
            if (!signal.aborted) store.set({ notice: { key: 'notice.promptFailed', params: { message: String(error?.message ?? error) } } })
          } finally {
            clearInterval(timer)
          }
        }

        /** Start capture and the session bridge for one accepted call. */
        async function connect() {
          const run = ++generation
          capture = createCapture({
            onLevel: (level) => { store.set({ level }) },
            // A separate channel for the mouth, so the meter stays responsive
            // while the mouth moves smoothly.
            onMouth: (mouth) => { store.set({ mouth }) },
            onUtterance,
            onSilent: () => { store.set({ notice: { key: 'notice.silentMic' } }) },
            onDevice: (label) => { store.set({ device: label }) },
          })
          try {
            await capture.start()
          } catch (error) {
            store.set({ notice: { key: 'notice.noMic', params: { message: String(error?.message ?? error) } } })
          }
          if (run !== generation) return
          elapsedTimer = setInterval(() => {
            store.set({ elapsed: Math.floor((Date.now() - store.getSnapshot().startedAt) / 1000) })
          }, 1000)
          loop = followSession(lifetime.signal).catch((error) => {
            if (!lifetime.signal.aborted) {
              store.set({ activity: 'listening', notice: { key: 'notice.promptFailed', params: { message: String(error?.message ?? error) } } })
            }
          })
        }
        /**
         * Settle the model route for this call.
         *
         * The conversation stays on the model the deployment configured: only
         * recognition and synthesis are local, so a call must not quietly move
         * the conversation onto a different model. The route is touched in two
         * cases only:
         *
         * - the default cannot answer (it is listed but every request fails),
         *   in which case the quickest working route is used instead;
         * - the default failed earlier in this call, in which case another one
         *   is chosen so the conversation can continue.
         *
         * When the default answers, nothing is selected at all, so the call runs
         * exactly as the deployment intends.
         *
         * @param sessionId - the Session the call will use.
         */
        async function useFastRoute(sessionId) {
          try {
            const catalog = await session.modelCatalog()
            if (!catalog.ok) throw new Error(catalog.error.message)
            const models = catalog.value.groups.flatMap((group) => group.models.map((model) => ({ provider: group.id, model })))
            const entryOf = (provider, modelId) => models.find((entry) => entry.provider === provider && entry.model.id === modelId)
            const defaultRoute = catalog.value.default ?? null
            const defaultKey = defaultRoute === null ? null : `${defaultRoute.provider}/${defaultRoute.model}`
            // The default is untouched unless it is known bad or already failed.
            if (defaultKey !== null && !failedRoutes.has(defaultKey)) {
              const probed = await probedRoutes(defaultRoute)
              // A probed ranking that still leads with the default proves it
              // answers, which is the whole question: keep the model, and only
              // lower its thinking.
              if (probed.length === 0 || `${probed[0].provider}/${probed[0].id}` === defaultKey) {
                const entry = entryOf(defaultRoute.provider, defaultRoute.model)
                const name = entry?.model.name ?? defaultRoute.model
                // A call cannot think for a minute before every sentence. The
                // profile may explicitly ask for `high`; a spoken turn asks for
                // `low`, or `off` when the model offers it, while keeping the
                // same model. An UNSET effort is left alone: the deployment has
                // expressed no preference there, and inventing one would change
                // behavior this plugin was not asked to change.
                const efforts = entry?.model.reasoning?.efforts ?? []
                const current = defaultRoute.reasoningEffort
                const callEffort = current === undefined
                  ? undefined
                  : efforts.find((candidate) => candidate.id === 'low')
                    ?? efforts.find((candidate) => candidate.id === 'off')
                if (callEffort !== undefined && callEffort.id !== current) {
                  const lowered = await session.selectModel({
                    sessionId,
                    provider: defaultRoute.provider,
                    model: defaultRoute.model,
                    reasoningEffort: callEffort.id,
                  })
                  if (!lowered.ok) throw new Error(lowered.error.message)
                  store.set({ route: `${name} · ${callEffort.name}` })
                } else {
                  // "verified" only when the Host actually probed it; without a
                  // probe the default is simply assumed, which is not the same claim.
                  store.set({ route: probed.length === 0 ? name : t('route.verified', { name }) })
                }
                activeRoute = defaultKey
                return
              }
              // The default did not answer, so the probed fallback is used.
              const entry = entryOf(probed[0].provider, probed[0].id)
              if (entry !== undefined) {
                await applyRoute(sessionId, { provider: probed[0].provider, model: probed[0].id, label: probed[0].name, reasoning: entry.model.reasoning })
                return
              }
            }
            // The default failed on this call, or could not be established:
            // choose the quickest working route the Host knows.
            const chosen = await pickFallback(models, entryOf)
            if (chosen === null) { activeRoute = null; store.set({ route: null }); return }
            await applyRoute(sessionId, chosen)
          } catch (error) {
            store.set({ route: null, notice: { key: 'notice.fastModeFailed', params: { message: String(error?.message ?? error) } } })
          }
        }

        /**
         * Select one route on the Session and record it.
         * @param sessionId - the Session the call will use.
         * @param chosen - provider, model, label, and reasoning metadata.
         */
        async function applyRoute(sessionId, chosen) {
          const efforts = chosen.reasoning?.efforts ?? []
          const effort = efforts.find((candidate) => candidate.id === 'off')
            ?? efforts.find((candidate) => candidate.id === 'low')
          const selected = await session.selectModel({
            sessionId,
            provider: chosen.provider,
            model: chosen.model,
            ...(effort === undefined ? {} : { reasoningEffort: effort.id }),
          })
          if (!selected.ok) throw new Error(selected.error.message)
          activeRoute = `${chosen.provider}/${chosen.model}`
          store.set({ route: `${chosen.label}${effort === undefined ? '' : ` · ${effort.name}`}` })
        }

        /**
         * Choose a route from the catalog when the default is unusable.
         *
         * @param models - every catalog entry.
         * @param entryOf - lookup by provider and model id.
         * @returns a usable route, or null when none remains.
         */
        async function pickFallback(models, entryOf) {
          const probed = await probedRoutes(null)
          for (const route of probed) {
            if (failedRoutes.has(`${route.provider}/${route.id}`)) continue
            const entry = entryOf(route.provider, route.id)
            if (entry === undefined) continue
            return { provider: route.provider, model: route.id, label: route.name, reasoning: entry.model.reasoning }
          }
          const usable = models.filter((entry) => !failedRoutes.has(`${entry.provider}/${entry.model.id}`))
          if (usable.length === 0) return null
          const best = usable[0]
          return { provider: best.provider, model: best.model.id, label: best.model.name, reasoning: best.model.reasoning }
        }

        /**
         * Read the Host's probed route ranking.
         *
         * The deployment default is named in the query so the Host probes THAT
         * route first: the question is whether the configured model works, not
         * which model is quickest.
         *
         * @param preferred - the deployment default route, or null.
         * @returns probed routes, best first; empty when unavailable.
         */
        async function probedRoutes(preferred) {
          try {
            const query = preferred === null ? '' : `?provider=${encodeURIComponent(preferred.provider)}&model=${encodeURIComponent(preferred.model)}`
            const response = await fetch(`/.dsh-voice-call/route${query}`, { signal: lifetime.signal })
            if (!response.ok) return []
            const body = await response.json()
            return Array.isArray(body?.routes) ? body.routes : []
          } catch {
            return []
          }
        }

        /**
         * Bind a Session to the tool-free voice preset.
         *
         * This is what makes a call answer instead of running coding tools: the
         * standard presets carry `tool-bash` and `tool-fs`, and an agent that
         * has them will use them even for a greeting. A Session may only take a
         * preset before its first turn, so this runs on a fresh Session.
         *
         * @param sessionId - the Session the call will use.
         */
        async function useVoicePreset(sessionId) {
          try {
            const roster = await agentPresets.list()
            if (!roster.ok) throw new Error(roster.error.message)
            const available = roster.value.presets.filter((preset) => preset.broken === undefined)
            const wanted = available.find((preset) => preset.id === VOICE_PRESET_ID)
              ?? available.find((preset) => preset.id === 'minimal')
            if (wanted === undefined) {
              // No chat-only preset exists in this composition; the call still
              // runs, only slower.
              store.set({ preset: null })
              return
            }
            // This is the raw Remote namespace, so the reply is a RemoteResult
            // wrapper rather than the value; the committed identity is inside.
            const applied = await agentPresets.select(sessionId, wanted.id)
            if (!applied.ok) throw new Error(applied.error.message)
            const selected = applied.value
            store.set({ preset: wanted.id })
            // A mismatch means the Host committed a different preset than the one
            // asked for, which changes what the call can do; anything else is the
            // expected echo of the request.
            if (selected !== wanted.id) store.set({ notice: { key: 'notice.presetMismatch', params: { requested: wanted.id, selected } } })
          } catch (error) {
            // The default preset keeps working; report why the fast path did not.
            store.set({ preset: null, notice: { key: 'notice.presetFailed', params: { message: String(error?.message ?? error) } } })
          }
        }

        /**
         * The Session an earlier call used, when one still exists.
         *
         * Reusing it is what keeps repeated calls from filling the sidebar with
         * one conversation per call. Only a blank Session is reusable: one that
         * already has turns has its own history, and its preset is locked.
         *
         * @returns the existing call Session's id, or null when there is none.
         */
        function existingCallSession() {
          const list = sessions.list.getSnapshot()
          if (list.phase !== 'ready') return null
          for (const id of list.ids) {
            const row = list.byId[id]
            if (row === undefined) continue
            // A call Session carries the voice preset; a run under any other
            // preset is somebody else's conversation.
            if (list.projectionsBySession[id]?.values?.agentPreset !== VOICE_PRESET_ID) continue
            if (row.blank !== true) continue
            return id
          }
          return null
        }

        return {
          /**
           * Start a call in a fresh, fast conversation.
           *
           * A blank voice-call Session left by an earlier call is reused, so
           * repeated calls do not accumulate conversations. Otherwise one is
           * created, bound to the tool-free voice preset and the fastest route,
           * and opened before the call screen appears, so the first utterance
           * has somewhere to go and the agent is already warm.
           */
          async begin() {
            if (store.getSnapshot().phase !== 'idle') return
            const run = ++generation
            store.set({ phase: 'calling', sessionId: null, title: t('call.newTitle'), lines: [], notice: null,
              activity: 'idle', elapsed: 0, level: 0, mouth: 0, muted: false, device: '', route: null, preset: null, startedAt: Date.now() })
            lifetime = new AbortController()
            ready = deferred()
            try {
              const sessionId = existingCallSession() ?? await createSession({})
              // A hang-up or a newer call advances the generation; this attempt
              // must then stop without touching the store or the Session.
              if (generation !== run) return
              store.set({ sessionId, phase: 'incoming' })
              openSession(sessionId)
              // The preset must land before the first turn, so it is awaited;
              // the model choice only affects speed, so it is not.
              await useVoicePreset(sessionId)
              if (generation !== run) return
              // Awaited by `send`, so the first utterance cannot outrun it.
              routeReady = useFastRoute(sessionId)
            } catch (error) {
              if (generation !== run) return
              store.set({ phase: 'idle', notice: { key: 'notice.newCallFailed', params: { message: String(error?.message ?? error) } } })
            }
          },
          /** Draw the incoming-call screen for one session without connecting yet. */
          ring(sessionId, title) {
            // A fresh controller per call: hang-up aborts the previous one, so
            // reusing it would leave the next call with a pre-aborted signal.
            lifetime = new AbortController()
            ready = deferred()
            generation += 1
            store.set({
              phase: 'incoming', sessionId, title, lines: [], notice: null, activity: 'idle',
              elapsed: 0, level: 0, mouth: 0, muted: false, device: '', startedAt: Date.now(),
            })
          },
          /** Answer the ringing call. */
          accept() {
            if (store.getSnapshot().phase !== 'incoming') return
            store.set({ phase: 'active', startedAt: Date.now() })
            void connect()
          },
          /** End the call and release the microphone, playback, and stream. */
          hangUp() {
            generation += 1
            clearInterval(elapsedTimer)
            elapsedTimer = undefined
            // Release a send still waiting for the stream's opening snapshot.
            ready.reject(new Error('call ended'))
            lifetime.abort(new Error('call ended'))
            disarmDeadline()
            if (audio) { audio.pause(); audio.src = '' }
            audio = undefined
            const releasing = capture
            capture = undefined
            void releasing?.stop()
            store.set({
              phase: 'idle', sessionId: null, title: '', lines: [], notice: null,
              activity: 'idle', elapsed: 0, level: 0, mouth: 0, muted: false, device: '',
            })
          },
          /** Toggle microphone capture without dropping the call. */
          toggleMute() {
            const muted = !store.getSnapshot().muted
            capture?.setSuspended(muted)
            store.set({ muted })
          },
          /** Wait for the bridge to settle; used by the plugin's dispose hook. */
          async dispose() { await loop?.catch(() => undefined) },
        }
      }

      /** Format a call duration as mm:ss. */
      function clock(seconds) {
        const minutes = Math.floor(seconds / 60)
        const rest = seconds % 60
        return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
      }

      /** One round control: an accessible button with an inline SVG glyph. */
      function RoundButton(props) {
        return h('button', {
          type: 'button',
          className: `dvc-round dvc-${props.tone}`,
          onClick: props.onClick,
          'aria-label': props.label,
          title: props.label,
        }, props.children)
      }

      /** The avatar with its live speaking ring. */
      function Avatar(props) {
        const hue = hueOf(props.sessionId ?? 'voice-call')
        // Computed before the effects: they read it, and a `const` declared after
        // them would throw a temporal-dead-zone error on first render.
        // A photograph whose mouth moves wins over everything else: it is the
        // only option that is both the person in the picture AND not a
        // stretched image.
        const hasPortrait = props.portrait === true && props.live === true
        const level = props.level ?? 0
        const activity = props.activity

        const showFigure = hasPortrait && props.live === true
        const fallback = props.avatar === true
          ? h('img', { className: 'dvc-avatar dvc-avatar-img', src: props.avatarSrc, alt: '' })
          : h('span', {
              className: 'dvc-avatar',
              style: { background: `linear-gradient(150deg, hsl(${hue} 72% 58%), hsl(${(hue + 42) % 360} 68% 42%))` },
            }, initialOf(props.title))
        if (showFigure) {
          // The animator owns the picture; the panel is just a frame around it.
          return h('div', { className: 'dvc-figure-wrap' },
            h(PortraitFigure, { activity, level: props.mouth ?? level, title: props.title }),
            h('span', { className: 'dvc-figure-ring', 'data-active': activity === 'speaking' ? 'true' : undefined }))
        }
        return h('div', { className: 'dvc-avatar-wrap' },
          h('span', { className: 'dvc-ring', 'data-active': activity === 'speaking' ? 'true' : undefined }),
          h('span', { className: 'dvc-ring dvc-ring-late', 'data-active': activity === 'speaking' ? 'true' : undefined }),
          fallback,
        )
      }


      /** The frame-wide call overlay; renders nothing while no call is live. */
      function VoiceCallOverlay(props) {
        const { call, t } = props
        const state = useSyncExternalStore(call.subscribe, call.getSnapshot, call.getSnapshot)
        // The call picture is a deployment setting rather than call state, so it
        // is read when a call opens: a picture changed in Settings then applies
        // to the next call without a reload, and the overlay stays independent of
        // the settings page's own store.
        const [avatar, setAvatar] = useState({ set: false, src: '' })
        // The relief mesh for the same picture, when the Host could build one.
        // Null means the flat picture stands, which is what happens with no
        // picture, with the feature switched off, or on a machine without the
        // depth model.
        const [relief, setRelief] = useState(null)
        // A mesh the renderer could not use, so the picture stands instead of a
        // blank canvas. Set when WebGL is missing or the shader will not build.
        const [reliefBroken, setReliefBroken] = useState(false)
        // Whether the Host can animate the picture's mouth. It is a separate
        // engine with its own environment, so it is asked rather than assumed.
        const [portraitSet, setPortraitSet] = useState(false)
        const phase = state.phase
        useEffect(() => {
          if (phase === 'idle') return undefined
          let live = true
          void (async () => {
            try {
              // The avatar is the small round thumbnail: the active character's
              // picture when it has one, otherwise the deployment's own.
              const response = await fetch('/.dsh-voice-call/call-avatar', { method: 'HEAD' })
              if (!live || !response.ok) return
              const type = response.headers.get('x-avatar')
              if (type === null || type === 'none') { setAvatar({ set: false, src: '' }); return }
              setAvatar({ set: true, src: `/.dsh-voice-call/call-avatar?rev=${String(Date.now())}` })
            } catch { /* no picture is the same as an unreadable one */ }
          })()
          return () => { live = false }
        }, [phase])
        useEffect(() => {
          if (phase === 'idle') return undefined
          let live = true
          void (async () => {
            try {
              const response = await fetch('/.dsh-voice-call/portrait', { method: 'HEAD' })
              if (!live || !response.ok) return
              setPortraitSet(response.headers.get('x-portrait') === 'ready')
            } catch { /* no animator means the picture stands */ }
          })()
          return () => { live = false }
        }, [phase])
        // The mesh is fetched once per call, from the same effective picture.
        // Decoding 500 KB of geometry on every phase change would stall the
        // animation, so the decoded form is kept and reused.
        useEffect(() => {
          if (phase === 'idle') { setRelief(null); return undefined }
          let live = true
          void (async () => {
            try {
              const response = await fetch('/.dsh-voice-call/relief')
              if (!live || !response.ok) return
              const body = await response.json()
              if (body.relief === null) return
              setRelief({
                grid: body.relief.grid,
                position: decodeReliefField(body.relief.position),
                color: decodeReliefField(body.relief.color),
                index: decodeReliefField(body.relief.index),
                face: body.relief.face ?? null,
              })
            } catch { /* the flat picture stands */ }
          })()
          return () => { live = false }
        }, [phase])
        if (state.phase === 'idle') return null
        const hint = state.muted && state.phase === 'active' ? t('hint.muted')
          : state.activity === 'speaking' ? t('hint.speaking')
            : state.activity === 'transcribing' ? t('hint.transcribing')
              : state.activity === 'thinking' ? t('hint.thinking')
                : state.phase === 'incoming' ? t('hint.accept')
                  : state.phase === 'calling' ? t('hint.connecting')
                    : t('hint.listening')
        return h('div', {
          className: 'dvc-root',
          'data-phase': state.phase,
          // Inline, not only in CSS: the overlay layer's own `> *` rule turns
          // pointer events back on for every entry, and this surface must stay
          // click-through except for the card.
          style: { pointerEvents: 'none' },
        },
          h('style', null, CSS),
          h('div', { className: 'dvc-card', role: 'dialog', 'aria-label': t('phase.active') },
            h('div', { className: 'dvc-phase' }, t(`phase.${state.phase}`)),
            h(Avatar, {
              title: state.title, sessionId: state.sessionId, activity: state.activity,
              avatar: avatar.set, avatarSrc: avatar.src,
              // The mesh, unless the renderer already failed on this call -- in
              // which case the picture stands rather than a blank canvas.
              relief: reliefBroken ? null : relief,
              // A photo whose mouth moves wins over the stretched relief.
              portrait: portraitSet,
              // The same loudness the meter shows, which is what makes the
              // mouth match the sound the user actually hears.
              level: state.level,
              // The mouth follows a smoothed envelope; the meter keeps the raw
              // level so it stays responsive.
              mouth: state.mouth,
              // The figure takes over from the round thumbnail once the call is
              // live: before that there is nothing to watch.
              live: state.phase === 'active',
              onReliefFailed: () => { setReliefBroken(true) },
            }),
            h('div', { className: 'dvc-title' }, state.title || state.sessionId),
            h('div', { className: 'dvc-hint' }, hint),
            state.phase === 'active' && h('div', { className: 'dvc-meter' },
              h('span', { style: { transform: `scaleX(${String(Math.min(1, state.level * 14))})` } })),
            state.phase === 'active' && h('div', { className: 'dvc-clock' }, clock(state.elapsed)),
            state.phase === 'active' && state.device !== '' && h('div', { className: 'dvc-device', title: state.device },
              t('hint.device', { name: state.device })),
            state.phase === 'active' && state.route !== null && h('div', { className: 'dvc-device', title: state.route },
              t('hint.route', { name: state.route })),
            state.notice && h('div', { className: 'dvc-notice', role: 'status' },
              t(state.notice.key, state.notice.params)),
            h(Lines, { lines: state.lines, t }),
            h('div', { className: 'dvc-actions' },
              state.phase === 'incoming'
                ? [
                  h(RoundButton, { key: 'accept', tone: 'accept', label: t('action.accept'), onClick: () => { call.accept() } }, h(IconPhone, null)),
                  h(RoundButton, { key: 'decline', tone: 'hangup', label: t('action.decline'), onClick: () => { call.hangUp() } }, h(IconPhoneDown, null)),
                ]
                : [
                  state.phase === 'active' && h(RoundButton, {
                    key: 'mute', tone: state.muted ? 'muted' : 'neutral',
                    label: t(state.muted ? 'action.unmute' : 'action.mute'),
                    onClick: () => { call.toggleMute() },
                  }, h(state.muted ? IconMicOff : IconMic)),
                  h(RoundButton, { key: 'hangup', tone: 'hangup', label: t('action.hangUp'), onClick: () => { call.hangUp() } }, h(IconPhoneDown, null)),
                ].filter(Boolean),
            ),
          ),
        )
      }

      /** Spoken-transcript bubbles, newest last. */
      function Lines(props) {
        const box = useRef(null)
        useEffect(() => {
          const node = box.current
          if (node) node.scrollTop = node.scrollHeight
        }, [props.lines])
        if (props.lines.length === 0) return null
        return h('div', { className: 'dvc-lines', ref: box },
          props.lines.slice(-8).map((line, index) => h('div', {
            key: `${String(index)}-${line.role}`,
            className: 'dvc-line',
            'data-role': line.role,
          }, h('span', { className: 'dvc-line-who' }, props.t(line.role === 'you' ? 'you' : 'agent')), line.text)),
        )
      }

      /**
       * Sidebar-foot control that starts a call in a fresh, fast conversation.
       *
       * It sits above Settings. Placing a call always begins a new Session so a
       * call never mixes into an unrelated thread, and that Session is switched
       * to the fastest available route before the first word is spoken.
       */
      function VoiceCallButton(props) {
        const { call, t, wide } = props
        const state = useSyncExternalStore(call.subscribe, call.getSnapshot, call.getSnapshot)
        const start = useCallback(() => { call.begin() }, [call])
        // The rail renders icons only, so the label rides the accessible name.
        return h('button', {
          type: 'button',
          className: wide ? 'dvc-foot' : 'dvc-foot dvc-foot-rail',
          onClick: start,
          disabled: state.phase !== 'idle',
          'aria-label': t('action.call'),
          title: t('action.call'),
        }, h(IconPhone, null), wide && h('span', { className: 'dvc-foot-label' }, t('action.call')))
      }

      /**
       * Characters controller.
       *
       * A character bundles a personality, a voice, and a picture, so choosing
       * one chooses how a call behaves, sounds, and looks in a single action.
       * The roster is Host state: this store only mirrors it and forwards edits.
       *
       * @param t - namespace-bound translator.
       * @returns the roster store and its actions.
       */
      function createCharacters(t) {
        const store = createStore({
          loading: true,
          error: null,
          characters: [],
          activeId: '',
          settingsRate: 1,
          voices: [],
          cloudVoices: [],
          /** Id of the character open for editing, or '' for the roster. */
          editing: '',
          /** The draft being edited, so typing does not write on every keystroke. */
          draft: null,
          saving: false,
          notice: null,
        })
        const read = async () => {
          try {
            const response = await fetch('/.dsh-voice-call/characters')
            if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
            const body = await response.json()
            store.set({
              loading: false,
              error: null,
              characters: body.characters ?? [],
              activeId: body.activeCharacter ?? '',
              settingsRate: typeof body.settingsRate === 'number' ? body.settingsRate : 1,
              voices: body.voices ?? [],
              cloudVoices: body.cloudVoices ?? [],
            })
          } catch (error) {
            store.set({ loading: false, error: String(error?.message ?? error) })
          }
        }
        /**
         * Send one request and report the outcome in the store.
         * @param path - route path.
         * @param method - HTTP method.
         * @param body - JSON body, when the request has one.
         * @returns the parsed reply, or null on failure.
         */
        const send = async (path, method, body) => {
          store.set({ saving: true, notice: null })
          try {
            const response = await fetch(path, {
              method,
              ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
            })
            const parsed = await response.json().catch(() => null)
            if (!response.ok) throw new Error(parsed?.error ?? `HTTP ${String(response.status)}`)
            store.set({ saving: false })
            return parsed
          } catch (error) {
            store.set({ saving: false, notice: { key: 'characters.failed', params: { message: String(error?.message ?? error) } } })
            return null
          }
        }
        // Built as a named object so `save` can reach its own siblings: it
        // uploads a staged picture through the same action the UI would use.
        const api = {
          store, read, send,
          /** Start a new character from the current voice settings. */
          beginCreate: () => store.set({ editing: 'new', draft: { name: '', personality: '', voice: { engine: '', localVoiceId: '', cloudVoice: '', cloneId: '', rate: null }, image: null, imagePreview: '', imageRemoved: false } }),
          /** Open one character for editing. */
          beginEdit: (character) => store.set({ editing: character.id, draft: { name: character.name, personality: character.personality, voice: { ...character.voice, rate: character.voice?.rate ?? null }, image: null, imagePreview: '', imageRemoved: false } }),
          /** Leave the editor without saving. */
          cancelEdit: () => store.set({ editing: '', draft: null }),
          /** Change one draft field. */
          setDraft: (patch) => store.set({ draft: { ...store.getSnapshot().draft, ...patch } }),
          /** Change one draft voice field. */
          setDraftVoice: (patch) => store.set({ draft: { ...store.getSnapshot().draft, voice: { ...store.getSnapshot().draft.voice, ...patch } } }),
          /**
           * Stage a picture for this character.
           *
           * Staged rather than uploaded at once: a character being created has no
           * id yet, so there is nothing to attach the picture to. The save
           * uploads it once the record exists.
           *
           * @param file - the chosen image.
           * @param preview - a data URL for the preview, read by the caller.
           */
          setDraftImage: (file, preview) => store.set({ draft: { ...store.getSnapshot().draft, image: file, imagePreview: preview, imageRemoved: false } }),
          /** Drop the picture, either one just staged or the stored one. */
          clearDraftImage: () => store.set({ draft: { ...store.getSnapshot().draft, image: null, imagePreview: '', imageRemoved: true } }),
          /** Write the draft, creating or updating as the editor was opened. */
          save: async () => {
            const { editing, draft } = store.getSnapshot()
            if (draft === null) return
            const payload = { name: draft.name, personality: draft.personality, voice: draft.voice }
            const result = editing === 'new'
              ? await send('/.dsh-voice-call/characters', 'POST', payload)
              : await send(`/.dsh-voice-call/characters/${encodeURIComponent(editing)}`, 'PATCH', payload)
            if (result === null) return
            // The picture is attached now that the character has an id. A
            // failure here must not lose the fields that were just saved, so it
            // is reported on its own and the roster still refreshes.
            const id = result.character?.id ?? editing
            if (draft.image !== null) await api.uploadAvatar(id, draft.image)
            else if (draft.imageRemoved) await api.removeAvatar(id)
            store.set({ editing: '', draft: null, notice: { key: 'characters.saved' } })
            await read()
          },
          /** Delete one character. */
          remove: async (id) => {
            const result = await send(`/.dsh-voice-call/characters/${encodeURIComponent(id)}`, 'DELETE')
            if (result === null) return
            await read()
          },
          /** Make one character the one calls are placed as. */
          activate: async (id) => {
            const result = await send('/.dsh-voice-call/active-character', 'POST', { id })
            if (result === null) return
            store.set({ activeId: result.activeCharacter })
            await read()
          },
          /** Remove one character's stored picture. */
          removeAvatar: async (id) => {
            try {
              await fetch(`/.dsh-voice-call/characters/${encodeURIComponent(id)}/avatar`, { method: 'DELETE' })
            } catch { /* a picture that cannot be removed is reported by the roster refresh */ }
          },
          /** Upload one character's picture. */
          uploadAvatar: async (id, file) => {
            store.set({ saving: true, notice: null })
            try {
              const response = await fetch(`/.dsh-voice-call/characters/${encodeURIComponent(id)}/avatar`, {
                method: 'POST',
                headers: { 'content-type': file.type || 'image/png' },
                body: await file.arrayBuffer(),
              })
              if (!response.ok) {
                const parsed = await response.json().catch(() => null)
                throw new Error(parsed?.error ?? `HTTP ${String(response.status)}`)
              }
              store.set({ saving: false, notice: { key: 'characters.avatarOk' } })
              await read()
            } catch (error) {
              store.set({ saving: false, notice: { key: 'characters.failed', params: { message: String(error?.message ?? error) } } })
            }
          },
        }
        return api
      }

      /**
       * Voice settings controller.
       *
       * One Host read fills the page; every change writes back immediately, so
       * there is no separate save step to forget. The Host owns the values and
       * the speech path reads the same state, which is why a change here takes
       * effect on the next call rather than on the next restart.
       *
       * @param ctx - Client plugin context.
       * @param t - namespace-bound translator.
       * @returns the settings store and its actions.
       */
      function createVoiceSettings(ctx, t) {
        const store = createStore({
          loading: true,
          error: null,
          rate: 1,
          localVoiceId: '',
          cloudVoice: '',
          cloneId: '',
          cloudFallback: true,
          /** Whether the picture's mouth is animated rather than shown flat. */
          portrait: false,
          voices: [],
          cloudVoices: [],
          saving: false,
          notice: null,
          /** Whether a custom avatar is stored; the bytes are fetched separately. */
          avatarSet: false,
          /** A cache-busting token, so a replaced picture is not served from cache. */
          avatarRev: 0,
          /**
           * The picture the 3D figure is built from, which is its own slot: the
           * avatar is a thumbnail, the figure wants a face-filling crop, so they
           * are chosen apart. When no figure is set the avatar stands in.
           */
          figureSet: false,
          /** Whether the figure has its own picture rather than borrowing the avatar. */
          figureOwn: false,
          figureRev: 0,
        })
        const write = async (patch) => {
          store.set({ saving: true, notice: null })
          try {
            const response = await fetch('/.dsh-voice-call/settings', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(patch),
            })
            if (!response.ok) {
              const body = await response.json().catch(() => null)
              throw new Error(body?.error ?? `HTTP ${String(response.status)}`)
            }
            const body = await response.json()
            store.set({ ...body.settings, saving: false, notice: { key: 'settings.saved' } })
          } catch (error) {
            store.set({ saving: false, notice: { key: 'settings.saveFailed', params: { message: String(error?.message ?? error) } } })
          }
        }
        /** Drop the stored picture and fall back to the generated avatar. */
        /**
         * Read whether a figure picture is set, and whether it is its own.
         * @returns the figure state, to merge into the store.
         */
        const readFigureState = async () => {
          try {
            const response = await fetch('/.dsh-voice-call/figure', { method: 'HEAD' })
            if (!response.ok) return { figureSet: false, figureOwn: false, figureRev: Date.now() }
            const type = response.headers.get('x-figure')
            if (type === null || type === 'none') return { figureSet: false, figureOwn: false, figureRev: Date.now() }
            return { figureSet: true, figureOwn: response.headers.get('x-figure-source') === 'own', figureRev: Date.now() }
          } catch {
            return { figureSet: false, figureOwn: false, figureRev: Date.now() }
          }
        }

        const load = async () => {
          store.set({ loading: true, error: null })
          try {
            const response = await fetch('/.dsh-voice-call/voices')
            if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
            const body = await response.json()
            store.set({
              loading: false,
              voices: body.voices ?? [],
              cloudVoices: body.cloudVoices ?? [],
              avatarSet: await readAvatarState(),
              ...(await readFigureState()),
              ...body.settings,
            })
          } catch (error) {
            store.set({ loading: false, error: String(error?.message ?? error) })
          }
        }
        /**
         * Upload one recording and make it the selected voice.
         *
         * The recording is sent as raw WAV bytes rather than a form, because
         * the browser already produces exactly the format the Host validates.
         * @param file - the chosen recording.
         * @param name - display name for the new voice.
         */
        const clone = async (file, name) => {
          store.set({ saving: true, notice: null })
          try {
            const response = await fetch(`/.dsh-voice-call/clone?name=${encodeURIComponent(name)}`, {
              method: 'POST',
              headers: { 'content-type': 'audio/wav' },
              body: await file.arrayBuffer(),
            })
            const body = await response.json().catch(() => null)
            if (!response.ok) throw new Error(body?.error ?? `HTTP ${String(response.status)}`)
            await load()
            await write({ cloneId: body.voice.id })
            // Say when the recording was converted, so a user who uploaded an
            // MP3 knows it was understood rather than silently altered.
            store.set({ notice: { key: body.converted === true ? 'settings.cloneConverted' : 'settings.cloneOk', params: { name: body.voice.name } } })
          } catch (error) {
            store.set({ saving: false, notice: { key: 'settings.cloneFailed', params: { message: String(error?.message ?? error) } } })
          }
        }
        /**
         * Delete one cloned voice and its recording.
         *
         * The Host clears the selection when it deleted the voice that was in
         * use, so the reload below shows the resolved fallback rather than a
         * voice that no longer exists.
         *
         * @param id - clone id.
         * @param name - display name, for the confirmation and the notice.
         */
        const removeVoice = async (id, name) => {
          store.set({ saving: true, notice: null })
          try {
            const response = await fetch(`/.dsh-voice-call/voices/${encodeURIComponent(id)}`, { method: 'DELETE' })
            const body = await response.json().catch(() => null)
            if (!response.ok) throw new Error(body?.error ?? `HTTP ${String(response.status)}`)
            await load()
            store.set({ saving: false, notice: { key: 'settings.voiceRemoved', params: { name } } })
          } catch (error) {
            store.set({ saving: false, notice: { key: 'settings.cloneFailed', params: { message: String(error?.message ?? error) } } })
          }
        }
        /**
         * Upload one image as the call picture.
         *
         * The bytes go up with their media type in the header rather than as a
         * form, because the route takes a single field and a multipart body
         * would only add a parser on both sides.
         * @param file - the chosen image.
         */
        const uploadAvatar = async (file) => {
          store.set({ saving: true, notice: null })
          try {
            const response = await fetch('/.dsh-voice-call/avatar', {
              method: 'POST',
              headers: { 'content-type': file.type || 'image/png' },
              body: await file.arrayBuffer(),
            })
            if (!response.ok) {
              const body = await response.json().catch(() => null)
              throw new Error(body?.error ?? `HTTP ${String(response.status)}`)
            }
            // A new picture must not be answered from the browser's cache.
            store.set({ saving: false, avatarSet: true, avatarRev: Date.now(), notice: { key: 'settings.avatarOk' } })
          } catch (error) {
            store.set({ saving: false, notice: { key: 'settings.avatarFailed', params: { message: String(error?.message ?? error) } } })
          }
        }
        /**
         * Upload the picture the 3D figure is built from.
         * @param file - the chosen image.
         */
        const uploadFigure = async (file) => {
          store.set({ saving: true, notice: null })
          try {
            const response = await fetch('/.dsh-voice-call/figure', {
              method: 'POST',
              headers: { 'content-type': file.type || 'image/png' },
              body: await file.arrayBuffer(),
            })
            if (!response.ok) {
              const body = await response.json().catch(() => null)
              throw new Error(body?.error ?? `HTTP ${String(response.status)}`)
            }
            store.set({ saving: false, ...(await readFigureState()), notice: { key: 'settings.figureOk' } })
          } catch (error) {
            store.set({ saving: false, notice: { key: 'settings.figureFailed', params: { message: String(error?.message ?? error) } } })
          }
        }
        const clearFigure = async () => {
          store.set({ saving: true, notice: null })
          try {
            await fetch('/.dsh-voice-call/figure', { method: 'DELETE' })
            store.set({ saving: false, ...(await readFigureState()), notice: { key: 'settings.figureCleared' } })
          } catch (error) {
            store.set({ saving: false, notice: { key: 'settings.figureFailed', params: { message: String(error?.message ?? error) } } })
          }
        }
        const clearAvatar = async () => {
          store.set({ saving: true, notice: null })
          try {
            const response = await fetch('/.dsh-voice-call/avatar', { method: 'DELETE' })
            if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
            store.set({ saving: false, avatarSet: false, avatarRev: Date.now(), notice: { key: 'settings.avatarCleared' } })
          } catch (error) {
            store.set({ saving: false, notice: { key: 'settings.avatarFailed', params: { message: String(error?.message ?? error) } } })
          }
        }
        return { store, load, write, clone, removeVoice, uploadAvatar, clearAvatar, uploadFigure, clearFigure }
      }

      /**
       * Whether a custom call picture is stored.
       *
       * The route answers 200 either way and reports the type in `x-avatar`, so
       * the header decides: `ok` alone would report every call as having a
       * picture and draw a preview for a file that does not exist.
       * @returns whether an avatar is stored.
       */
      async function readAvatarState() {
        try {
          const response = await fetch('/.dsh-voice-call/avatar', { method: 'HEAD' })
          if (!response.ok) return false
          const type = response.headers.get('x-avatar')
          return type !== null && type !== 'none'
        } catch {
          return false
        }
      }

      /**
       * A photograph whose mouth moves with the audio.
       *
       * LivePortrait rebuilds each frame from the source picture, so the person
       * on screen stays the person in the photograph. That is the point: a VRM
       * is smooth but is somebody else, and the photo relief stretches pixels.
       *
       * Frames are **pulled**, not pushed: the browser asks for the next frame
       * when it has painted the last one. A slow GPU therefore throttles the
       * animation instead of building a queue of stale frames, which is what
       * makes a 10 fps engine usable at all.
       *
       * The engine is only asked to work while the figure is speaking. Silence
       * costs nothing: the last frame simply stays on screen.
       *
       * @param props - the call's phase, activity, level, and title.
       * @returns The portrait frame, or null while it loads.
       */
      function PortraitFigure(props) {
        const [src, setSrc] = useState('')
        const [failed, setFailed] = useState(false)
        const busy = useRef(false)
        const alive = useRef(true)
        const levelRef = useRef(0)
        levelRef.current = props.level ?? 0
        const speaking = props.activity === 'speaking'
        const speakingRef = useRef(speaking)
        speakingRef.current = speaking

        useEffect(() => {
          alive.current = true
          const loop = async () => {
            while (alive.current) {
              // Nothing to animate while the figure is quiet, so wait rather
              // than spending the GPU on a still image.
              if (!speakingRef.current) {
                await new Promise((r) => setTimeout(r, 120))
                continue
              }
              if (busy.current) { await new Promise((r) => setTimeout(r, 16)); continue }
              busy.current = true
              const started = performance.now()
              try {
                const response = await fetch('/.dsh-voice-call/portrait/frame', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  // Already mapped by the capture; the engine's useful range
                  // runs above 1, so it is not clamped to 1 here.
                  body: JSON.stringify({ open: Math.max(0, levelRef.current) }),
                })
                if (!alive.current) break
                if (!response.ok) { setFailed(true); break }
                const body = await response.json()
                if (body.frame === undefined) { setFailed(true); break }
                setSrc(`data:image/jpeg;base64,${body.frame}`)
              } catch {
                if (alive.current) setFailed(true)
                break
              } finally {
                busy.current = false
              }
              // Yield to the browser so the frame paints before the next one is
              // requested; without this the loop starves the render.
              await new Promise((r) => setTimeout(r, 8))
            }
          }
          void loop()
          return () => { alive.current = false }
        }, [])

        if (failed) return h('img', { className: 'dvc-portrait', src: `/.dsh-voice-call/figure`, alt: props.title ?? '' })
        if (src === '') return h('div', { className: 'dvc-portrait dvc-portrait-wait' })
        return h('img', { className: 'dvc-portrait', src, alt: props.title ?? '' })
      }

      /**
       * Render the voice settings page.
       * @param props - settings section props plus the injected controller.
       * @returns The voice settings section.
       */
      function VoiceSettingsSection({ settings, characters, t }) {
        const state = useSyncExternalStore(settings.store.subscribe, settings.store.getSnapshot, settings.store.getSnapshot)
        const [name, setName] = useState('')
        const [file, setFile] = useState(null)
        const [image, setImage] = useState(null)
        const [figure, setFigure] = useState(null)
        useEffect(() => { void settings.load() }, [settings])
        // The characters block is its own controller, so it loads itself.
        useEffect(() => { void characters.read() }, [characters])
        const pick = (event) => { setFile(event.target.files?.[0] ?? null) }
        const pickImage = (event) => { setImage(event.target.files?.[0] ?? null) }
        const pickFigure = (event) => { setFigure(event.target.files?.[0] ?? null) }
        const local = state.voices.filter((voice) => voice.engine === 'piper')
        const clones = state.voices.filter((voice) => voice.engine === 'clone')
        const selected = state.cloneId !== '' ? state.cloneId : state.localVoiceId
        const choose = (id) => {
          const isClone = clones.some((voice) => voice.id === id)
          void settings.write(isClone ? { cloneId: id, localVoiceId: '' } : { localVoiceId: id, cloneId: '' })
        }
        if (state.loading) return h('div', { className: 'dvc-set' }, h('p', { className: 'dvc-set-note' }, t('settings.loading')))
        if (state.error !== null) {
          return h('div', { className: 'dvc-set' },
            h('p', { className: 'dvc-set-error' }, t('settings.loadFailed', { message: state.error })))
        }
        return h('div', { className: 'dvc-set' },
          h('style', null, SETTINGS_CSS),
          h('p', { className: 'dvc-set-intro' }, t('settings.intro')),
          // Speaking rate.
          h('section', { className: 'dvc-set-block' },
            h('label', { className: 'dvc-set-label', htmlFor: 'dvc-rate' },
              t('settings.rate'), h('output', { className: 'dvc-set-value' }, state.rate.toFixed(2))),
            h('input', {
              id: 'dvc-rate', className: 'dvc-set-range', type: 'range', min: '0.5', max: '2', step: '0.05',
              value: String(state.rate),
              onChange: (event) => { void settings.write({ rate: Number(event.target.value) }) },
            }),
            h('p', { className: 'dvc-set-note' }, t('settings.rateHint'))),
          // Local and cloned voices.
          h('section', { className: 'dvc-set-block' },
            h('span', { className: 'dvc-set-label' }, t('settings.engine')),
            h('p', { className: 'dvc-set-note' }, t('settings.engineHint')),
            h('div', { className: 'dvc-set-group' }, t('settings.localGroup')),
            local.length === 0
              ? h('p', { className: 'dvc-set-note' }, t('settings.noLocal'))
              : h('div', { className: 'dvc-set-choices' }, local.map((voice) => h('button', {
                  key: voice.id, type: 'button',
                  className: selected === voice.id ? 'dvc-set-choice dvc-set-on' : 'dvc-set-choice',
                  onClick: () => { choose(voice.id) },
                }, voice.name))),
            h('div', { className: 'dvc-set-group' }, t('settings.cloneGroup')),
            clones.length === 0
              ? h('p', { className: 'dvc-set-note' }, t('settings.noClone'))
              // Each cloned voice gets its own remove control. A wrapper is used
              // rather than nesting one button in another, which is invalid HTML
              // and would make the inner click ambiguous.
              : h('div', { className: 'dvc-set-choices' }, clones.map((voice) => h('span', {
                  key: voice.id, className: 'dvc-set-pair',
                },
                h('button', {
                  type: 'button',
                  className: selected === voice.id ? 'dvc-set-choice dvc-set-on' : 'dvc-set-choice',
                  onClick: () => { choose(voice.id) },
                }, voice.name),
                h('button', {
                  type: 'button', className: 'dvc-set-drop',
                  disabled: state.saving,
                  title: t('settings.voiceRemove'),
                  'aria-label': `${t('settings.voiceRemove')}: ${voice.name}`,
                  onClick: () => {
                    if (window.confirm(t('settings.voiceRemoveConfirm', { name: voice.name }))) {
                      void settings.removeVoice(voice.id, voice.name)
                    }
                  },
                }, '\u00d7'))))),
          // Cloud voice.
          h('section', { className: 'dvc-set-block' },
            h('label', { className: 'dvc-set-label', htmlFor: 'dvc-cloud' }, t('settings.cloudVoice')),
            h('select', {
              id: 'dvc-cloud', className: 'dvc-set-select', value: state.cloudVoice,
              onChange: (event) => { void settings.write({ cloudVoice: event.target.value }) },
            }, state.cloudVoices.map((voice) => h('option', { key: voice.id, value: voice.id }, voice.name))),
            h('p', { className: 'dvc-set-note' }, t('settings.cloudHint'))),
          // Whether the cloud may stand in for a local failure.
          h('section', { className: 'dvc-set-block' },
            h('label', { className: 'dvc-set-switch', htmlFor: 'dvc-fallback' },
              h('input', {
                id: 'dvc-fallback', type: 'checkbox', checked: state.cloudFallback,
                onChange: (event) => { void settings.write({ cloudFallback: event.target.checked }) },
              }),
              h('span', { className: 'dvc-set-label' }, t('settings.fallback'))),
            h('p', { className: 'dvc-set-note' },
              t(state.cloudFallback ? 'settings.fallbackOn' : 'settings.fallbackOff'))),
          // Whether the picture is animated, as opposed to shown flat.
          h('section', { className: 'dvc-set-block' },
            h('label', { className: 'dvc-set-switch', htmlFor: 'dvc-portrait' },
              h('input', {
                id: 'dvc-portrait', type: 'checkbox', checked: state.portrait,
                onChange: (event) => { void settings.write({ portrait: event.target.checked }) },
              }),
              h('span', { className: 'dvc-set-label' }, t('settings.portrait'))),
            h('p', { className: 'dvc-set-note' },
              t(state.portrait ? 'settings.portraitOn' : 'settings.portraitOff'))),
          // The call picture.
          h('section', { className: 'dvc-set-block' },
            h('span', { className: 'dvc-set-label' }, t('settings.avatar')),
            h('p', { className: 'dvc-set-note' }, t('settings.avatarHint')),
            h('div', { className: 'dvc-set-row' },
              state.avatarSet
                // The revision is appended so a replaced picture is refetched
                // rather than answered from the browser's cache.
                ? h('img', {
                    className: 'dvc-set-avatar',
                    src: `/.dsh-voice-call/avatar?rev=${String(state.avatarRev)}`,
                    alt: t('settings.avatar'),
                  })
                : null,
              h('label', { className: 'dvc-set-file' },
                h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', onChange: pickImage }),
                image === null ? t('settings.avatarChoose') : image.name),
              h('button', {
                type: 'button', className: 'dvc-set-primary',
                disabled: image === null || state.saving,
                onClick: () => { if (image !== null) void settings.uploadAvatar(image) },
              }, state.saving ? t('settings.avatarWorking') : t('settings.avatarUpload')),
              state.avatarSet
                ? h('button', {
                    type: 'button', className: 'dvc-set-quiet',
                    disabled: state.saving,
                    onClick: () => { void settings.clearAvatar() },
                  }, t('settings.avatarClear'))
                : null)),
          // The 3D figure's own picture. Separate from the avatar above because
          // the two want different crops: a thumbnail reads at 88px, while the
          // figure needs the face filling the frame to have anything to animate.
          h('section', { className: 'dvc-set-block' },
            h('span', { className: 'dvc-set-label' }, t('settings.figure')),
            h('p', { className: 'dvc-set-note' }, t('settings.figureHint')),
            h('div', { className: 'dvc-set-row' },
              state.figureSet
                ? h('img', {
                    className: 'dvc-set-avatar',
                    src: `/.dsh-voice-call/figure?rev=${String(state.figureRev)}`,
                    alt: t('settings.figure'),
                  })
                : null,
              h('label', { className: 'dvc-set-file' },
                h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', onChange: pickFigure }),
                figure === null ? t('settings.figureChoose') : figure.name),
              h('button', {
                type: 'button', className: 'dvc-set-primary',
                disabled: figure === null || state.saving,
                onClick: () => { if (figure !== null) void settings.uploadFigure(figure) },
              }, state.saving ? t('settings.figureWorking') : t('settings.figureUpload')),
              state.figureOwn
                ? h('button', {
                    type: 'button', className: 'dvc-set-quiet',
                    disabled: state.saving,
                    onClick: () => { void settings.clearFigure() },
                  }, t('settings.figureClear'))
                : null),
            state.figureSet && !state.figureOwn
              ? h('p', { className: 'dvc-set-note' }, t('settings.figureBorrowed'))
              : null),
          // Cloning.
          h('section', { className: 'dvc-set-block' },
            h('span', { className: 'dvc-set-label' }, t('settings.clone')),
            h('p', { className: 'dvc-set-note' }, t('settings.cloneHint')),
            h('input', {
              className: 'dvc-set-text', type: 'text', value: name,
              placeholder: t('settings.cloneNamePlaceholder'),
              'aria-label': t('settings.cloneName'),
              onChange: (event) => { setName(event.target.value) },
            }),
            h('div', { className: 'dvc-set-row' },
              h('label', { className: 'dvc-set-file' },
                h('input', { type: 'file', accept: 'audio/*', onChange: pick }),
                file === null ? t('settings.cloneChoose') : file.name),
              h('button', {
                type: 'button', className: 'dvc-set-primary',
                disabled: file === null || state.saving,
                onClick: () => { if (file !== null) void settings.clone(file, name) },
              }, state.saving ? t('settings.cloneWorking') : t('settings.cloneUpload')))),
          // Characters, last: they build on the voices and the picture above, so
          // the page reads as "how this deployment speaks, then who speaks".
          h('section', { className: 'dvc-set-block' },
            h('span', { className: 'dvc-set-label' }, t('characters.nav')),
            h(CharactersPanel, { characters, t })),
          state.notice === null ? null : h('p', {
            className: ['settings.saved', 'settings.cloneOk', 'settings.cloneConverted', 'settings.voiceRemoved', 'settings.avatarOk', 'settings.avatarCleared'].includes(state.notice.key) ? 'dvc-set-ok' : 'dvc-set-error',
          }, t(state.notice.key, state.notice.params)))
      }


      /**
       * Render the characters block inside the voice settings page.
       *
       * A block rather than a page of its own: a character IS a voice, a
       * picture, and a pace, so the same page that sets those for the
       * deployment is where they are set for a character. Splitting them put
       * two halves of one decision behind two nav entries.
       *
       * The roster and the editor are two states of the same block: the editor
       * replaces the list rather than opening a dialog, which keeps the flow
       * inside the settings panel it already lives in.
       *
       * @param props - the roster controller and the translator.
       * @returns The characters block.
       */
      function CharactersPanel({ characters, t }) {
        const state = useSyncExternalStore(characters.store.subscribe, characters.store.getSnapshot, characters.store.getSnapshot)
        const [image, setImage] = useState(null)
        useEffect(() => { void characters.read() }, [characters])
        const draft = state.draft
        const editing = state.editing !== ''
        const notice = state.notice === null ? null : h('p', {
          className: state.notice.key === 'characters.failed' ? 'dvc-set-error' : 'dvc-set-ok',
        }, t(state.notice.key, state.notice.params))
        if (state.loading) return h('p', { className: 'dvc-set-note' }, t('settings.loading'))
        if (state.error !== null) {
          return h('p', { className: 'dvc-set-error' }, t('settings.loadFailed', { message: state.error }))
        }
        // The editor.
        if (editing && draft !== null) {
          const clones = state.voices.filter((voice) => voice.engine === 'clone')
          const locals = state.voices.filter((voice) => voice.engine === 'piper')
          const chosen = draft.voice.engine === 'cloud' ? 'cloud:'
            : draft.voice.cloneId !== '' ? `clone:${draft.voice.cloneId}`
              : draft.voice.localVoiceId !== '' ? `local:${draft.voice.localVoiceId}` : ''
          // The engine is stored explicitly: choosing the cloud voice has to be
          // distinguishable from naming no voice at all, or the local default
          // would win and the character's choice would silently do nothing.
          const pickVoice = (value) => {
            if (value === '') { characters.setDraftVoice({ engine: '', cloneId: '', localVoiceId: '' }); return }
            const kind = value.slice(0, value.indexOf(':'))
            const id = value.slice(value.indexOf(':') + 1)
            if (kind === 'cloud') { characters.setDraftVoice({ engine: 'cloud', cloneId: '', localVoiceId: '' }); return }
            characters.setDraftVoice(kind === 'clone'
              ? { engine: 'clone', cloneId: id, localVoiceId: '' }
              : { engine: 'local', localVoiceId: id, cloneId: '' })
          }
          return h('div', { className: 'dvc-char-edit' },
            h('section', { className: 'dvc-set-block' },
              h('label', { className: 'dvc-set-label', htmlFor: 'dvc-char-name' }, t('characters.name')),
              h('input', {
                id: 'dvc-char-name', className: 'dvc-set-text', type: 'text', value: draft.name,
                placeholder: t('characters.namePlaceholder'),
                onChange: (event) => { characters.setDraft({ name: event.target.value }) },
              })),
            h('section', { className: 'dvc-set-block' },
              h('label', { className: 'dvc-set-label', htmlFor: 'dvc-char-personality' }, t('characters.personality')),
              h('textarea', {
                id: 'dvc-char-personality', className: 'dvc-set-area', rows: '5', value: draft.personality,
                placeholder: t('characters.personalityPlaceholder'),
                onChange: (event) => { characters.setDraft({ personality: event.target.value }) },
              }),
              h('p', { className: 'dvc-set-note' }, t('characters.personalityHint'))),
            h('section', { className: 'dvc-set-block' },
              h('label', { className: 'dvc-set-label', htmlFor: 'dvc-char-voice' }, t('characters.voice')),
              h('select', {
                id: 'dvc-char-voice', className: 'dvc-set-select', value: chosen,
                onChange: (event) => { pickVoice(event.target.value) },
              },
              h('option', { value: '' }, t('characters.voiceDefault')),
              h('option', { value: 'cloud:' }, t('settings.cloudVoice')),
              locals.length > 0 ? h('optgroup', { label: t('settings.localGroup') },
                locals.map((voice) => h('option', { key: voice.id, value: `local:${voice.id}` }, voice.name))) : null,
              clones.length > 0 ? h('optgroup', { label: t('settings.cloneGroup') },
                clones.map((voice) => h('option', { key: voice.id, value: `clone:${voice.id}` }, voice.name))) : null),
              h('p', { className: 'dvc-set-note' }, t('characters.voiceHint'))),
            // The picture. A new character has no id yet, so the file is staged
            // here and uploaded by Save; an existing one shows what it has.
            h('section', { className: 'dvc-set-block' },
              h('span', { className: 'dvc-set-label' }, t('characters.avatar')),
              h('p', { className: 'dvc-set-note' }, t('characters.avatarHint')),
              h('div', { className: 'dvc-set-row' },
                draft.imagePreview !== ''
                  ? h('img', { className: 'dvc-set-avatar', src: draft.imagePreview, alt: '' })
                  : draft.imageRemoved === false && state.editing !== 'new' && (state.characters.find((c) => c.id === state.editing)?.hasAvatar ?? false)
                    ? h('img', { className: 'dvc-set-avatar', src: `/.dsh-voice-call/characters/${encodeURIComponent(state.editing)}/avatar`, alt: '' })
                    : null,
                h('label', { className: 'dvc-set-file' },
                  h('input', {
                    type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif',
                    onChange: (event) => {
                      const file = event.target.files?.[0] ?? null
                      if (file === null) return
                      // A local preview shows the choice before Save, which is
                      // when the bytes actually reach the Host.
                      const reader = new FileReader()
                      reader.onload = () => { characters.setDraftImage(file, String(reader.result ?? '')) }
                      reader.readAsDataURL(file)
                    },
                  }),
                  draft.imagePreview === '' ? t('characters.avatarChoose') : t('characters.avatarChosen')),
                draft.imagePreview !== '' || (draft.imageRemoved === false && state.editing !== 'new' && (state.characters.find((c) => c.id === state.editing)?.hasAvatar ?? false))
                  ? h('button', {
                      type: 'button', className: 'dvc-set-quiet',
                      onClick: () => { characters.clearDraftImage() },
                    }, t('characters.avatarClear'))
                  : null)),
            // The pace. A checkbox decides whether the character has an opinion
            // at all, because "follow the settings" and "1.0" are different
            // answers and a bare slider cannot express the first.
            h('section', { className: 'dvc-set-block' },
              h('label', { className: 'dvc-set-switch', htmlFor: 'dvc-char-rate-own' },
                h('input', {
                  id: 'dvc-char-rate-own', type: 'checkbox', checked: draft.voice.rate !== null,
                  onChange: (event) => { characters.setDraftVoice({ rate: event.target.checked ? 1 : null }) },
                }),
                h('span', { className: 'dvc-set-label' }, t('characters.rateOwn'))),
              draft.voice.rate === null
                ? h('p', { className: 'dvc-set-note' }, t('characters.rateFollow', { value: Number(state.settingsRate).toFixed(2) }))
                : h('div', null,
                    h('label', { className: 'dvc-set-label', htmlFor: 'dvc-char-rate' },
                      t('characters.rate'), h('output', { className: 'dvc-set-value' }, Number(draft.voice.rate).toFixed(2))),
                    h('input', {
                      id: 'dvc-char-rate', className: 'dvc-set-range', type: 'range', min: '0.5', max: '2', step: '0.05',
                      value: String(draft.voice.rate),
                      onChange: (event) => { characters.setDraftVoice({ rate: Number(event.target.value) }) },
                    }),
                    h('p', { className: 'dvc-set-note' }, t('characters.rateHint')))),
            h('div', { className: 'dvc-set-row' },
              h('button', {
                type: 'button', className: 'dvc-set-primary',
                disabled: state.saving,
                onClick: () => { void characters.save() },
              }, state.saving ? t('settings.cloneWorking') : t('characters.save')),
              h('button', {
                type: 'button', className: 'dvc-set-quiet',
                onClick: () => { characters.cancelEdit() },
              }, t('characters.cancel'))),
            notice)
        }
        // The roster.
        return h('div', { className: 'dvc-char-edit' },
          h('p', { className: 'dvc-set-note' }, t('characters.intro')),
          h('p', { className: 'dvc-set-note' }, state.activeId === '' ? t('characters.none') : `${t('characters.active')}: ${state.characters.find((c) => c.id === state.activeId)?.name ?? state.activeId}`),
          state.characters.length === 0
            ? h('p', { className: 'dvc-set-note' }, t('characters.empty'))
            : h('div', { className: 'dvc-char-list' }, state.characters.map((character) => h('div', {
                key: character.id,
                className: character.id === state.activeId ? 'dvc-char dvc-char-on' : 'dvc-char',
              },
              character.hasAvatar
                ? h('img', { className: 'dvc-char-avatar', src: `/.dsh-voice-call/characters/${encodeURIComponent(character.id)}/avatar`, alt: '' })
                : h('span', { className: 'dvc-char-avatar dvc-char-fallback' }, (character.name || '?').slice(0, 1)),
              h('div', { className: 'dvc-char-body' },
                h('span', { className: 'dvc-char-name' }, character.name),
                h('span', { className: 'dvc-char-desc' }, character.personality === '' ? t('characters.voice') : character.personality),
                character.voice?.rate === null || character.voice?.rate === undefined
                  ? null
                  : h('span', { className: 'dvc-char-desc' }, `${t('characters.rate')}: ${Number(character.voice.rate).toFixed(2)}`)),
              h('div', { className: 'dvc-char-actions' },
                character.id === state.activeId
                  ? h('span', { className: 'dvc-set-ok' }, t('characters.active'))
                  : h('button', { type: 'button', className: 'dvc-set-primary', disabled: state.saving, onClick: () => { void characters.activate(character.id) } }, t('characters.use')),
                h('button', { type: 'button', className: 'dvc-set-quiet', onClick: () => { characters.beginEdit(character) } }, t('characters.edit')),
                h('button', { type: 'button', className: 'dvc-set-quiet', onClick: () => { if (window.confirm(t('characters.confirmDelete'))) void characters.remove(character.id) } }, t('characters.delete')))))),
          h('div', { className: 'dvc-set-row' },
            h('button', { type: 'button', className: 'dvc-set-primary', onClick: () => { characters.beginCreate() } }, t('characters.create'))),
          notice)
      }

      /** Styles for the settings page; scoped by the section's own class names. */
      const SETTINGS_CSS = `
.dvc-set{display:flex;flex-direction:column;gap:18px;max-width:640px;padding:4px 2px 24px}
.dvc-set-intro{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.6}
.dvc-set-block{display:flex;flex-direction:column;gap:8px}
.dvc-set-label{display:flex;align-items:center;justify-content:space-between;gap:12px;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600}
.dvc-set-value{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;font-weight:500}
.dvc-set-note{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}
.dvc-set-group{margin-top:6px;color:var(--dsw-alias-label-primary);font-size:12px;font-weight:600}
.dvc-set-choices{display:flex;flex-wrap:wrap;gap:8px}
.dvc-set-choice{padding:6px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
.dvc-set-choice:hover{border-color:var(--dsw-alias-border-l3)}
.dvc-set-pair{display:inline-flex;align-items:stretch;gap:2px}
.dvc-set-drop{display:grid;place-items:center;width:26px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:14px;line-height:1;cursor:pointer}
.dvc-set-drop:hover{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dvc-set-drop:disabled{opacity:.4;cursor:default}
.dvc-set-on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dvc-set-range{width:100%;accent-color:var(--dsw-alias-brand-primary)}
.dvc-set-select,.dvc-set-text{width:100%;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}
.dvc-set-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dvc-set-file{display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-secondary);font-size:12px;cursor:pointer}
.dvc-set-file input{display:none}
.dvc-set-primary{padding:6px 14px;border:0;border-radius:8px;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted);font:inherit;font-size:12px;cursor:pointer}
.dvc-set-primary:disabled{opacity:.5;cursor:default}
.dvc-set-ok{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px}
.dvc-set-avatar{width:44px;height:44px;border-radius:999px;object-fit:cover;border:1px solid var(--dsw-alias-border-l2)}
.dvc-set-switch{display:flex;align-items:center;gap:8px;cursor:pointer}
.dvc-set-switch input{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary)}
.dvc-set-switch .dvc-set-label{font-weight:500}
.dvc-set-area{width:100%;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.6;resize:vertical}
.dvc-char-edit{display:flex;flex-direction:column;gap:14px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-base)}
.dvc-char-list{display:flex;flex-direction:column;gap:10px}
.dvc-char{display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px}
.dvc-char-on{border-color:var(--dsw-alias-brand-primary)}
.dvc-char-avatar{display:grid;place-items:center;width:40px;height:40px;border-radius:999px;object-fit:cover;flex:0 0 auto;font-size:16px;font-weight:600;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary)}
.dvc-char-body{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.dvc-char-name{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600}
.dvc-char-desc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.dvc-char-actions{display:flex;align-items:center;gap:8px;flex:0 0 auto}
.dvc-set-quiet{padding:6px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.dvc-set-quiet:hover{color:var(--dsw-alias-label-primary)}
.dvc-set-error{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.6}

/* A band a few pixels tall is not a finger target, so the grab area is padded
   beyond the visible border without moving it. */
`

      /** Handset glyph. */
      function IconPhone() {
        return h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' },
          h('path', { d: 'M5 3.5h3l1.5 4-2 1.5a12 12 0 0 0 5.5 5.5l1.5-2 4 1.5v3a1.5 1.5 0 0 1-1.7 1.5A16.5 16.5 0 0 1 3.5 5.2 1.5 1.5 0 0 1 5 3.5Z' }))
      }

      /** Handset glyph rotated, the hang-up control. */
      function IconPhoneDown() {
        return h('svg', { viewBox: '0 0 24 24', width: 20, height: 20, 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', style: { transform: 'rotate(135deg)' } },
          h('path', { d: 'M5 3.5h3l1.5 4-2 1.5a12 12 0 0 0 5.5 5.5l1.5-2 4 1.5v3a1.5 1.5 0 0 1-1.7 1.5A16.5 16.5 0 0 1 3.5 5.2 1.5 1.5 0 0 1 5 3.5Z' }))
      }

      /** Open microphone glyph. */
      function IconMic() {
        return h('svg', { viewBox: '0 0 24 24', width: 20, height: 20, 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' },
          h('rect', { x: 9, y: 3, width: 6, height: 11, rx: 3 }), h('path', { d: 'M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21' }))
      }

      /** Muted microphone glyph. */
      function IconMicOff() {
        return h('svg', { viewBox: '0 0 24 24', width: 20, height: 20, 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' },
          h('rect', { x: 9, y: 3, width: 6, height: 11, rx: 3 }), h('path', { d: 'M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M4 4l16 16' }))
      }

      /** Component-scoped styles; unmounting the overlay removes them. */
      const CSS = `
.dvc-foot{display:flex;align-items:center;gap:10px;width:100%;min-width:0;height:34px;padding:0 10px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;text-align:left}
.dvc-foot:hover{background:var(--dsw-alias-bg-layer-2)}
.dvc-foot:disabled{opacity:.5;cursor:default}
.dvc-foot-rail{justify-content:center;padding:0;width:34px;height:34px}
.dvc-foot-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dvc-root{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;font:400 14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--dsw-alias-label-primary)}
.dvc-card{pointer-events:auto;width:min(92vw,340px);max-height:min(88vh,560px);display:flex;flex-direction:column;align-items:center;gap:10px;padding:22px 20px 18px;border:0;border-radius:22px;background:var(--dsw-alias-bg-overlay);box-shadow:var(--dsw-elevation-prominent);overflow:hidden}
.dvc-phase{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}
.dvc-avatar-wrap{position:relative;display:grid;place-items:center;width:104px;height:104px}
.dvc-avatar{display:grid;place-items:center;width:88px;height:88px;border-radius:999px;color:var(--dsw-alias-label-primary-inverted);font-size:34px;font-weight:600;box-shadow:var(--dsw-shadow-lv2)}
.dvc-avatar-img{object-fit:cover;background:var(--dsw-alias-bg-base)}
.dvc-figure-wrap{position:relative;display:grid;place-items:center;width:100%;margin:2px 0 4px}
/* A portrait box: the animator's frame, sized like a face rather than a dot. */
.dvc-figure{display:block;width:100%;height:min(42vh,272px);border-radius:16px;background:var(--dsw-alias-bg-base);box-shadow:var(--dsw-elevation-prominent)}
.dvc-figure-ring{position:absolute;inset:-2px;border-radius:18px;border:2px solid transparent;pointer-events:none;transition:border-color .2s}
.dvc-portrait{display:block;width:100%;height:min(42vh,272px);object-fit:cover;border-radius:16px;background:var(--dsw-alias-bg-base);box-shadow:var(--dsw-elevation-prominent)}
.dvc-portrait-wait{background:var(--dsw-alias-bg-base)}
.dvc-figure-ring[data-active='true']{border-color:var(--dsw-alias-brand-primary)}
.dvc-ring{position:absolute;inset:0;border-radius:999px;border:2px solid var(--dsw-alias-brand-primary);opacity:0;transform:scale(.86)}
.dvc-ring[data-active]{animation:dvc-pulse 1.6s ease-out infinite}
.dvc-ring-late[data-active]{animation-delay:.8s}
@keyframes dvc-pulse{0%{opacity:.55;transform:scale(.86)}100%{opacity:0;transform:scale(1.12)}}
.dvc-title{font-size:19px;font-weight:600;max-width:100%;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dvc-hint{font-size:13px;color:var(--dsw-alias-label-secondary)}
.dvc-meter{width:64%;height:4px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.dvc-meter span{display:block;height:100%;transform-origin:left center;background:var(--dsw-alias-state-success-primary);transition:transform .08s linear}
.dvc-clock{font-variant-numeric:tabular-nums;font-size:13px;color:var(--dsw-alias-label-secondary)}
.dvc-device{max-width:100%;font-size:11px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dvc-notice{width:100%;padding:8px 10px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-warn-primary);font-size:12px;text-align:center}
.dvc-lines{width:100%;max-height:150px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;padding:2px}
.dvc-line{display:flex;flex-direction:column;gap:2px;padding:7px 10px;border-radius:12px;background:var(--dsw-alias-bg-layer-2);font-size:12.5px;word-break:break-word}
.dvc-line[data-role="you"]{align-self:flex-end;background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted);max-width:88%}
.dvc-line[data-role="agent"]{align-self:flex-start;max-width:88%}
.dvc-line-who{font-size:10.5px;letter-spacing:.04em;text-transform:uppercase;opacity:.72}
.dvc-actions{display:flex;gap:26px;margin-top:6px}
.dvc-round{display:grid;place-items:center;width:58px;height:58px;border:0;border-radius:999px;color:var(--dsw-alias-label-primary-inverted);cursor:pointer;transition:transform .12s ease,filter .12s ease}
.dvc-round:hover{filter:brightness(1.08)}
.dvc-round:active{transform:scale(.94)}
.dvc-accept{background:var(--dsw-alias-state-success-primary)}
.dvc-hangup{background:var(--dsw-alias-state-error-primary)}
.dvc-neutral{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2)}
.dvc-muted{background:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-label-primary)}
`

      /**
       * Client services required before either seat may register.
       *
       * `remote.session` is a flat Cordis service name, not a nested lookup:
       * the Gateway mounts one `RemoteNamespaceService` per namespace under
       * `remote.<namespace>`, and reading it without declaring it here throws
       * `cannot get property "remote.session" without inject`.
       */
      const inject = ['slots', 'locale', 'remote', 'remote.session', 'remote.agentPresets', 'sessions', 'uiWorkspace']

      /**
       * Register the locale dictionary, the sidebar control, and the call overlay.
       * @param ctx - Client plugin context.
       */
      function apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, DICT))
        const t = ctx.locale.bind(NS)
        const store = createStore({
          phase: 'idle', sessionId: null, title: '', lines: [], notice: null,
          activity: 'idle', elapsed: 0, level: 0, muted: false, device: '', route: null, startedAt: 0,
        })
        // Read the namespace through its own service key; `ctx.remote.session`
        // is the same object but is only reachable after the declaration above.
        // `uiWorkspace.openSession` is what makes the new call's Session the
        // one the Conversation column shows.
        const call = createCall(ctx, store, ctx['remote.session'], ctx['remote.agentPresets'], ctx.sessions,
          (sessionId) => { ctx.uiWorkspace.openSession(sessionId) },
          (opts) => ctx.sessions.create(opts), t)
        const face = {
          subscribe: store.subscribe,
          getSnapshot: store.getSnapshot,
          begin: call.begin,
          ring: call.ring,
          accept: call.accept,
          hangUp: call.hangUp,
          toggleMute: call.toggleMute,
        }
        ctx.effect(() => () => { call.hangUp(); return call.dispose() })
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: 'voice-call', order: 40, locale: NS,
          inject: () => ({ call: face }),
        }, VoiceCallOverlay))
        // The sidebar foot, directly above Settings: a call is a global action
        // that starts its own conversation, so it does not belong to whichever
        // Session happens to be open.
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action', id: 'voice-call', order: 20, locale: NS,
          inject: () => ({ call: face }),
        }, VoiceCallButton))
        // One page owns how this plugin speaks: the rate, the voices, the
        // picture, and the characters that combine them. Characters were briefly
        // a page of their own, but a character IS a voice, a picture, and a
        // pace, so two nav entries split one decision in half.
        const settings = createVoiceSettings(ctx, t)
        const characters = createCharacters(t)
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'voice-call', order: 25,
          label: () => t('settings.nav'), locale: NS,
          inject: () => ({ settings, characters }),
        }, VoiceSettingsSection))
      }

      // Exposed for tests: the figure's own rendering is worth checking without
      // standing up the overlay, its session store, and its audio pipeline.
      const internals = { Avatar, PortraitFigure }
      return { name: 'voice-call', inject, apply, internals }
    },
  })
})()
