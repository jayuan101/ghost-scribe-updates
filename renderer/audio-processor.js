// Runs on dedicated audio thread — zero impact on UI or main thread
class AudioCapture extends AudioWorkletProcessor {
  constructor() {
    super()
    this._buf = []
    this._targetSize = 2048 // ~128ms at 16kHz
  }

  process(inputs) {
    const ch = inputs[0]?.[0]
    if (!ch) return true
    for (let i = 0; i < ch.length; i++) this._buf.push(ch[i])
    while (this._buf.length >= this._targetSize) {
      const chunk = this._buf.splice(0, this._targetSize)
      const i16 = new Int16Array(this._targetSize)
      for (let i = 0; i < this._targetSize; i++) {
        const s = Math.max(-1, Math.min(1, chunk[i]))
        i16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF
      }
      this.port.postMessage(i16.buffer, [i16.buffer])
    }
    return true
  }
}

registerProcessor('audio-capture', AudioCapture)
