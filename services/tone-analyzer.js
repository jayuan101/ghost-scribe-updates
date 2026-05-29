'use strict'

/**
 * Tone analyzer — supports Claude, OpenAI, Perplexity, Groq, Ollama (local), and local sentiment.
 * All LLM providers share the same JSON prompt since they all speak OpenAI-style chat.
 */

const PROMPT = `You are analyzing a conversation transcript (interview, meeting, or video call). Be concise and objective.

STEP 1 — Identify each speaker's ROLE and NAME:
- Look for names mentioned in the transcript (e.g. "Hi John", "Thanks Sarah") and use them
- Infer role from speech patterns:
  * Asks most questions, evaluates answers → "Interviewer" (or "Lead Interviewer" if one is more dominant)
  * Multiple people asking interview questions → "Panel Interviewer 1", "Panel Interviewer 2", etc.
  * Answers behavioral/technical questions, sells themselves → "Candidate"
  * Presents or explains topics to others → "Presenter"
  * Facilitates discussion → "Facilitator" or "Host"
  * Meeting participants → "Participant 1", "Participant 2", etc.
- If a name AND a role are both clear, combine them: "Sarah (Candidate)", "Mark (Lead Interviewer)"
- Default when truly ambiguous: "Speaker 1", "Speaker 2"

STEP 2 — For each speaker analyze:
- name: their real name if mentioned, otherwise their role (e.g. "Interviewer", "Priya (Candidate)")
- tone: one descriptive word (e.g. confident, nervous, engaged, formal, hesitant, enthusiastic, analytical)
- sentiment: "positive" | "neutral" | "negative"
- speech_pattern: one short phrase describing a notable communication pattern
- observation: one sentence of insight useful for this conversation context

Also provide:
- overall_dynamic: one sentence describing the conversation dynamic
- key_topics: array of up to 5 main topics discussed

Respond with ONLY valid JSON. No markdown, no explanation.

Format:
{
  "speakers": {
    "1": { "name": "...", "tone": "...", "sentiment": "...", "speech_pattern": "...", "observation": "..." },
    "2": { "name": "...", "tone": "...", "sentiment": "...", "speech_pattern": "...", "observation": "..." }
  },
  "overall_dynamic": "...",
  "key_topics": ["...", "..."]
}

TRANSCRIPT:
`

function parseJson(text) {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) throw new Error('No JSON in response')
  return JSON.parse(m[0])
}

// ── Claude / Anthropic ────────────────────────────────────────────────────────
async function analyzeWithClaude(transcript, apiKey, model = 'claude-haiku-4-5-20251001') {
  const Anthropic = require('@anthropic-ai/sdk')
  const client = new Anthropic.default({ apiKey })
  const msg = await client.messages.create({
    model,
    max_tokens: 1024,
    messages: [{ role: 'user', content: PROMPT + transcript }],
  })
  return { source: 'claude', ...parseJson(msg.content[0]?.text || '') }
}

// ── OpenAI ────────────────────────────────────────────────────────────────────
async function analyzeWithOpenAI(transcript, apiKey, model = 'gpt-4o-mini') {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 1024, messages: [{ role: 'user', content: PROMPT + transcript }] }),
  })
  const data = await resp.json()
  if (data.error) throw new Error(data.error.message)
  return { source: 'openai', ...parseJson(data.choices[0]?.message?.content || '') }
}

// ── Perplexity ────────────────────────────────────────────────────────────────
async function analyzeWithPerplexity(transcript, apiKey, model = 'llama-3.1-sonar-large-128k-chat') {
  const resp = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: PROMPT + transcript }] }),
  })
  const data = await resp.json()
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error))
  return { source: 'perplexity', ...parseJson(data.choices[0]?.message?.content || '') }
}

// ── Groq ──────────────────────────────────────────────────────────────────────
async function analyzeWithGroq(transcript, apiKey, model = 'llama-3.1-8b-instant') {
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: 1024, messages: [{ role: 'user', content: PROMPT + transcript }] }),
  })
  const data = await resp.json()
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error))
  return { source: 'groq', ...parseJson(data.choices[0]?.message?.content || '') }
}

// ── Google Gemini ─────────────────────────────────────────────────────────────
async function analyzeWithGemini(transcript, apiKey, model = 'gemini-1.5-flash') {
  const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: PROMPT + transcript }] }],
      generationConfig: { maxOutputTokens: 1024, temperature: 0.1 },
    }),
  })
  const data = await resp.json()
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error))
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || ''
  return { source: 'gemini', ...parseJson(text) }
}

// ── Custom OpenAI-compatible (Mistral, DeepSeek, xAI, Together AI, etc.) ──────
async function analyzeWithCustom(transcript, apiKey, model, baseUrl) {
  if (!baseUrl) throw new Error('Custom API URL is required')
  const url = baseUrl.replace(/\/$/, '') + '/chat/completions'
  const headers = { 'Content-Type': 'application/json' }
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: model || 'default', max_tokens: 1024, messages: [{ role: 'user', content: PROMPT + transcript }] }),
  })
  const data = await resp.json()
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error))
  return { source: model || 'custom', ...parseJson(data.choices[0]?.message?.content || '') }
}

// ── Ollama (local — no API key needed) ────────────────────────────────────────
async function analyzeWithOllama(transcript, model = 'llama3.2', baseUrl = 'http://localhost:11434') {
  const resp = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: PROMPT + transcript }] }),
  })
  const data = await resp.json()
  if (data.error) throw new Error(data.error)
  return { source: 'ollama', ...parseJson(data.choices[0]?.message?.content || '') }
}

// ── Local sentiment (no API needed) ───────────────────────────────────────────
function analyzeWithSentiment(speakerTexts) {
  try {
    const Sentiment = require('sentiment')
    const analyzer = new Sentiment()
    const out = { source: 'local', speakers_sentiment: {} }
    for (const [id, text] of Object.entries(speakerTexts)) {
      if (!text.trim()) continue
      const score = analyzer.analyze(text)
      const comp = score.comparative
      out.speakers_sentiment[id] = {
        score: parseFloat(comp.toFixed(3)),
        label: comp > 0.15 ? 'Positive' : comp < -0.15 ? 'Negative' : 'Neutral',
        top_positive: score.positive.slice(0, 5),
        top_negative: score.negative.slice(0, 5),
      }
    }
    return out
  } catch {
    return { source: 'local', speakers_sentiment: {} }
  }
}

// ── Main export ───────────────────────────────────────────────────────────────
/**
 * @param {string} fullTranscript - labeled transcript text
 * @param {object} speakerTexts   - { speakerId: textString }
 * @param {object} config         - { provider, apiKey, model, ollamaUrl }
 */
async function analyzeTone(fullTranscript, speakerTexts, config = {}) {
  const { provider = 'claude', apiKey = '', model, ollamaUrl } = config

  if (!fullTranscript?.trim()) return analyzeWithSentiment(speakerTexts)

  try {
    switch (provider) {
      case 'claude':
        if (!apiKey) break
        return await analyzeWithClaude(fullTranscript, apiKey, model)
      case 'openai':
        if (!apiKey) break
        return await analyzeWithOpenAI(fullTranscript, apiKey, model)
      case 'perplexity':
        if (!apiKey) break
        return await analyzeWithPerplexity(fullTranscript, apiKey, model)
      case 'groq':
        if (!apiKey) break
        return await analyzeWithGroq(fullTranscript, apiKey, model)
      case 'gemini':
        if (!apiKey) break
        return await analyzeWithGemini(fullTranscript, apiKey, model || 'gemini-1.5-flash')
      case 'custom':
        return await analyzeWithCustom(fullTranscript, apiKey, model, config.customApiUrl)
      case 'ollama':
        return await analyzeWithOllama(fullTranscript, model || 'llama3.2', ollamaUrl)
      case 'none':
        break
    }
  } catch (err) {
    console.warn(`Tone analysis (${provider}) failed: ${err.message} — falling back to local`)
  }

  return analyzeWithSentiment(speakerTexts)
}

module.exports = { analyzeTone }
