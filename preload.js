'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),
  getTheme: () => ipcRenderer.invoke('get-theme'),
  getVersion: () => ipcRenderer.invoke('get-version'),

  // Recording
  startRecording: (config) => ipcRenderer.invoke('start-recording', config),
  sendAudio: (buffer) => ipcRenderer.send('audio-data', buffer),
  stopRecording: () => ipcRenderer.invoke('stop-recording'),

  // Translation
  translateText: (text, toLang) => ipcRenderer.invoke('translate-text', text, toLang),
  enhanceTranscript: (text) => ipcRenderer.invoke('enhance-transcript', text),

  // File
  saveTranscript: (content) => ipcRenderer.invoke('save-transcript', content),
  saveDocx: (payload) => ipcRenderer.invoke('save-docx', payload),
  analyzeTone: (payload) => ipcRenderer.invoke('analyze-tone', payload),

  // Credentials
  getAutoCredentials: () => ipcRenderer.invoke('get-auto-credentials'),
  useAutoCredentials: () => ipcRenderer.invoke('use-auto-credentials'),

  // Click-through (fire-and-forget — no response needed)
  setClickThrough: (enable) => ipcRenderer.send('set-click-through', enable),

  // Window controls
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  closeWindow: () => ipcRenderer.invoke('close-window'),
  toggleAlwaysOnTop: () => ipcRenderer.invoke('toggle-always-on-top'),
  toggleStealth: () => ipcRenderer.invoke('toggle-stealth'),

  // Events (renderer listens to main)
  onTranscription: (cb) => ipcRenderer.on('transcription', (_, d) => cb(d)),
  onProviderStatus: (cb) => ipcRenderer.on('provider-status', (_, d) => cb(d)),
  onThemeChanged: (cb) => ipcRenderer.on('theme-changed', (_, d) => cb(d)),
  onError: (cb) => ipcRenderer.on('error', (_, d) => cb(d)),
  removeAllListeners: (ch) => ipcRenderer.removeAllListeners(ch),

  // History
  getHistory: () => ipcRenderer.invoke('get-history'),
  saveHistoryEntry: (entry) => ipcRenderer.invoke('save-history-entry', entry),
  deleteHistoryEntry: (id) => ipcRenderer.invoke('delete-history-entry', id),
  clearHistory: () => ipcRenderer.invoke('clear-history'),

  // Custom icon
  pickIconFile: () => ipcRenderer.invoke('pick-icon-file'),
  clearIcon: () => ipcRenderer.invoke('clear-icon'),

  // Auto-update
  onUpdateAvailable:    (cb) => ipcRenderer.on('update-available',     (_, d) => cb(d)),
  onUpdateNotAvailable: (cb) => ipcRenderer.on('update-not-available', (_, d) => cb(d)),
  onUpdateProgress:  (cb) => ipcRenderer.on('update-progress',  (_, d) => cb(d)),
  onUpdateDownloaded:(cb) => ipcRenderer.on('update-downloaded', (_, d) => cb(d)),
  onJustUpdated:     (cb) => ipcRenderer.on('just-updated', (_, d) => cb(d)),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
})
