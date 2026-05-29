'use strict'

// ── Constants ─────────────────────────────────────────────────────────────────

const SPEAKER_COLORS = [
  '#4A9EFF', // 1 — Blue
  '#4AFF9E', // 2 — Green
  '#FF9E4A', // 3 — Orange
  '#C97BFF', // 4 — Purple
  '#FF4A7A', // 5 — Pink
  '#4AFFEE', // 6 — Cyan
  '#FFD94A', // 7 — Yellow
  '#FF6B4A', // 8 — Red-orange
  '#A8FF4A', // 9 — Lime
  '#FF4AE8', // 10 — Magenta
]

const MAX_SPEAKERS = 10

const SAMPLE_RATE = 16000

// ── State ─────────────────────────────────────────────────────────────────────

let isRecording = false
let audioCtx = null
let audioStream = null
let processor = null
let sourceNode = null
let timerInterval = null
let timerSecs = 0
let settings = {}
let activeSpeakers = new Set()
let currentSummary = null
let toneResult = null
let speakerTexts = {}
let isPaused = false
let isClickThrough = false
let lastClickThroughState = false  // track to avoid redundant IPC calls
let totalSessionWords = 0
let midSessionAnalysisDone = false
let netBytesSent = 0
let netBytesReceived = 0
let netLatencies = []
let netLastSent = null
let netAnalysisCost = 0

// ── Helpers ───────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id)

function el(tag, cls, html) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (html !== undefined) e.innerHTML = html
  return e
}

function fmt(secs) {
  return `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function spkColor(id) {
  return SPEAKER_COLORS[id % SPEAKER_COLORS.length]
}


function toast(msg, type = 'info') {
  const t = el('div', `toast toast-${type}`, esc(msg))
  document.body.appendChild(t)
  setTimeout(() => t.remove(), 3500)
}

function showView(name) {
  $('mainView').style.display = name === 'main' ? 'flex' : 'none'
  $('summaryView').style.display = name === 'summary' ? 'flex' : 'none'
  $('settingsView').style.display = name === 'settings' ? 'flex' : 'none'
  $('historyView').style.display = name === 'history' ? 'flex' : 'none'
}

function setStatus(state, label) {
  $('statusDot').className = 'status-dot ' + state
  $('statusLabel').textContent = label
}

// ── Initialization ────────────────────────────────────────────────────────────

async function init() {
  settings = await window.electronAPI.getSettings()

  // Show version in title bar and settings footer
  const version = await window.electronAPI.getVersion()
  const vTag = `v${version}`
  const appVer = $('appVersion')
  if (appVer) appVer.textContent = vTag
  const settingsVer = $('settingsVersion')
  if (settingsVer) settingsVer.textContent = `Ghost Scribe ${vTag}`

  // Apply saved theme preference, or fall back to OS theme
  if (settings.themeOverride) {
    applyTheme(settings.themeOverride === 'dark')
  } else {
    const { isDark } = await window.electronAPI.getTheme()
    applyTheme(isDark)
  }
  applyFontSize(settings.fontSize || 15)
  applyIconDisplay(settings.appIconPath || settings.appIcon || '👻')

  // IPC event listeners
  window.electronAPI.onTranscription(onTranscription)
  window.electronAPI.onProviderStatus(onProviderStatus)
  window.electronAPI.onError(onError)
  // Only follow OS changes when there's no manual override
  window.electronAPI.onThemeChanged(({ isDark: d }) => {
    if (!settings.themeOverride) applyTheme(d)
  })

  // UI bindings
  $('recordBtn').addEventListener('click', toggleRecording)
  $('settingsBtn').addEventListener('click', async () => { await loadSettingsForm(); showView('settings') })
  $('closeSettings').addEventListener('click', () => showView('main'))
  $('historyBtn').addEventListener('click', () => loadHistoryView())
  $('closeHistory').addEventListener('click', () => showView('main'))
  $('clearHistoryBtn').addEventListener('click', async () => {
    await window.electronAPI.clearHistory()
    $('historyList').innerHTML = '<div class="history-empty">No sessions recorded yet</div>'
    toast('History cleared', 'info')
  })
  $('minimizeBtn').addEventListener('click', () => window.electronAPI.minimizeWindow())
  $('closeBtn').addEventListener('click', () => window.electronAPI.closeWindow())
  $('saveSettingsBtn').addEventListener('click', saveSettings)
  $('saveTxtBtn').addEventListener('click', doSaveTranscript)
  $('saveDocxBtn').addEventListener('click', doSaveDocx)
  $('newSessionBtn').addEventListener('click', resetSession)
  $('transcriptionProvider').addEventListener('change', syncTranscriptionFields)
  $('analysisProvider').addEventListener('change', syncAnalysisFields)
  $('pauseBtn').addEventListener('click', togglePause)
  $('useAutoCredBtn')?.addEventListener('click', applyAutoCredentials)
  $('opacityRange').addEventListener('input', e => $('opacityLabel').textContent = e.target.value + '%')
  $('fontRange').addEventListener('input', e => {
    $('fontLabel').textContent = e.target.value + 'px'
    applyFontSize(parseInt(e.target.value))
  })

  // Titlebar icon — click directly to open mini picker
  $('appIconDisplay').addEventListener('click', (e) => {
    e.stopPropagation()
    const popup = $('iconPopup')
    popup.style.display = popup.style.display === 'none' ? 'block' : 'none'
  })

  // Close popup when clicking anywhere else
  document.addEventListener('click', () => { $('iconPopup').style.display = 'none' })

  // Emoji options inside the popup
  $('iconPopup').querySelectorAll('.emoji-opt').forEach(el => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation()
      const emoji = el.dataset.e
      settings = await window.electronAPI.saveSettings({ appIcon: emoji, appIconPath: '' })
      applyIconDisplay(emoji)
      $('iconPopup').style.display = 'none'
      toast('Icon updated', 'success')
    })
  })

  $('popupUploadBtn').addEventListener('click', async (e) => {
    e.stopPropagation()
    $('iconPopup').style.display = 'none'
    const result = await window.electronAPI.pickIconFile()
    if (result.success) {
      settings = await window.electronAPI.getSettings()
      applyIconDisplay(result.path)
      toast(result.buildIconSaved
        ? 'Icon updated — run npm run release to bake into .exe'
        : 'Icon updated', 'success')
    } else if (result.error) {
      toast('Could not load image: ' + result.error, 'error')
    }
  })

  $('popupResetBtn').addEventListener('click', async (e) => {
    e.stopPropagation()
    await window.electronAPI.clearIcon()
    settings = await window.electronAPI.getSettings()
    applyIconDisplay('👻')
    $('iconPopup').style.display = 'none'
    toast('Icon reset', 'info')
  })

  $('pickImageBtn').addEventListener('click', async () => {
    const result = await window.electronAPI.pickIconFile()
    if (result.success) {
      settings = await window.electronAPI.getSettings()
      $('iconPreview').innerHTML = `<img src="file://${result.path}" style="width:32px;height:32px;object-fit:contain;border-radius:6px;">`
      applyIconDisplay(result.path)
      toast(result.buildIconSaved
        ? 'Icon saved — run npm run release to bake into .exe'
        : 'Icon updated', 'success')
    } else if (result.error) {
      toast('Could not load image: ' + result.error, 'error')
    }
  })

  $('pickEmojiBtn').addEventListener('click', () => {
    const grid = $('emojiGrid')
    grid.style.display = grid.style.display === 'none' ? 'grid' : 'none'
  })

  document.querySelectorAll('.emoji-opt').forEach(el => {
    el.addEventListener('click', async () => {
      const emoji = el.dataset.e
      settings = await window.electronAPI.saveSettings({ appIcon: emoji, appIconPath: '' })
      $('iconPreview').textContent = emoji
      $('emojiGrid').style.display = 'none'
      applyIconDisplay(emoji)
      toast('Icon updated', 'success')
    })
  })

  $('resetIconBtn').addEventListener('click', async () => {
    await window.electronAPI.clearIcon()
    settings = await window.electronAPI.getSettings()
    $('iconPreview').textContent = '👻'
    applyIconDisplay('👻')
    toast('Icon reset', 'info')
  })

  $('pinBtn').addEventListener('click', async () => {
    const on = await window.electronAPI.toggleAlwaysOnTop()
    $('pinBtn').style.opacity = on ? '1' : '0.45'
  })

  $('clickThroughBtn').addEventListener('click', toggleClickThrough)

  // While in click-through mode the window still receives mousemove (forwarded).
  // Hover over the titlebar to temporarily regain interactive control.
  const TITLEBAR_H = 44
  window.addEventListener('mousemove', (e) => {
    if (!isClickThrough) return
    const wantIgnore = e.clientY > TITLEBAR_H
    if (wantIgnore === lastClickThroughState) return
    lastClickThroughState = wantIgnore
    window.electronAPI.setClickThrough(wantIgnore)
  })

  $('stealthBtn').addEventListener('click', async () => {
    const on = await window.electronAPI.toggleStealth()
    $('stealthBtn').style.opacity = on ? '1' : '0.45'
    toast(on ? 'Stealth ON — hidden from screen share' : 'Stealth OFF', on ? 'success' : 'info')
  })

  $('themeBtn').addEventListener('click', async () => {
    const nextDark = currentTheme !== 'dark'
    applyTheme(nextDark)
    settings = await window.electronAPI.saveSettings({ themeOverride: nextDark ? 'dark' : 'light' })
  })

  // Auto-update events
  window.electronAPI.onUpdateAvailable(({ version, releaseNotes }) => {
    const modal = $('updateModal')
    $('updateModalTitle').textContent = 'Update Available'
    $('updateModalVersion').textContent = `v${version} is ready to download`
    const notes = buildChangelog(version, releaseNotes)
    $('updateModalNotes').innerHTML = notes
    $('updateModalProgress').style.display = 'none'
    $('updateModalActions').style.display = 'flex'
    $('updateRestartActions').style.display = 'none'
    modal.style.display = 'flex'
  })

  window.electronAPI.onUpdateProgress(({ percent }) => {
    $('updateModalProgress').style.display = 'block'
    $('updateModalActions').style.display = 'none'
    $('updateProgressFill').style.width = percent + '%'
    $('updateProgressLabel').textContent = `Downloading… ${percent}%`
  })

  window.electronAPI.onUpdateDownloaded(({ version }) => {
    $('updateModalTitle').textContent = 'Ready to Install'
    $('updateModalVersion').textContent = `v${version} downloaded`
    $('updateModalProgress').style.display = 'none'
    $('updateModalActions').style.display = 'none'
    $('updateRestartActions').style.display = 'flex'
    $('updateModal').style.display = 'flex'
  })

  window.electronAPI.onJustUpdated(({ version }) => {
    $('updateModalTitle').textContent = '✅ Update Complete'
    $('updateModalVersion').textContent = `Now running v${version}`
    $('updateModalNotes').innerHTML = buildChangelog(version, '')
    $('updateModalProgress').style.display = 'none'
    $('updateModalActions').style.display = 'none'
    $('updateRestartActions').style.display = 'none'
    $('updateModal').style.display = 'flex'
    setTimeout(() => { $('updateModal').style.display = 'none' }, 8000)
  })

  $('checkUpdateBtn').addEventListener('click', async () => {
    const btn = $('checkUpdateBtn')
    btn.textContent = 'Checking…'
    btn.disabled = true
    await window.electronAPI.checkForUpdates()
    // Reset button after 10s in case no event fires (e.g. in dev mode)
    setTimeout(() => { btn.textContent = 'Check for Updates'; btn.disabled = false }, 10000)
  })

  window.electronAPI.onUpdateNotAvailable(({ version }) => {
    const btn = $('checkUpdateBtn')
    if (btn) { btn.textContent = '✅ Up to date'; btn.disabled = false }
    setTimeout(() => { if (btn) btn.textContent = 'Check for Updates' }, 3000)
    toast(`✅ You're up to date — v${version} is the latest version`, 'success')
  })

  $('updateNowBtn').addEventListener('click', () => {
    $('updateModalActions').style.display = 'none'
    $('updateModalProgress').style.display = 'block'
    $('updateProgressFill').style.width = '0%'
    $('updateProgressLabel').textContent = 'Starting download…'
    window.electronAPI.downloadUpdate()
  })
  $('updateLaterBtn').addEventListener('click', () => { $('updateModal').style.display = 'none' })
  $('updateDismissBtn').addEventListener('click', () => { $('updateModal').style.display = 'none' })
  $('updateInstallBtn').addEventListener('click', () => window.electronAPI.installUpdate())

  await checkMic()
}

let currentTheme = 'dark'

function applyTheme(isDark) {
  currentTheme = isDark ? 'dark' : 'light'
  document.documentElement.setAttribute('data-theme', currentTheme)
}

function applyFontSize(px) {
  document.documentElement.style.setProperty('--fs-transcript', px + 'px')
}

async function checkMic() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true })
    s.getTracks().forEach(t => t.stop())
    $('deviceInfo').textContent = '🎤 Microphone ready'
    $('deviceInfo').className = 'device-info ok'
  } catch {
    $('deviceInfo').textContent = '⚠️ Mic access denied — check browser/OS permissions'
    $('deviceInfo').className = 'device-info warn'
  }
}

// ── Settings form ─────────────────────────────────────────────────────────────

function applyIconDisplay(icon) {
  const el = $('appIconDisplay')
  if (!el) return
  if (icon && icon.startsWith('/')) {
    // Image path — show as <img>
    el.innerHTML = `<img src="file://${icon}" style="width:16px;height:16px;object-fit:contain;border-radius:3px;">`
  } else {
    el.textContent = icon || '👻'
  }
}

async function loadSettingsForm() {
  const s = settings

  // Transcription
  $('transcriptionProvider').value  = s.transcriptionProvider || s.provider || 'deepgram'
  $('deepgramKey').value            = s.deepgramApiKey || ''
  $('gladiaKey').value              = s.gladiaApiKey || ''
  $('assemblyaiKey').value          = s.assemblyaiApiKey || ''
  $('openaiKey').value              = s.openaiApiKey || ''
  $('groqKey').value                = s.groqApiKey || ''
  $('deepgramModel').value          = s.transcriptionModel || s.model || 'nova-3'
  $('deepgramCustomModel').value    = s.transcriptionCustomModel || ''
  $('gladiaModel').value            = s.transcriptionModel || 'fast'
  $('assemblyaiModel').value        = s.transcriptionModel || 'best'
  $('openaiWhisperModel').value     = s.transcriptionModel || 'whisper-1'
  $('openaiCustomModel').value      = s.transcriptionCustomModel || ''
  $('groqWhisperModel').value       = s.transcriptionModel || 'whisper-large-v3'
  $('groqCustomModel').value        = s.transcriptionCustomModel || ''
  $('languageSelect').value         = s.language || 'en'
  $('translateTo').value            = s.translateTo || ''
  $('accentEnhance').checked        = !!s.accentEnhance

  // AI Analysis
  $('analysisProvider').value       = s.analysisProvider || 'claude'
  $('claudeKey').value              = s.claudeApiKey || ''
  $('claudeModel').value            = s.analysisModel || 'claude-haiku-4-5-20251001'
  $('openaiAnalysisKey').value      = s.openaiAnalysisApiKey || ''
  $('perplexityKey').value          = s.perplexityApiKey || ''
  $('groqAnalysisKey').value        = s.groqAnalysisApiKey || ''
  $('geminiKey').value              = s.geminiApiKey || ''
  $('geminiModel').value            = s.analysisModel || 'gemini-1.5-flash'
  $('customApiUrl').value           = s.customApiUrl || ''
  $('customApiKey').value           = s.customApiKey || ''
  $('customApiModel').value         = s.analysisModel || ''
  $('ollamaUrl').value              = s.ollamaUrl || 'http://localhost:11434'
  $('ollamaModel').value            = s.analysisModel || 'llama3.2'

  // Icon preview
  const currentIcon = s.appIconPath || s.appIcon || '👻'
  const preview = $('iconPreview')
  if (s.appIconPath) {
    preview.innerHTML = `<img src="file://${s.appIconPath}" style="width:32px;height:32px;object-fit:contain;border-radius:6px;">`
  } else {
    preview.textContent = s.appIcon || '👻'
  }
  $('emojiGrid').style.display = 'none'

  // Display
  $('stealthCheck').checked         = s.stealthMode !== false
  $('alwaysOnTopCheck').checked     = s.alwaysOnTop !== false
  const opPct = Math.round((s.windowOpacity || 0.93) * 100)
  $('opacityRange').value = opPct; $('opacityLabel').textContent = opPct + '%'
  $('fontRange').value = s.fontSize || 15; $('fontLabel').textContent = (s.fontSize || 15) + 'px'

  syncTranscriptionFields()
  syncAnalysisFields()

  // Check for auto-detectable credentials
  const creds = await window.electronAPI.getAutoCredentials()
  if (creds.hasAnthropicKey) {
    $('autoCredRow').style.display = 'flex'
    $('autoCredSource').textContent = creds.source
  } else {
    $('autoCredRow').style.display = 'none'
  }
}

function syncTranscriptionFields() {
  const p = $('transcriptionProvider').value
  document.querySelectorAll('.provider-fields[id^="stt-"]').forEach(el => el.style.display = 'none')
  const target = $('stt-' + p)
  if (target) target.style.display = 'block'
}


function syncAnalysisFields() {
  const p = $('analysisProvider').value
  document.querySelectorAll('.provider-fields[id^="ai-"]').forEach(el => el.style.display = 'none')
  const target = $('ai-' + p)
  if (target) target.style.display = 'block'
}

async function applyAutoCredentials() {
  const result = await window.electronAPI.useAutoCredentials()
  if (result.success) {
    settings = await window.electronAPI.getSettings()
    $('claudeKey').value = settings.claudeApiKey || ''
    $('analysisProvider').value = 'claude'
    syncAnalysisFields()
    toast('Claude Code credentials applied', 'success')
  } else {
    toast('Could not detect credentials', 'error')
  }
}

async function saveSettings() {
  const opacity = parseInt($('opacityRange').value) / 100
  const analysisProv = $('analysisProvider').value
  let analysisModel = ''
  if (analysisProv === 'claude')      analysisModel = $('claudeModel').value
  if (analysisProv === 'openai')      analysisModel = $('openaiAnalysisModel').value
  if (analysisProv === 'perplexity')  analysisModel = $('perplexityModel').value
  if (analysisProv === 'groq')        analysisModel = $('groqAnalysisModel').value
  if (analysisProv === 'gemini')      analysisModel = $('geminiModel').value
  if (analysisProv === 'custom')      analysisModel = $('customApiModel').value
  if (analysisProv === 'ollama')      analysisModel = $('ollamaModel').value

  const transcProv = $('transcriptionProvider').value
  let transcModel = ''
  let transcCustomModel = ''
  if (transcProv === 'deepgram')   { transcModel = $('deepgramModel').value;      transcCustomModel = $('deepgramCustomModel').value.trim() }
  if (transcProv === 'gladia')     { transcModel = $('gladiaModel').value }
  if (transcProv === 'assemblyai') { transcModel = $('assemblyaiModel').value }
  if (transcProv === 'openai')     { transcModel = $('openaiWhisperModel').value; transcCustomModel = $('openaiCustomModel').value.trim() }
  if (transcProv === 'groq')       { transcModel = $('groqWhisperModel').value;   transcCustomModel = $('groqCustomModel').value.trim() }
  const finalTranscModel = transcCustomModel || transcModel

  const updates = {
    // Transcription
    transcriptionProvider:    transcProv,
    transcriptionModel:       finalTranscModel,
    transcriptionCustomModel: transcCustomModel,
    deepgramApiKey:           $('deepgramKey').value.trim(),
    gladiaApiKey:             $('gladiaKey').value.trim(),
    assemblyaiApiKey:         $('assemblyaiKey').value.trim(),
    openaiApiKey:             $('openaiKey').value.trim(),
    groqApiKey:               $('groqKey').value.trim(),
    language:              $('languageSelect').value,
    translateTo:           $('translateTo').value,
    accentEnhance:         $('accentEnhance').checked,
    // AI Analysis
    analysisProvider:      analysisProv,
    analysisModel,
    claudeApiKey:          $('claudeKey').value.trim(),
    openaiAnalysisApiKey:  $('openaiAnalysisKey').value.trim(),
    perplexityApiKey:      $('perplexityKey').value.trim(),
    groqAnalysisApiKey:    $('groqAnalysisKey').value.trim(),
    geminiApiKey:          $('geminiKey').value.trim(),
    customApiUrl:          $('customApiUrl').value.trim(),
    customApiKey:          $('customApiKey').value.trim(),
    ollamaUrl:             $('ollamaUrl').value.trim() || 'http://localhost:11434',
    // Display
    stealthMode:    $('stealthCheck').checked,
    alwaysOnTop:    $('alwaysOnTopCheck').checked,
    windowOpacity:  opacity,
    fontSize:       parseInt($('fontRange').value),
    // Legacy alias
    provider:       transcProv,
    model:          transcModel,
  }
  settings = await window.electronAPI.saveSettings(updates)
  applyFontSize(settings.fontSize)
  showView('main')
  toast('Settings saved', 'success')
}

// ── Recording ─────────────────────────────────────────────────────────────────

async function toggleRecording() {
  if (isRecording) {
    await stopRecording()
  } else {
    await startRecording()
  }
}

async function startRecording() {
  const provider = settings.transcriptionProvider || settings.provider || 'deepgram'
  const apiKeyMap = {
    deepgram:   settings.deepgramApiKey,
    gladia:     settings.gladiaApiKey,
    assemblyai: settings.assemblyaiApiKey,
    openai:     settings.openaiApiKey,
    groq:       settings.groqApiKey,
  }
  const apiKey = apiKeyMap[provider] || ''

  if (!apiKey) {
    toast('No API key set — open ⚙ Settings', 'error')
    await loadSettingsForm()
    showView('settings')
    return
  }

  const result = await window.electronAPI.startRecording({
    provider,
    apiKey,
    options: {
      model: settings.transcriptionModel || settings.model || 'nova-3',
      language: settings.language || 'multi',
    },
  })

  if (!result.success) {
    toast('Connection failed: ' + result.error, 'error')
    return
  }

  // Start audio capture
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: SAMPLE_RATE,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
  } catch (err) {
    toast('Mic error: ' + err.message, 'error')
    return
  }

  audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE })
  await audioCtx.audioWorklet.addModule('audio-processor.js')
  sourceNode = audioCtx.createMediaStreamSource(audioStream)
  processor = new AudioWorkletNode(audioCtx, 'audio-capture')

  processor.port.onmessage = (e) => {
    if (!isRecording || isPaused) return
    netBytesSent += e.data.byteLength
    netLastSent = Date.now()
    window.electronAPI.sendAudio(e.data)
  }

  sourceNode.connect(processor)
  processor.connect(audioCtx.destination)

  // Update UI
  isRecording = true
  activeSpeakers = new Set()
  speakerTexts = {}
  speakerNames = {}
  toneResult = null
  totalSessionWords = 0
  midSessionAnalysisDone = false
  netBytesSent = 0
  netBytesReceived = 0
  netLatencies = []
  netLastSent = null
  netAnalysisCost = 0
  $('netBar').style.display = 'flex'
  $('transcript').innerHTML = ''
  $('interim').textContent = ''
  $('placeholder').style.display = 'none'
  $('speakerLegend').innerHTML = ''
  isPaused = false
  $('recordBtn').classList.add('recording')
  $('recordIcon').textContent = '■'
  $('recordLabel').textContent = 'Stop Recording'
  $('pauseBtn').style.display = 'flex'
  $('pauseBtn').textContent = '⏸'
  $('pauseBtn').classList.remove('paused')
  timerSecs = 0
  timerInterval = setInterval(() => {
    if (!isPaused) timerSecs++
    $('timer').textContent = fmt(timerSecs)
    updateNetBar()
  }, 1000)
  setStatus('recording', 'Recording…')
}

function togglePause() {
  if (!isRecording) return
  isPaused = !isPaused
  if (isPaused) {
    $('pauseBtn').textContent = '▶'
    $('pauseBtn').classList.add('paused')
    $('interim').textContent = ''
    setStatus('reconnecting', 'Paused')
  } else {
    $('pauseBtn').textContent = '⏸'
    $('pauseBtn').classList.remove('paused')
    setStatus('recording', 'Recording…')
  }
}

async function stopRecording() {
  isRecording = false
  isPaused = false
  $('pauseBtn').style.display = 'none'
  $('pauseBtn').classList.remove('paused')
  clearInterval(timerInterval)

  // Tear down audio
  if (processor) { processor.disconnect(); processor = null }
  if (sourceNode) { sourceNode.disconnect(); sourceNode = null }
  if (audioStream) { audioStream.getTracks().forEach(t => t.stop()); audioStream = null }
  if (audioCtx) { await audioCtx.close(); audioCtx = null }

  $('netBar').style.display = 'none'

  // Get summary from main
  const summary = await window.electronAPI.stopRecording()
  currentSummary = summary

  $('recordBtn').classList.remove('recording')
  $('recordIcon').textContent = '●'
  $('recordLabel').textContent = 'Start Recording'
  setStatus('idle', 'Done')

  if (summary && summary.speakerCount > 0) {
    renderSummary(summary)
    renderNetworkCost(summary)
    showView('summary')
    runToneAnalysis(summary.fullTranscript)
  }
}

// ── Transcription Events ──────────────────────────────────────────────────────

function onTranscription(data) {
  if (!isRecording) return

  // Track latency and bytes received
  if (netLastSent) {
    const lat = Date.now() - netLastSent
    if (lat > 0 && lat < 8000) netLatencies.push(lat)
  }
  netBytesReceived += JSON.stringify(data).length

  if (!data.isFinal) {
    $('interim').textContent = data.transcript
    return
  }

  $('interim').textContent = ''

  for (const seg of data.segments) {
    const text = seg.text.trim()
    if (!text) continue

    const spk = seg.speaker ?? 0
    // Track silently for end-of-session summary
    activeSpeakers.add(spk)
    speakerTexts[spk] = (speakerTexts[spk] || '') + ' ' + text

    // Instant name/role detection from this segment
    tryExtractSpeakerName(spk, text)

    // Count words and trigger background AI identification once there's enough context
    totalSessionWords += text.split(/\s+/).filter(Boolean).length
    if (!midSessionAnalysisDone && totalSessionWords >= 150 && Object.keys(speakerTexts).length >= 2) {
      midSessionAnalysisDone = true
      runMidSessionIdentification()
    }

    // Show plain text live — speaker identification appears in the summary at the end
    const row = el('div', 'seg')
    const textEl = el('span', 'seg-text', esc(text))
    row.appendChild(textEl)
    $('transcript').appendChild(row)

    const toLang = settings.translateTo
    const enhance = settings.accentEnhance

    if (enhance || toLang) {
      // Step 1: enhance accent (corrects mishearings) then translate corrected text
      const pipeline = async () => {
        let displayText = text
        if (enhance) {
          const corrected = await window.electronAPI.enhanceTranscript(text)
          if (corrected && corrected !== text) {
            displayText = corrected
            textEl.textContent = corrected
            speakerTexts[spk] = (speakerTexts[spk] || '').replace(text, corrected)
          }
        }
        if (toLang) {
          const translationEl = el('div', 'seg-translation', '…')
          row.appendChild(translationEl)
          const translated = await window.electronAPI.translateText(displayText, toLang)
          if (translated && translated !== displayText) translationEl.textContent = translated
          else translationEl.remove()
        }
        $('transcriptBox').scrollTop = $('transcriptBox').scrollHeight
      }
      pipeline()
    }
  }

  const box = $('transcriptBox')
  box.scrollTop = box.scrollHeight
}

function onProviderStatus({ status, provider }) {
  if (status === 'connected') {
    setStatus('connected', `Connected to ${provider}`)
  } else if (status === 'reconnecting') {
    setStatus('reconnecting', 'Reconnecting…')
  } else {
    setStatus('idle', 'Disconnected')
  }
}

function onError(msg) {
  toast(msg, 'error')
  // Only auto-stop when all reconnect attempts are exhausted — keep recording for transient errors
  if (isRecording && msg.includes('Could not reconnect')) stopRecording()
}

// ── Speaker Legend ─────────────────────────────────────────────────────────────

function updateLegend() {
  const legend = $('speakerLegend')
  const sorted = Array.from(activeSpeakers).sort()
  legend.innerHTML = ''
  legend.className = 'speaker-legend' + (sorted.length >= 6 ? ' many' : '')

  sorted.forEach(id => {
    const label = sorted.length >= 7 ? `● S${id + 1}` : `● Speaker ${id + 1}`
    const chip = el('span', 'legend-chip', label)
    chip.style.color = spkColor(id)
    chip.title = `Speaker ${id + 1}`
    legend.appendChild(chip)
  })
}

// ── Summary ───────────────────────────────────────────────────────────────────

// ── Tone Analysis ─────────────────────────────────────────────────────────────

async function runToneAnalysis(fullTranscript) {
  if (!fullTranscript?.trim()) {
    await saveCurrentSession()
    return
  }
  if ($('toneStatus')) $('toneStatus').style.display = 'flex'

  const analysisProv = settings.analysisProvider || 'claude'
  const analysisKeyMap = {
    claude:     settings.claudeApiKey,
    openai:     settings.openaiAnalysisApiKey,
    perplexity: settings.perplexityApiKey,
    groq:       settings.groqAnalysisApiKey,
    gemini:     settings.geminiApiKey,
    custom:     settings.customApiKey,
  }

  toneResult = await window.electronAPI.analyzeTone({
    fullTranscript,
    speakerTexts,
    config: {
      provider:     analysisProv,
      apiKey:       analysisKeyMap[analysisProv] || '',
      model:        settings.analysisModel || '',
      ollamaUrl:    settings.ollamaUrl || 'http://localhost:11434',
      customApiUrl: settings.customApiUrl || '',
    },
  })

  if ($('toneStatus')) $('toneStatus').style.display = 'none'
  if (toneResult && !toneResult.error) renderToneAnalysis(toneResult)
  await saveCurrentSession()
}

async function saveCurrentSession() {
  if (!currentSummary || currentSummary.speakerCount === 0) return
  const entry = {
    id: new Date().toISOString(),
    date: new Date().toISOString(),
    duration: currentSummary.duration,
    speakerCount: currentSummary.speakerCount,
    summary: currentSummary,
    toneAnalysis: (toneResult && !toneResult.error) ? toneResult : null,
    speakerNames: { ...speakerNames },
  }
  await window.electronAPI.saveHistoryEntry(entry)
}

async function loadHistoryView() {
  const history = await window.electronAPI.getHistory()
  const list = $('historyList')

  if (!history || history.length === 0) {
    list.innerHTML = '<div class="history-empty">No sessions recorded yet</div>'
    showView('history')
    return
  }

  list.innerHTML = history.map(entry => {
    const d = new Date(entry.date)
    const dateStr = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const rawPreview = (entry.summary?.fullTranscript || '').replace(/\[Speaker \d+\]: /g, '').slice(0, 70)
    const preview = rawPreview ? esc(rawPreview) + '…' : ''

    return `
      <div class="hist-entry" data-id="${esc(entry.id)}">
        <div class="hist-entry-header">
          <div class="hist-entry-info">
            <span class="hist-date">${esc(dateStr)}</span>
            <span class="hist-meta">${fmt(entry.duration || 0)} · ${entry.speakerCount} speaker${entry.speakerCount !== 1 ? 's' : ''}</span>
            ${preview ? `<span class="hist-preview">${preview}</span>` : ''}
          </div>
          <div class="hist-entry-actions">
            <button class="hist-expand-btn" title="Expand">▶</button>
            <button class="hist-del-btn" title="Delete">✕</button>
          </div>
        </div>
        <div class="hist-entry-body" style="display:none">
          ${entry.toneAnalysis ? renderHistoryTone(entry.toneAnalysis, entry.speakerNames || {}) : ''}
          <div class="hist-transcript-label">Full Transcript</div>
          <div class="hist-transcript">${esc(entry.summary?.fullTranscript || '(empty)').replace(/\n/g, '<br>')}</div>
        </div>
      </div>`
  }).join('')

  list.querySelectorAll('.hist-expand-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const body = btn.closest('.hist-entry').querySelector('.hist-entry-body')
      const open = body.style.display !== 'none'
      body.style.display = open ? 'none' : 'block'
      btn.textContent = open ? '▶' : '▼'
    })
  })

  list.querySelectorAll('.hist-del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const row = btn.closest('.hist-entry')
      await window.electronAPI.deleteHistoryEntry(row.dataset.id)
      row.remove()
      if (!list.querySelector('.hist-entry')) {
        list.innerHTML = '<div class="history-empty">No sessions recorded yet</div>'
      }
    })
  })

  showView('history')
}

function renderHistoryTone(tone, names) {
  if (!tone || !tone.speakers) return ''
  let html = '<div class="hist-tone-block">'
  if (tone.overall_dynamic) html += `<div class="hist-tone-overall"><strong>Overall:</strong> ${esc(tone.overall_dynamic)}</div>`
  if (tone.key_topics?.length) {
    html += `<div class="hist-tone-topics">${tone.key_topics.map(t => `<span class="topic-chip">${esc(t)}</span>`).join('')}</div>`
  }
  for (const [id, a] of Object.entries(tone.speakers)) {
    const spkId = parseInt(id) - 1
    const name = a.name || names[spkId] || `Speaker ${id}`
    html += `<div class="hist-tone-spk" style="border-left:3px solid ${spkColor(spkId)}">
      <span style="color:${spkColor(spkId)};font-weight:600">${esc(name)}</span>
      <span class="badge">${esc(a.tone || '–')}</span>
      <span class="badge ${sentClass(a.sentiment)}">${esc(a.sentiment || '–')}</span>
    </div>`
  }
  html += '</div>'
  return html
}

// Store identified speaker names so renderSummary and live transcript can use them
let speakerNames = {}

// ── Network & Cost ────────────────────────────────────────────────────────────

const TRANSCRIPTION_RATE = {
  deepgram:   0.0043,  // per minute
  gladia:     0.00,
  assemblyai: 0.0108,
  openai:     0.0060,
  groq:       0.00,
}

const ANALYSIS_RATE = {
  claude:     0.00025,  // per 1k tokens (haiku input)
  openai:     0.00015,  // gpt-4o-mini
  groq:       0.00005,
  gemini:     0.00,
  perplexity: 0.00020,
  ollama:     0.00,
  custom:     0.00,
}

function fmtBytes(b) {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

function transcriptionCost(secs) {
  const rate = TRANSCRIPTION_RATE[settings.transcriptionProvider] || 0
  return rate * (secs / 60)
}

function updateNetBar() {
  if (!isRecording) return
  const sentEl = $('netSent')
  const latEl  = $('netLatency')
  const costEl = $('netCostEst')
  if (!sentEl) return

  sentEl.textContent = `↑ ${fmtBytes(netBytesSent)}`

  const recent = netLatencies.slice(-10)
  if (recent.length) {
    const avg = Math.round(recent.reduce((a, b) => a + b, 0) / recent.length)
    latEl.textContent = `⚡ ${avg}ms`
    latEl.style.color = avg < 500 ? 'var(--success)' : avg < 1500 ? 'var(--warning)' : 'var(--danger)'
  }

  const cost = transcriptionCost(timerSecs)
  costEl.textContent = `~$${cost.toFixed(4)}`
}

function renderNetworkCost(summary) {
  const sec = $('networkCost')
  if (!sec) return

  const transcCost = transcriptionCost(summary.duration)
  const fullText   = summary.fullTranscript || ''
  const estTokens  = Math.round(fullText.length / 4)
  const analysisProv = settings.analysisProvider || 'claude'
  const analysisCost = (ANALYSIS_RATE[analysisProv] || 0) * (estTokens / 1000)
  const totalCost  = transcCost + analysisCost

  const totalSent = netBytesSent + netBytesReceived
  const avgLat = netLatencies.length
    ? Math.round(netLatencies.reduce((a, b) => a + b, 0) / netLatencies.length)
    : null

  sec.innerHTML = `
    <div class="nc-header">📡 Network &amp; Cost</div>
    <div class="nc-row">
      <span class="nc-label">Data transferred</span>
      <span class="nc-val">${fmtBytes(totalSent)}</span>
    </div>
    <div class="nc-row">
      <span class="nc-label">Avg latency</span>
      <span class="nc-val">${avgLat ? avgLat + 'ms' : '–'}</span>
    </div>
    <div class="nc-row">
      <span class="nc-label">Transcription (${settings.transcriptionProvider})</span>
      <span class="nc-val">${transcCost > 0 ? '~$' + transcCost.toFixed(4) : 'Free'}</span>
    </div>
    <div class="nc-row">
      <span class="nc-label">AI Analysis (${analysisProv})</span>
      <span class="nc-val">${analysisCost > 0 ? '~$' + analysisCost.toFixed(4) + ' (~' + estTokens.toLocaleString() + ' tokens)' : 'Free'}</span>
    </div>
    <div class="nc-row nc-total">
      <span class="nc-label">Total estimated cost</span>
      <span class="nc-val">${totalCost > 0 ? '~$' + totalCost.toFixed(4) : 'Free'}</span>
    </div>
  `
  sec.style.display = 'block'
}

// After tone analysis resolves names, back-fill all labeled elements in the DOM
function updateSpeakerLabels() {
  document.querySelectorAll('[data-spk]').forEach(node => {
    const id = parseInt(node.dataset.spk)
    if (speakerNames[id]) node.textContent = speakerNames[id]
  })
}

// Words that look like names in "I'm ___" but aren't
const NOT_A_NAME = new Set([
  'good','great','fine','here','ready','done','sure','right','okay','ok','well',
  'just','back','also','next','very','excited','happy','glad','sorry','not','going',
  'calling','joining','available','speaking','interviewing','interested','looking',
  'working','trying','hoping','currently','previously','actually','basically',
])

// Instant name/role extraction — catches self-introductions as they're spoken
function tryExtractSpeakerName(spk, text) {
  if (speakerNames[spk]) return

  // Role self-identification patterns
  const rolePat = [
    [/\bi(?:'m| am) the (?:lead |senior |head )?interviewer\b/i, 'Interviewer'],
    [/\bi(?:'m| am) (?:one of )?the (?:panel )?interviewers?\b/i, `Panel Interviewer ${spk + 1}`],
    [/\bi(?:'m| am) (?:a |the )?(?:job )?candidate\b/i, 'Candidate'],
    [/\bi(?:'m| am) (?:a |the )?hiring manager\b/i, 'Hiring Manager'],
    [/\bi(?:'m| am) (?:a |the )?recruiter\b/i, 'Recruiter'],
    [/\bi(?:'m| am) (?:a |the )?moderator\b/i, 'Moderator'],
    [/\bi(?:'m| am) (?:a |the )?panelist\b/i, `Panelist ${spk + 1}`],
    [/\bi(?:'m| am) (?:a |the )?presenter\b/i, 'Presenter'],
    [/\bi(?:'m| am) (?:a |the )?host\b/i, 'Host'],
  ]
  for (const [re, role] of rolePat) {
    if (re.test(text)) { speakerNames[spk] = role; updateSpeakerLabels(); return }
  }

  // Name self-identification: "I'm John", "my name is Sarah", "This is Mark", "I go by Alex"
  const namePat = [
    /\bI(?:'m| am) ([A-Z][a-z]{2,15})\b/,
    /\bmy name(?:'s| is) ([A-Z][a-z]{2,15})\b/i,
    /\bThis is ([A-Z][a-z]{2,15})\b/,
    /\bI go by ([A-Z][a-z]{2,15})\b/i,
    /\bCall me ([A-Z][a-z]{2,15})\b/i,
  ]
  for (const re of namePat) {
    const m = text.match(re)
    if (m && m[1] && !NOT_A_NAME.has(m[1].toLowerCase())) {
      speakerNames[spk] = m[1]
      updateSpeakerLabels()
      return
    }
  }
}

// Background AI identification after enough transcript has accumulated
async function runMidSessionIdentification() {
  const provider = settings.analysisProvider || 'claude'
  const keyMap = {
    claude:     settings.claudeApiKey,
    openai:     settings.openaiAnalysisApiKey,
    perplexity: settings.perplexityApiKey,
    groq:       settings.groqAnalysisApiKey,
    gemini:     settings.geminiApiKey,
    custom:     settings.customApiKey,
  }
  const apiKey = keyMap[provider] || ''
  if (!apiKey && provider !== 'ollama' && provider !== 'custom') return

  const lines = Object.entries(speakerTexts).map(([id, t]) =>
    `[Speaker ${parseInt(id) + 1}]: ${t.trim().slice(0, 500)}`
  )

  try {
    const result = await window.electronAPI.analyzeTone({
      fullTranscript: lines.join('\n'),
      speakerTexts,
      config: {
        provider,
        apiKey,
        model:        settings.analysisModel || '',
        ollamaUrl:    settings.ollamaUrl || 'http://localhost:11434',
        customApiUrl: settings.customApiUrl || '',
      },
    })
    if (result?.speakers) {
      for (const [id, a] of Object.entries(result.speakers)) {
        const spkId = parseInt(id) - 1
        if (a.name && !speakerNames[spkId]) speakerNames[spkId] = a.name
      }
      updateSpeakerLabels()
    }
  } catch {}
}

function renderToneAnalysis(tone) {
  const sec = $('toneContent')
  if (!sec) return
  let html = '<div class="tone-header">Tone & Sentiment Analysis</div>'

  // Rich analysis — works for claude, groq, openai, perplexity, ollama
  if (tone.speakers && Object.keys(tone.speakers).length > 0) {
    const src = tone.source || 'AI'
    html += `<div class="tone-row muted" style="font-size:10px">Powered by ${esc(src)}</div>`
    if (tone.overall_dynamic) html += `<div class="tone-row"><strong>Overall:</strong> <em>${esc(tone.overall_dynamic)}</em></div>`
    if (tone.key_topics?.length) {
      html += `<div class="tone-row"><strong>Topics:</strong> ${tone.key_topics.map(t => `<span class="topic-chip">${esc(t)}</span>`).join('')}</div>`
    }
    speakerNames = {}
    for (const [id, a] of Object.entries(tone.speakers)) {
      const spkId = parseInt(id) - 1
      const displayName = a.name || `Speaker ${id}`
      speakerNames[spkId] = displayName
      html += `
        <div class="tone-speaker" style="border-left:3px solid ${spkColor(spkId)}">
          <div class="tone-spk-name" style="color:${spkColor(spkId)}">${esc(displayName)}</div>
          <div class="sum-badges">
            <span class="badge">${esc(a.tone || '–')}</span>
            <span class="badge ${sentClass(a.sentiment)}">${esc(a.sentiment || '–')}</span>
          </div>
          ${a.speech_pattern ? `<div class="tone-detail"><strong>Pattern:</strong> ${esc(a.speech_pattern)}</div>` : ''}
          ${a.observation ? `<div class="tone-detail"><strong>Note:</strong> ${esc(a.observation)}</div>` : ''}
        </div>`
    }
    // Back-fill speaker names on live transcript and summary cards
    updateSpeakerLabels()
  } else if (tone.speakers_sentiment) {
    html += '<div class="tone-row muted">Basic sentiment — add a Groq, Claude, or any AI key in Settings for full speaker identification</div>'
    for (const [id, s] of Object.entries(tone.speakers_sentiment)) {
      const spkId = parseInt(id)
      html += `
        <div class="tone-speaker" style="border-left:3px solid ${spkColor(spkId)}">
          <div class="tone-spk-name" style="color:${spkColor(spkId)}">Speaker ${spkId + 1}</div>
          <div class="sum-badges">
            <span class="badge ${sentClass(s.label.toLowerCase())}">${s.label}</span>
            <span class="badge">Score: ${s.score}</span>
            ${s.top_positive?.length ? `<span class="badge conf-high">+ ${s.top_positive.slice(0,3).join(', ')}</span>` : ''}
            ${s.top_negative?.length ? `<span class="badge conf-low">− ${s.top_negative.slice(0,3).join(', ')}</span>` : ''}
          </div>
        </div>`
    }
  }

  sec.innerHTML = html
  sec.style.display = 'block'
}

function sentClass(s) {
  if (!s) return ''
  const l = s.toLowerCase()
  return l === 'positive' ? 'conf-high' : l === 'negative' ? 'conf-low' : 'conf-medium'
}

function renderSummary(s) {
  const many = s.speakers.length >= 5
  let html = `
    <div class="sum-stat">Duration: <strong>${fmt(s.duration)}</strong></div>
    <div class="sum-stat">Speakers detected: <strong>${s.speakerCount}</strong></div>
  `
  if (s.speakerCount <= 1) {
    html += `<div class="sum-warn">⚠ Only 1 speaker detected. If there were multiple speakers, open <strong>⚙ Settings → Language</strong> and pick a specific language (e.g. English). Auto-Detect mode disables speaker separation.</div>`
  }
  // 2-column compact grid for 5+ speakers so cards fit on screen
  if (many) html += '<div class="sum-grid">'

  for (const spk of s.speakers) {
    const color = spkColor(spk.id)
    const confClass = spk.confidenceLabel?.toLowerCase() || 'medium'
    const confPct = Math.round((spk.avgConfidence || 0) * 100)
    const share = spk.talkingShare ?? 0
    const identifiedName = speakerNames[spk.id]
    const displayName = identifiedName || `Speaker ${spk.id + 1}`
    html += `
      <div class="sum-speaker" style="border-left:3px solid ${color}">
        <div class="sum-spk-name" data-spk="${spk.id}" style="color:${color}">${esc(displayName)}</div>
        <div class="sum-badges">
          <span class="badge">📝 ${spk.wordCount} words</span>
          <span class="badge">${spk.wpm} WPM — ${spk.speechRate}</span>
        </div>
        <div class="stat-bar-row">
          <span class="stat-bar-label">Talking</span>
          <div class="stat-bar-wrap">
            <div class="stat-bar" style="width:${share}%;background:${color}"></div>
          </div>
          <span class="stat-bar-val">${share}%</span>
        </div>
        <div class="stat-bar-row">
          <span class="stat-bar-label">Confidence</span>
          <div class="stat-bar-wrap">
            <div class="stat-bar stat-bar-conf-${confClass}" style="width:${confPct}%"></div>
          </div>
          <span class="stat-bar-val conf-${confClass}">${confPct}%</span>
        </div>
      </div>`
  }

  if (many) html += '</div>'
  $('summaryContent').innerHTML = html
}

async function doSaveDocx() {
  if (!currentSummary) return
  toast('Generating DOCX…', 'info')
  const result = await window.electronAPI.saveDocx({
    summary: currentSummary,
    toneAnalysis: toneResult,
  })
  if (result.success) toast('Saved: ' + result.path, 'success')
  else if (result.error) toast('DOCX error: ' + result.error, 'error')
}

async function doSaveTranscript() {
  if (!currentSummary) return
  const lines = [
    '# Ghost Scribe Transcript',
    `Date: ${new Date().toLocaleString()}`,
    `Duration: ${fmt(currentSummary.duration)}`,
    `Speakers: ${currentSummary.speakerCount}`,
    '',
  ]
  if (currentSummary.speakers?.length) {
    lines.push('## Speaker Statistics', '')
    for (const spk of currentSummary.speakers) {
      lines.push(`### Speaker ${spk.id + 1}`)
      lines.push(`- Words: ${spk.wordCount}`)
      lines.push(`- Confidence: ${spk.confidenceLabel} (${Math.round((spk.avgConfidence || 0) * 100)}%)`)
      lines.push(`- Speech Rate: ${spk.wpm} WPM (${spk.speechRate})`)
      lines.push('')
    }
  }
  lines.push('## Transcript', '', currentSummary.fullTranscript || '(empty)')
  const result = await window.electronAPI.saveTranscript(lines.join('\n'))
  if (result.success) toast('Saved to ' + result.path, 'success')
  else toast('Save failed' + (result.error ? ': ' + result.error : ''), 'error')
}

function resetSession() {
  currentSummary = null
  toneResult = null
  activeSpeakers = new Set()
  speakerTexts = {}
  $('transcript').innerHTML = ''
  $('interim').textContent = ''
  $('speakerLegend').innerHTML = ''
  $('placeholder').style.display = 'flex'
  if ($('summaryContent')) $('summaryContent').innerHTML = ''
  if ($('toneContent')) { $('toneContent').style.display = 'none'; $('toneContent').innerHTML = '' }
  if ($('networkCost')) { $('networkCost').style.display = 'none'; $('networkCost').innerHTML = '' }
  timerSecs = 0
  $('timer').textContent = '00:00'
  setStatus('idle', 'Ready')
  showView('main')
}

// ── Click-through ─────────────────────────────────────────────────────────────

function toggleClickThrough() {
  isClickThrough = !isClickThrough
  const btn = $('clickThroughBtn')

  if (isClickThrough) {
    // Immediately enter click-through; hover the titlebar to interact
    lastClickThroughState = true
    window.electronAPI.setClickThrough(true)
    btn.classList.add('btn-active')
    btn.title = 'Click-through ON — move mouse to top of window to interact'
    document.documentElement.classList.add('click-through-mode')
    toast('Click-through ON — hover top of window to use controls', 'info')
  } else {
    // Restore full interactivity
    lastClickThroughState = false
    window.electronAPI.setClickThrough(false)
    btn.classList.remove('btn-active')
    btn.title = 'Click-through mode — clicks pass to app behind'
    document.documentElement.classList.remove('click-through-mode')
  }
}

// ── Changelog ─────────────────────────────────────────────────────────────────

const CHANGELOG = {
  '1.8.5': [
    'Audio processing moved to dedicated thread (AudioWorklet) — lower CPU usage',
    'No longer competes with Android Studio, Discord, or other heavy apps for CPU',
  ],
  '1.8.4': [
    'Live network monitor — shows data sent and latency during recording',
    'Cost breakdown in summary — transcription + AI analysis estimated cost per session',
    'Latency color coded: green = fast, orange = moderate, red = slow',
  ],
  '1.8.3': [
    'New transcription provider: Gladia (real-time, free tier)',
    'Expanded model lists for all providers (Deepgram medical/meeting/phonecall, OpenAI gpt-4o-transcribe, etc.)',
    'Custom model field on every provider — type any model name to use it',
  ],
  '1.8.2': [
    'Fixed update modal not responding to button clicks',
    'Check for Updates now shows a toast when already on latest version',
  ],
  '1.8.1': [
    'Check for Updates now shows "You\'re up to date" when no update is available',
    'Update prompt appears automatically when a new version is found',
  ],
  '1.8.0': [
    'Automatic releases — updates now publish automatically on every code push',
    'Any AI provider supported: Gemini, DeepSeek, Mistral, xAI Grok, and more',
    'Fixed: Settings button was not clickable',
  ],
  '1.7.8': [
    'Fixed: Settings button was not clickable',
  ],
  '1.7.7': [
    'Check for Updates button added to Settings',
    'Changelog now shows for all recent versions',
    'Speaker diarization works in all language modes including Auto-Detect',
    'Live transcript shows clean text — speaker ID appears in summary only',
  ],
  '1.7.6': [
    'Live transcript shows clean flowing text — no speaker labels during recording',
    'Full speaker identification (name, role, confidence, talking share) in summary only',
  ],
  '1.7.5': [
    'Speaker diarization now works in Auto-Detect (multi-language) mode',
    'Speakers separated by voice even when speaking the same language',
  ],
  '1.7.4': [
    'Update prompt asks before downloading — you choose when to update',
    'Changelog shown for each new version',
    'Download progress bar + Restart & Install button',
  ],
  '1.7.3': [
    'Version number shown in title bar and settings',
    'Update prompt now asks before downloading and shows what changed',
  ],
  '1.7.2': [
    'Auto speaker detection during live recording',
    'Instant role ID from speech ("I\'m the interviewer", "I\'m John", etc.)',
    'Mid-session AI analysis identifies roles after 150 words',
  ],
  '1.7.1': [
    'Fixed: only 1 speaker shown — Auto-Detect disabled diarization',
    'Default language changed to English for speaker separation',
    'Warning shown when Auto-Detect is selected in settings',
  ],
  '1.7.0': [
    'Live speaker labels on every transcript line',
    'Talking share progress bar per speaker in summary',
    'Confidence progress bar per speaker in summary',
    'Panel interview role detection (Panel Interviewer 1/2, Candidate)',
  ],
  '1.6.0': [
    'Speaker identification in AI tone analysis',
    'All AI providers now working (Claude, OpenAI, Groq, Perplexity, Ollama)',
  ],
}

function buildChangelog(version, releaseNotes) {
  const known = CHANGELOG[version]
  if (known?.length) {
    return `<ul class="update-changelog">${known.map(l => `<li>${esc(l)}</li>`).join('')}</ul>`
  }
  if (releaseNotes) {
    const plain = releaseNotes.replace(/<[^>]+>/g, '').trim()
    return `<div class="update-notes-text">${esc(plain)}</div>`
  }
  return `<div class="update-notes-text muted">See GitHub for full release notes.</div>`
}

// ── Boot ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init)
