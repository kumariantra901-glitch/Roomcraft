// server.js — RoomCraft Design Copilot backend
//
// This is the real backend/proxy the frontend needs. It does three things:
//   1. Serves the static RoomCraft app (index.html) so the whole thing runs from one origin.
//   2. Exposes POST /api/copilot — the ONLY endpoint the frontend talks to for AI requests.
//   3. Holds the real Anthropic API key (from the ANTHROPIC_API_KEY environment variable) and
//      is the ONLY place that ever calls api.anthropic.com. The key never reaches the browser.
//
// Run it with:  npm install && ANTHROPIC_API_KEY=sk-ant-... npm start
// (or put the key in a .env file — see .env.example)

require('dotenv').config();
const express = require('express');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = 'claude-sonnet-4-6';   // fixed server-side — the client cannot override the model
const MAX_TOKENS = 1000;             // fixed server-side — the client cannot override token limits
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

if (!ANTHROPIC_API_KEY) {
  // Fail loudly at startup rather than silently returning 500s on every request later.
  console.error(
    '\n[FATAL] ANTHROPIC_API_KEY is not set.\n' +
    'Create a .env file (copy .env.example) or export ANTHROPIC_API_KEY before starting the server.\n'
  );
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '256kb' })); // system+messages text only — no file uploads expected

// ---- POST /api/copilot -----------------------------------------------------------------
// Request body (from the frontend, no secrets):  { system: string, messages: [{role, content}] }
// Response body (to the frontend):                { content: [{type:'text', text: string}] }
//                                            or:   { error: string }  (4xx/5xx)
app.post('/api/copilot', async (req, res) => {
  try {
    const { system, messages } = req.body || {};

    if (typeof system !== 'string' || !system.trim()) {
      return res.status(400).json({ error: 'Missing or invalid "system" field.' });
    }
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Missing or invalid "messages" field.' });
    }
    for (const m of messages) {
      if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') {
        return res.status(400).json({ error: 'Each message needs role "user"/"assistant" and string content.' });
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    let anthropicRes;
    try {
      anthropicRes = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,           // the real secret — lives only here, server-side
          'anthropic-version': ANTHROPIC_VERSION
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system,
          messages
        })
      });
    } finally {
      clearTimeout(timer);
    }

    const data = await anthropicRes.json().catch(() => null);

    if (!anthropicRes.ok || !data) {
      const detail = data && data.error && data.error.message ? data.error.message : anthropicRes.statusText;
      console.error('[Copilot backend] Anthropic API error', anthropicRes.status, detail);
      return res.status(anthropicRes.status || 502).json({ error: detail || 'Unknown Anthropic API error.' });
    }

    // Pass the actual model response straight through — this is the real AI reply, not a canned one.
    return res.json({ content: data.content });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      console.error('[Copilot backend] Anthropic request timed out');
      return res.status(504).json({ error: 'Request to Anthropic timed out.' });
    }
    console.error('[Copilot backend] Unexpected error', err);
    return res.status(500).json({ error: 'Unexpected backend error.' });
  }
});

// ---- POST /api/classify-furniture ------------------------------------------------------
// Request body:  { imageBase64: string (PNG, no data: prefix), prompt: string }
// Response body: { content: [{type:'text', text: string}] }  or  { error: string }
// Same pattern as /api/copilot: the client sends no secret, this route attaches the real key.
app.post('/api/classify-furniture', async (req, res) => {
  try {
    const { imageBase64, prompt } = req.body || {};
    if (typeof imageBase64 !== 'string' || !imageBase64) {
      return res.status(400).json({ error: 'Missing or invalid "imageBase64" field.' });
    }
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: 'Missing or invalid "prompt" field.' });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    let anthropicRes;
    try {
      anthropicRes = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': ANTHROPIC_VERSION
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 400,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageBase64 } },
              { type: 'text', text: prompt }
            ]
          }]
        })
      });
    } finally {
      clearTimeout(timer);
    }

    const data = await anthropicRes.json().catch(() => null);
    if (!anthropicRes.ok || !data) {
      const detail = data && data.error && data.error.message ? data.error.message : anthropicRes.statusText;
      console.error('[Classify backend] Anthropic API error', anthropicRes.status, detail);
      return res.status(anthropicRes.status || 502).json({ error: detail || 'Unknown Anthropic API error.' });
    }
    return res.json({ content: data.content });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return res.status(504).json({ error: 'Request to Anthropic timed out.' });
    }
    console.error('[Classify backend] Unexpected error', err);
    return res.status(500).json({ error: 'Unexpected backend error.' });
  }
});

// ---- Static app --------------------------------------------------------------------------
app.use(express.static(__dirname));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`RoomCraft running at http://localhost:${PORT}`);
  console.log('Copilot backend ready at POST /api/copilot (Anthropic key loaded server-side).');
});
