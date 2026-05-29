'use strict'

const { app, BrowserWindow, ipcMain, dialog, nativeTheme } = require('electron')
const { autoUpdater } = require('electron-updater')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { generateDocx } = require('./services/docx-generator')
const { analyzeTone } = require('./services/tone-analyzer')

// ── Auto-detect credentials from Claude Code or environment ──────────────────
function detectAnthropicKey() {
  // 1. Environment variable (Claude Code sets this)
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY

  // 2. Claude Code config locations
  const candidates = [
    path.join(os.homedir(), '.claude', 'config.json'),
    path.join(os.homedir(), '.config', 'claude', 'config.json'),
    path.join(os.homedir(), '.anthropic', 'credentials'),
  ]
  for (const loc of candidates) {
    try {
      if (!fs.existsSync(loc)) continue
      const raw = fs.readFileSync(loc, 'utf8')
      // Try JSON parse first
      try {
        const cfg = JSON.parse(raw)
        const k = cfg.apiKey || cfg.api_key || cfg.ANTHROPIC_API_KEY || cfg.anthropic_api_key
        if (k && k.startsWith('sk-ant-')) return k
      } catch {
        // Plain text file — look for a key-like string
        const m = raw.match(/sk-ant-[A-Za-z0-9_-]{20,}/)
        if (m) return m[0]
      }
    } catch {}
  }
  return null
}

const SETTINGS_PATH = path.join(app.getPath('userData'), 'ghost-scribe-settings.json')
const HISTORY_PATH  = path.join(app.getPath('userData'), 'ghost-scribe-history.json')
const MAX_HISTORY   = 100
const DEFAULT_SETTINGS = {
  // Transcription
  transcriptionProvider: 'deepgram',
  deepgramApiKey: '',
  gladiaApiKey: '',
  openaiApiKey: '',
  assemblyaiApiKey: '',
  groqApiKey: '',
  transcriptionModel: 'nova-3',
  transcriptionCustomModel: '',
  language: 'en',
  translateTo: '',
  accentEnhance: false,

  // AI Analysis
  analysisProvider: 'claude',
  claudeApiKey: '',
  openaiAnalysisApiKey: '',
  perplexityApiKey: '',
  groqAnalysisApiKey: '',
  geminiApiKey: '',
  customApiUrl: '',
  customApiKey: '',
  ollamaUrl: 'http://localhost:11434',
  analysisModel: '',

  // Display
  stealthMode: true,
  alwaysOnTop: true,
  windowOpacity: 0.93,
  fontSize: 15,
  appIcon: '👻',
  appIconPath: '',
}

let settings = loadSettings()
let mainWindow = null
let deepgramLive = null
let keepAliveInterval = null
let isManualStop = false
let isReconnecting = false
let reconnectTimeout = null
let lastRecordingConfig = null
let sessionData = { startTime: null, transcript: [], speakerSegments: {} }
let reconnectAttempts = 0
const MAX_RECONNECT_ATTEMPTS = 5
// Audio buffer: holds PCM chunks during reconnect so speech isn't lost
let audioReconnectBuffer = []
const MAX_BUFFER_CHUNKS = 30 // ~6s at 16kHz / 4096 buffer size

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) }
    }
  } catch {}
  return { ...DEFAULT_SETTINGS }
}

function persistSettings(updates) {
  settings = { ...settings, ...updates }
  try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2)) } catch {}
}

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_PATH)) return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'))
  } catch {}
  return []
}

function persistHistory(entries) {
  try { fs.writeFileSync(HISTORY_PATH, JSON.stringify(entries, null, 2)) } catch {}
}

app.whenReady().then(() => {
  settings = loadSettings()
  createWindow()
  setupAutoUpdater()
  checkJustUpdated()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 440,
    height: 700,
    minWidth: 320,
    minHeight: 450,
    transparent: true,
    frame: false,
    alwaysOnTop: settings.alwaysOnTop,
    skipTaskbar: false,
    hasShadow: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      // Disable accessibility tree to prevent window content reading via a11y APIs
      accessibilitySupportEnabled: false,
    },
  })

  // Explicitly enable mouse events — required on Windows for transparent windows
  // so clicks land on the visible content rather than falling through.
  mainWindow.setIgnoreMouseEvents(false)

  // Always enforce content protection at startup — prevents ALL screen capture
  // (Teams, Zoom, Google Meet, Discord, OBS, Windows Snipping Tool, Print Screen)
  // On Windows 10 2004+ uses WDA_EXCLUDEFROMCAPTURE — window is invisible in captures.
  mainWindow.setContentProtection(true)
  mainWindow.setOpacity(settings.windowOpacity)

  // Restore saved custom icon
  if (settings.appIconPath && fs.existsSync(settings.appIconPath)) {
    try {
      const { nativeImage } = require('electron')
      const img = nativeImage.createFromPath(settings.appIconPath)
      if (!img.isEmpty()) mainWindow.setIcon(img)
    } catch {}
  }

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))

  nativeTheme.on('updated', () => {
    mainWindow?.webContents.send('theme-changed', { isDark: nativeTheme.shouldUseDarkColors })
  })
}

// ── IPC Handlers ──────────────────────────────────────────────────────────────

ipcMain.handle('get-settings', () => settings)

ipcMain.handle('get-auto-credentials', () => {
  const key = detectAnthropicKey()
  return {
    hasAnthropicKey: !!key,
    // Don't expose the actual key value — just confirm it was found.
    // The renderer will call use-auto-credentials to apply it.
    source: key
      ? (process.env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY env var' : 'Claude Code config file')
      : null,
  }
})

ipcMain.handle('use-auto-credentials', () => {
  const key = detectAnthropicKey()
  if (!key) return { success: false }
  persistSettings({ claudeApiKey: key, analysisProvider: 'claude' })
  return { success: true }
})

ipcMain.handle('save-settings', (_, updates) => {
  persistSettings(updates)
  if (mainWindow) {
    mainWindow.setAlwaysOnTop(settings.alwaysOnTop)
    mainWindow.setOpacity(Math.max(0.1, Math.min(1, settings.windowOpacity)))
    mainWindow.setContentProtection(settings.stealthMode)
  }
  return settings
})

ipcMain.handle('get-theme', () => ({ isDark: nativeTheme.shouldUseDarkColors }))
ipcMain.handle('get-version', () => app.getVersion())

ipcMain.handle('get-history', () => loadHistory())

ipcMain.handle('save-history-entry', (_, entry) => {
  const history = loadHistory()
  history.unshift(entry)
  if (history.length > MAX_HISTORY) history.splice(MAX_HISTORY)
  persistHistory(history)
  return { success: true }
})

ipcMain.handle('delete-history-entry', (_, id) => {
  const history = loadHistory().filter(e => e.id !== id)
  persistHistory(history)
  return { success: true }
})

ipcMain.handle('clear-history', () => {
  persistHistory([])
  return { success: true }
})

ipcMain.handle('start-recording', async (_, config) => {
  lastRecordingConfig = config
  isManualStop = false
  reconnectAttempts = 0
  sessionData = { startTime: Date.now(), transcript: [], speakerSegments: {} }

  if (config.provider === 'deepgram') {
    return await startDeepgramSession(config.apiKey, config.options)
  }
  if (config.provider === 'gladia') {
    return await startGladiaSession(config.apiKey, config.options)
  }
  return { success: false, error: `Provider "${config.provider}" not yet supported in this build.` }
})

ipcMain.on('audio-data', (_, buffer) => {
  if (gladiaWs?.readyState === 1) {
    try { gladiaWs.send(Buffer.from(buffer)) } catch {}
    return
  }
  if (deepgramLive) {
    // Drain buffered audio first so speech during reconnect isn't lost
    if (audioReconnectBuffer.length > 0) {
      for (const chunk of audioReconnectBuffer) {
        try { deepgramLive.send(Buffer.from(chunk)) } catch {}
      }
      audioReconnectBuffer = []
    }
    try { deepgramLive.send(Buffer.from(buffer)) } catch {}
  } else if (isReconnecting && !isManualStop) {
    // Buffer audio while waiting for reconnect (ring buffer — keep most recent)
    audioReconnectBuffer.push(buffer)
    if (audioReconnectBuffer.length > MAX_BUFFER_CHUNKS) audioReconnectBuffer.shift()
  }
})

ipcMain.handle('stop-recording', async () => {
  isManualStop = true
  isReconnecting = false
  reconnectAttempts = 0
  audioReconnectBuffer = []
  clearTimeout(reconnectTimeout)
  reconnectTimeout = null
  clearInterval(keepAliveInterval)
  keepAliveInterval = null
  if (deepgramLive) {
    try { deepgramLive.finish() } catch {}
    deepgramLive = null
  }
  if (gladiaWs) {
    try { gladiaWs.close() } catch {}
    gladiaWs = null
  }
  return generateSummary()
})

ipcMain.handle('save-docx', async (_, payload) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Transcript as Word Document',
    defaultPath: `transcript-${timestamp}.docx`,
    filters: [{ name: 'Word Document', extensions: ['docx'] }],
  })
  if (canceled || !filePath) return { success: false }
  try {
    const buf = await generateDocx({ ...payload, sessionDate: new Date().toLocaleString() })
    fs.writeFileSync(filePath, buf)
    return { success: true, path: filePath }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('analyze-tone', async (_, { fullTranscript, speakerTexts, config }) => {
  try {
    // Merge caller config with stored settings as fallback
    const resolved = {
      provider:     config?.provider     || settings.analysisProvider || 'claude',
      apiKey:       config?.apiKey       || getAnalysisKey(config?.provider || settings.analysisProvider),
      model:        config?.model        || settings.analysisModel    || '',
      ollamaUrl:    config?.ollamaUrl    || settings.ollamaUrl        || 'http://localhost:11434',
      customApiUrl: config?.customApiUrl || settings.customApiUrl     || '',
    }
    return await analyzeTone(fullTranscript, speakerTexts, resolved)
  } catch (err) {
    return { error: err.message }
  }
})

function getAnalysisKey(provider) {
  switch (provider) {
    case 'claude':      return settings.claudeApiKey
    case 'openai':      return settings.openaiAnalysisApiKey
    case 'perplexity':  return settings.perplexityApiKey
    case 'groq':        return settings.groqAnalysisApiKey
    case 'gemini':      return settings.geminiApiKey
    case 'custom':      return settings.customApiKey
    default:            return ''
  }
}

ipcMain.handle('translate-text', async (_, text, toLang) => {
  if (!text || !toLang) return text
  const prompt = `Translate the following to ${toLang}. Output only the translation, no explanation:\n${text}`
  try {
    // Prefer Groq — fastest, free tier available
    const groqKey = settings.groqAnalysisApiKey
    if (groqKey) {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 400,
          temperature: 0,
        }),
      })
      const data = await res.json()
      return data.choices?.[0]?.message?.content?.trim() || text
    }
    // Fall back to Claude Haiku
    const claudeKey = settings.claudeApiKey
    if (claudeKey) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk')
      const client = new Anthropic({ apiKey: claudeKey })
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      })
      return msg.content[0]?.text?.trim() || text
    }
  } catch {}
  return text
})

ipcMain.handle('enhance-transcript', async (_, text) => {
  if (!text) return text
  const prompt = `You are a transcription corrector for interview recordings. The text below was auto-transcribed from someone speaking with a heavy accent. Fix any words that were clearly misheard or mistranscribed due to the accent. Keep the exact original meaning — do not rephrase, summarize, or change correct words. Output only the corrected text, nothing else.\n\nTranscription: ${text}`
  try {
    const groqKey = settings.groqAnalysisApiKey
    if (groqKey) {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'llama-3.1-8b-instant',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 400,
          temperature: 0,
        }),
      })
      const data = await res.json()
      return data.choices?.[0]?.message?.content?.trim() || text
    }
    const claudeKey = settings.claudeApiKey
    if (claudeKey) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk')
      const client = new Anthropic({ apiKey: claudeKey })
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      })
      return msg.content[0]?.text?.trim() || text
    }
  } catch {}
  return text
})

ipcMain.handle('save-transcript', async (_, content) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Transcript',
    defaultPath: `transcript-${timestamp}.txt`,
    filters: [
      { name: 'Text File', extensions: ['txt'] },
      { name: 'Markdown', extensions: ['md'] },
    ],
  })
  if (canceled || !filePath) return { success: false }
  try {
    fs.writeFileSync(filePath, content, 'utf8')
    return { success: true, path: filePath }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('pick-icon-file', async () => {
  const { filePaths, canceled } = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose App Icon',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'ico'] }],
    properties: ['openFile'],
  })
  if (canceled || !filePaths[0]) return { success: false }
  const iconPath = filePaths[0]
  try {
    const { nativeImage } = require('electron')
    const img = nativeImage.createFromPath(iconPath)
    if (img.isEmpty()) return { success: false, error: 'Could not load image' }

    // Apply immediately to the running window + taskbar
    mainWindow?.setIcon(img)
    persistSettings({ appIconPath: iconPath, appIcon: '' })

    // Also save as build/icon.ico so the next npm run release bakes it into the .exe
    const buildDir = path.join(__dirname, 'build')
    const icoPath  = path.join(buildDir, 'icon.ico')
    if (!fs.existsSync(buildDir)) fs.mkdirSync(buildDir)

    const ext = path.extname(iconPath).toLowerCase()
    if (ext === '.ico') {
      fs.copyFileSync(iconPath, icoPath)
    } else {
      // Convert PNG/JPG → ICO
      const pngToIco = require('png-to-ico')
      const buf = await pngToIco(iconPath)
      fs.writeFileSync(icoPath, buf)
    }

    return { success: true, path: iconPath, buildIconSaved: true }
  } catch (err) {
    return { success: false, error: err.message }
  }
})

ipcMain.handle('clear-icon', () => {
  persistSettings({ appIconPath: '', appIcon: '👻' })
  return { success: true }
})

ipcMain.handle('minimize-window', () => mainWindow?.minimize())
ipcMain.handle('close-window', () => mainWindow?.close())
ipcMain.handle('toggle-always-on-top', () => {
  const next = !mainWindow?.isAlwaysOnTop()
  mainWindow?.setAlwaysOnTop(next)
  return next
})

// Click-through mode: window stays visible but clicks pass to the app behind it.
// Uses { forward: true } so mousemove events still reach the renderer for hover detection.
ipcMain.on('set-click-through', (_, enable) => {
  if (!mainWindow) return
  if (enable) {
    mainWindow.setIgnoreMouseEvents(true, { forward: true })
  } else {
    mainWindow.setIgnoreMouseEvents(false)
  }
})
ipcMain.handle('toggle-stealth', () => {
  settings.stealthMode = !settings.stealthMode
  mainWindow?.setContentProtection(settings.stealthMode)
  persistSettings({ stealthMode: settings.stealthMode })
  return settings.stealthMode
})

// ── Deepgram ──────────────────────────────────────────────────────────────────

async function startDeepgramSession(apiKey, options) {
  try {
    // Clean up any lingering connection before starting a new one
    if (deepgramLive) {
      try { deepgramLive.finish() } catch {}
      deepgramLive = null
      await new Promise(r => setTimeout(r, 500))
    }

    const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk')
    const deepgram = createClient(apiKey)

    const lang = options.language || 'multi'
    const DEEPGRAM_MODELS = ['nova-3', 'nova-2', 'nova-2-general', 'nova-2-meeting', 'nova-2-phonecall']
    const requestedModel = options.model || 'nova-3'
    const model = DEEPGRAM_MODELS.includes(requestedModel) ? requestedModel : 'nova-3'
    const liveOptions = {
      model,
      language: lang,
      smart_format: true,
      punctuate: true,
      interim_results: true,
      utterance_end_ms: 1000,
      vad_events: true,
      endpointing: 300,
      encoding: 'linear16',
      sample_rate: 16000,
      channels: 1,
    }
    // Nova-3 supports diarization in all language modes including multi
    liveOptions.diarize = true
    deepgramLive = deepgram.listen.live(liveOptions)

    deepgramLive.on(LiveTranscriptionEvents.Open, () => {
      // Reset reconnect state so future drops can trigger reconnect again
      reconnectAttempts = 0
      isReconnecting = false
      // Deepgram closes the connection after ~10s of silence without a KeepAlive
      clearInterval(keepAliveInterval)
      keepAliveInterval = setInterval(() => {
        try { deepgramLive?.keepAlive() } catch {}
      }, 8000)
      mainWindow?.webContents.send('provider-status', { status: 'connected', provider: 'Deepgram' })
    })

    deepgramLive.on(LiveTranscriptionEvents.Transcript, (data) => {
      const result = parseDeepgramResult(data)
      if (!result) return
      if (result.isFinal) {
        sessionData.transcript.push(result)
        updateSpeakerStats(result)
      }
      mainWindow?.webContents.send('transcription', result)
    })

    deepgramLive.on(LiveTranscriptionEvents.Error, (err) => {
      mainWindow?.webContents.send('error', `Deepgram: ${err.message || JSON.stringify(err)}`)
    })

    deepgramLive.on(LiveTranscriptionEvents.Close, () => {
      clearInterval(keepAliveInterval)
      keepAliveInterval = null
      deepgramLive = null
      mainWindow?.webContents.send('provider-status', { status: 'disconnected' })
      if (!isManualStop && !isReconnecting && lastRecordingConfig && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        isReconnecting = true
        reconnectAttempts++
        // Exponential backoff: 5s, 10s, 20s, 40s, 60s (capped)
        const delay = Math.min(5000 * Math.pow(2, reconnectAttempts - 1), 60000)
        mainWindow?.webContents.send('provider-status', { status: 'reconnecting' })
        reconnectTimeout = setTimeout(() => {
          if (!isManualStop) {
            startDeepgramSession(lastRecordingConfig.apiKey, lastRecordingConfig.options)
              .then(r => {
                isReconnecting = false
                if (!r.success) {
                  const isFatal = r.error && (r.error.includes('400') || r.error.includes('405') || r.error.includes('406'))
                  mainWindow?.webContents.send('error', 'Reconnect failed: ' + r.error)
                  // 405/406 = server rejected parameters; no point retrying
                  if (isFatal) reconnectAttempts = MAX_RECONNECT_ATTEMPTS
                }
              })
          } else {
            isReconnecting = false
          }
        }, delay)
      } else if (!isManualStop && reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        mainWindow?.webContents.send('error', 'Could not reconnect to Deepgram after several attempts. Please stop and restart recording.')
      }
    })

    // Wait for open or error
    await new Promise((resolve, reject) => {
      let settled = false
      const settle = (fn, val) => {
        if (settled) return
        settled = true
        deepgramLive.removeListener(LiveTranscriptionEvents.Open, onOpen)
        deepgramLive.removeListener(LiveTranscriptionEvents.Error, onErr)
        fn(val)
      }
      const onOpen = () => settle(resolve, undefined)
      const onErr = (e) => settle(reject, e)
      deepgramLive.once(LiveTranscriptionEvents.Open, onOpen)
      deepgramLive.once(LiveTranscriptionEvents.Error, onErr)
      setTimeout(() => settle(reject, new Error('Connection timeout — check API key and network')), 10000)
    })

    return { success: true }
  } catch (err) {
    deepgramLive = null
    return { success: false, error: err.message }
  }
}

function parseDeepgramResult(data) {
  const alt = data.channel?.alternatives?.[0]
  if (!alt) return null
  const transcript = alt.transcript || ''

  const words = alt.words || []
  const segments = []
  let curSpeaker = null
  let curWords = []

  for (const w of words) {
    const spk = w.speaker ?? 0
    if (spk !== curSpeaker) {
      if (curWords.length > 0) {
        segments.push({ speaker: curSpeaker, text: curWords.join(' '), confidence: alt.confidence || 0 })
      }
      curSpeaker = spk
      curWords = []
    }
    curWords.push(w.punctuated_word || w.word)
  }
  if (curWords.length > 0 && curSpeaker !== null) {
    segments.push({ speaker: curSpeaker, text: curWords.join(' '), confidence: alt.confidence || 0 })
  }

  // Fallback: no diarization data
  if (segments.length === 0 && transcript) {
    segments.push({ speaker: 0, text: transcript, confidence: alt.confidence || 0 })
  }

  return {
    isFinal: data.is_final === true,
    speechFinal: data.speech_final === true,
    transcript,
    confidence: alt.confidence || 0,
    segments,
    wordCount: words.length,
    timestamp: Date.now(),
  }
}

function updateSpeakerStats(result) {
  for (const seg of result.segments) {
    const s = seg.speaker
    if (!sessionData.speakerSegments[s]) {
      sessionData.speakerSegments[s] = { wordCount: 0, totalConf: 0, count: 0, firstSeen: Date.now() }
    }
    const wc = seg.text.split(/\s+/).filter(Boolean).length
    sessionData.speakerSegments[s].wordCount += wc
    sessionData.speakerSegments[s].totalConf += seg.confidence
    sessionData.speakerSegments[s].count += 1
  }
}

// ── Gladia ────────────────────────────────────────────────────────────────────

let gladiaWs = null

async function startGladiaSession(apiKey, options) {
  try {
    if (gladiaWs) { try { gladiaWs.close() } catch {} gladiaWs = null }

    const WebSocket = require('ws')
    gladiaWs = new WebSocket('wss://api.gladia.io/audio/text/audio-transcription', {
      headers: { 'x-gladia-key': apiKey },
    })

    await new Promise((resolve, reject) => {
      gladiaWs.once('open', resolve)
      gladiaWs.once('error', reject)
      setTimeout(() => reject(new Error('Gladia connection timeout')), 10000)
    })

    // Send initial config
    gladiaWs.send(JSON.stringify({
      x_gladia_key: apiKey,
      frames_format: 'bytes',
      language_behaviour: options.language && options.language !== 'multi' ? 'manual' : 'automatic multiple languages',
      language: options.language !== 'multi' ? options.language : undefined,
      model_type: options.model || 'fast',
      sample_rate: 16000,
      bit_depth: 16,
      channel: 1,
    }))

    gladiaWs.on('message', (raw) => {
      try {
        const data = JSON.parse(raw)
        if (!data.event) return
        if (data.event === 'connected') {
          mainWindow?.webContents.send('provider-status', { status: 'connected', provider: 'Gladia' })
          return
        }
        if (data.event === 'transcript' || data.event === 'final_transcript') {
          const isFinal = data.event === 'final_transcript'
          const transcript = data.transcription || ''
          if (!transcript) return
          const result = {
            isFinal,
            speechFinal: isFinal,
            transcript,
            confidence: data.confidence || 0.9,
            segments: [{ speaker: 0, text: transcript, confidence: data.confidence || 0.9 }],
            wordCount: transcript.split(/\s+/).filter(Boolean).length,
            timestamp: Date.now(),
          }
          if (isFinal) { sessionData.transcript.push(result); updateSpeakerStats(result) }
          mainWindow?.webContents.send('transcription', result)
        }
      } catch {}
    })

    gladiaWs.on('close', () => {
      gladiaWs = null
      mainWindow?.webContents.send('provider-status', { status: 'disconnected' })
    })

    gladiaWs.on('error', (err) => {
      mainWindow?.webContents.send('error', `Gladia: ${err.message}`)
    })

    mainWindow?.webContents.send('provider-status', { status: 'connected', provider: 'Gladia' })
    return { success: true }
  } catch (err) {
    gladiaWs = null
    return { success: false, error: err.message }
  }
}

// ── Auto-updater ──────────────────────────────────────────────────────────────

function setupAutoUpdater() {
  // Only run in packaged app — skip in dev (electron .)
  if (!app.isPackaged) return

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', (info) => {
    mainWindow?.webContents.send('update-available', {
      version: info.version,
      releaseNotes: info.releaseNotes || '',
      releaseDate: info.releaseDate || '',
    })
  })

  autoUpdater.on('update-not-available', () => {
    mainWindow?.webContents.send('update-not-available', { version: app.getVersion() })
  })

  autoUpdater.on('download-progress', (p) => {
    mainWindow?.webContents.send('update-progress', { percent: Math.round(p.percent) })
  })

  autoUpdater.on('update-downloaded', (info) => {
    mainWindow?.webContents.send('update-downloaded', { version: info.version })
  })

  autoUpdater.on('error', (err) => {
    // Silent — don't interrupt the user for update failures
    console.error('[updater]', err.message)
  })

  // Check on launch, then every 4 hours
  autoUpdater.checkForUpdates()
  setInterval(() => autoUpdater.checkForUpdates(), 4 * 60 * 60 * 1000)
}

const JUST_UPDATED_PATH = path.join(app.getPath('userData'), 'just-updated.json')

ipcMain.handle('download-update', () => autoUpdater.downloadUpdate())
ipcMain.handle('check-for-updates', () => {
  if (app.isPackaged) autoUpdater.checkForUpdates()
})

ipcMain.handle('install-update', () => {
  // Write marker so next launch can show "Update Complete"
  try {
    fs.writeFileSync(JUST_UPDATED_PATH, JSON.stringify({ version: app.getVersion() }))
  } catch {}
  autoUpdater.quitAndInstall(false, true)
})

function checkJustUpdated() {
  try {
    if (!fs.existsSync(JUST_UPDATED_PATH)) return
    const { version } = JSON.parse(fs.readFileSync(JUST_UPDATED_PATH, 'utf8'))
    fs.unlinkSync(JUST_UPDATED_PATH)
    // Wait for window to be ready then notify renderer
    setTimeout(() => {
      mainWindow?.webContents.send('just-updated', { version })
    }, 2000)
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────

function generateSummary() {
  const duration = sessionData.startTime ? Math.round((Date.now() - sessionData.startTime) / 1000) : 0
  const speakers = Object.entries(sessionData.speakerSegments).map(([id, stats]) => {
    const avgConf = stats.count > 0 ? stats.totalConf / stats.count : 0
    const wpm = duration > 0 ? Math.round(stats.wordCount / (duration / 60)) : 0
    return {
      id: parseInt(id),
      wordCount: stats.wordCount,
      avgConfidence: avgConf,
      confidenceLabel: avgConf >= 0.85 ? 'High' : avgConf >= 0.6 ? 'Medium' : 'Low',
      wpm,
      speechRate: wpm >= 160 ? 'Fast' : wpm >= 100 ? 'Normal' : 'Slow',
    }
  })

  // Talking share — what % of total words did each speaker contribute
  const totalWords = speakers.reduce((sum, s) => sum + s.wordCount, 0)
  for (const s of speakers) {
    s.talkingShare = totalWords > 0 ? Math.round((s.wordCount / totalWords) * 100) : 0
  }

  const lines = []
  for (const r of sessionData.transcript.filter(r => r.isFinal)) {
    for (const seg of r.segments) {
      if (seg.text.trim()) lines.push(`[Speaker ${seg.speaker + 1}]: ${seg.text}`)
    }
  }

  return { duration, speakerCount: speakers.length, speakers, fullTranscript: lines.join('\n') }
}
