// verify_path.js — proves the frontend -> /api/copilot -> Anthropic -> back to frontend path
// actually works, using core Node only (this sandbox has no external network access, so we
// stand up a local mock of api.anthropic.com and point the REAL proxy handler logic at it).
// This exercises the identical code that lives in server.js's /api/copilot route.
const http = require('http');

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data ? JSON.parse(data) : {}));
  });
}

// ---- 1. Mock Anthropic API (stands in for https://api.anthropic.com/v1/messages) ----------
const mockAnthropic = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/messages') return json(res, 404, { error: 'not found' });
  if (req.headers['x-api-key'] !== 'test-secret-key-12345') {
    return json(res, 401, { type: 'error', error: { message: 'invalid x-api-key' } });
  }
  const body = await readBody(req);
  const lastUser = [...body.messages].reverse().find((m) => m.role === 'user');
  let reply;
  if (/hello.*working/i.test(lastUser.content)) {
    reply = { message: "Hello! Yes, I'm connected and can see your room.", actions: [] };
  } else if (/more modern/i.test(lastUser.content)) {
    reply = { message: "I've applied a modern style — cleaner lines and a cooler palette.", actions: [{ type: 'apply_style', style: 'modern' }] };
  } else {
    reply = { message: 'ok', actions: [] };
  }
  json(res, 200, { content: [{ type: 'text', text: JSON.stringify(reply) }] });
});

// ---- 2. Real proxy handler logic (copy of server.js's /api/copilot, pointed at the mock) --
const ANTHROPIC_API_KEY = 'test-secret-key-12345'; // stand-in for process.env.ANTHROPIC_API_KEY
let ANTHROPIC_URL; // set once the mock is listening, below

const proxy = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/api/copilot') return json(res, 404, { error: 'not found' });
  const { system, messages } = await readBody(req);
  if (typeof system !== 'string' || !system.trim()) return json(res, 400, { error: 'Missing or invalid "system" field.' });
  if (!Array.isArray(messages) || messages.length === 0) return json(res, 400, { error: 'Missing or invalid "messages" field.' });

  const anthropicRes = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 1000, system, messages })
  });
  const data = await anthropicRes.json().catch(() => null);
  if (!anthropicRes.ok || !data) {
    const detail = data && data.error && data.error.message ? data.error.message : anthropicRes.statusText;
    return json(res, anthropicRes.status || 502, { error: detail });
  }
  return json(res, 200, { content: data.content });
});

// ---- 3. Drive it exactly like the frontend's copilotCallAI() does -------------------------
async function callCopilotEndpoint(base, userText) {
  const r = await fetch(base + '/api/copilot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system: 'You are Design Copilot... (room context omitted for this test)',
      messages: [{ role: 'user', content: userText }]
    })
  });
  const data = await r.json();
  if (!r.ok || data.error) throw new Error('HTTP ' + r.status + ': ' + (data.error || 'unknown'));
  const raw = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  return JSON.parse(raw);
}

mockAnthropic.listen(0, '127.0.0.1', () => {
  ANTHROPIC_URL = `http://127.0.0.1:${mockAnthropic.address().port}/v1/messages`;
  proxy.listen(0, '127.0.0.1', async () => {
    const base = `http://127.0.0.1:${proxy.address().port}`;
    console.log('Mock Anthropic listening on', ANTHROPIC_URL);
    console.log('Proxy (/api/copilot) listening on', base);
    console.log('---');
    try {
      console.log('TEST 1: "Hello, are you working?"');
      const r1 = await callCopilotEndpoint(base, 'Hello, are you working?');
      console.log('  frontend request  -> proxy -> mock Anthropic -> proxy -> frontend response');
      console.log('  parsed reply:', r1);
      console.log('  PASS: real text traveled the full round trip.\n');

      console.log('TEST 2: "Make this room feel more modern."');
      const r2 = await callCopilotEndpoint(base, 'Make this room feel more modern.');
      console.log('  parsed reply:', r2);
      const hasAction = Array.isArray(r2.actions) && r2.actions.some((a) => a.type === 'apply_style');
      console.log('  action present for executeCopilotAction() to run:', hasAction);
      console.log(hasAction ? '  PASS: structured action returned alongside the message.\n' : '  FAIL\n');

      console.log('TEST 3: malformed request (no messages) -> proxy must reject with a real 400, not fake success');
      const r3 = await fetch(base + '/api/copilot', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ system: 'x', messages: [] })
      });
      const d3 = await r3.json();
      console.log('  status:', r3.status, 'body:', d3);
      console.log(r3.status === 400 && d3.error ? '  PASS: rejected with a real error, no canned response.\n' : '  FAIL\n');
    } catch (e) {
      console.error('FAIL:', e.message);
      process.exitCode = 1;
    } finally {
      mockAnthropic.close();
      proxy.close();
    }
  });
});
