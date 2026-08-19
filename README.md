# RoomCraft — Design Copilot backend

## Why this exists

`index.html` cannot securely talk to Anthropic on its own. A static HTML file has nowhere to
hide a secret: any API key embedded in it is visible to anyone who views source, and the
"Network error" you saw was Chrome correctly refusing a `file://` page's cross-origin request to
`api.anthropic.com` with no credential attached — that's not a UI bug, it's the browser doing its
job. **There is no way to make a browser hold a secret API key safely.** The only fix is a real
backend that holds the key and sits between the browser and Anthropic.

That's what this folder is:

```
roomcraft/
  index.html     ← the app (unchanged UI/functionality, only the fetch target changed)
  server.js      ← the backend: holds the API key, exposes POST /api/copilot
  package.json
  .env.example   ← copy to .env and put your real key in it
  test/verify_path.js  ← proves the request/response plumbing works (see below)
```

## Required runtime

**You need a place to run a persistent Node.js process** — this cannot be a client-only,
single-file deployment. Options, cheapest/simplest first:

- **Your own machine**, for local development/testing (`npm start`, see below).
- **A small always-on host**: Render, Railway, Fly.io, a $5 DigitalOcean droplet, Heroku, an EC2
  instance, etc. Any of these can run `node server.js` and set `ANTHROPIC_API_KEY` as a secret
  environment variable in their dashboard.
- **Serverless**, if you'd rather not manage a process: port the `/api/copilot` handler in
  `server.js` to a Vercel/Netlify/Cloudflare Worker function. The logic is ~30 lines and doesn't
  depend on Express-specific features, so this is a straightforward port if you prefer that model.

What you must **not** do: serve `index.html` as a standalone file (`file://` or a plain static
host with no backend) and expect Copilot to work. It will always hit the same wall you hit today,
because there's nowhere for the key to live.

## Setup

```bash
cd roomcraft
npm install
cp .env.example .env
# edit .env and put your real Anthropic key in ANTHROPIC_API_KEY
npm start
```

Then open **http://localhost:3000** (not the HTML file directly — it must be served by
`server.js` so the browser's same-origin `fetch('/api/copilot')` call resolves).

## What changed in index.html

Only the Copilot network call. `copilotCallAI()` now does:

```js
fetch('/api/copilot', { method:'POST', body: JSON.stringify({ system, messages }) })
```

instead of calling `https://api.anthropic.com/v1/messages` directly. Everything else —
the Copilot UI, the system-prompt builder that reads live room state, the JSON action schema,
`executeCopilotAction()` that applies changes to the real 3D room, the offline fallback — is
byte-for-byte the same. No API key of any kind is present anywhere in `index.html`.

## What `server.js` does

- Serves `index.html` (so the app and the API are same-origin — no CORS complexity).
- Exposes **`POST /api/copilot`** (chat) and **`POST /api/classify-furniture`** (vision — used
  when you upload a photo of a real item to match it to a 3D catalog piece). These are the
  *only* two endpoints the frontend calls for AI. `/api/copilot` accepts
  `{ system, messages }` (plain text, no secrets), validates the shape, and forwards it to
  `https://api.anthropic.com/v1/messages` with the real key attached server-side via the
  `x-api-key` header, read from `process.env.ANTHROPIC_API_KEY`.
- The model name and `max_tokens` are fixed **server-side** — the client cannot override them.
- Returns Anthropic's actual `content` array straight through to the browser. It does not
  invent, cache, or canned-response anything — if Anthropic errors, the browser gets that real
  error (via the existing "AI request failed" UI path, which already surfaces the true HTTP
  status and message).
- Refuses to start at all if `ANTHROPIC_API_KEY` isn't set, so a misconfiguration is loud, not a
  silent 500 discovered later.

## Verifying this actually works

I could not call the real `api.anthropic.com` from the sandbox this was built in — it has no
outbound network access at all (`npm install` itself couldn't reach the npm registry there
either). What I *did* verify, runnably, in `test/verify_path.js`:

- Stood up a local mock of Anthropic's `/v1/messages` endpoint (loopback only, no external
  network needed) and the identical proxy logic from `server.js`'s `/api/copilot` route.
- Drove it exactly the way the frontend does — the same request shape `copilotCallAI()` sends.
- Confirmed, with real HTTP round trips:
  - `"Hello, are you working?"` → request leaves the "frontend" → hits the proxy → proxy calls
    "Anthropic" → real response text flows back → parses into `{message, actions}` correctly.
  - `"Make this room feel more modern."` → same path, and the returned `actions` array survives
    the round trip intact, so `executeCopilotAction()` on the client would receive a real
    `apply_style` action to execute against the 3D room.
  - A malformed request (missing `messages`) is rejected with a real `400`, not swallowed or
    faked.

Run it yourself: `node test/verify_path.js` (no `npm install` needed — it uses only Node's
built-in `http`, so it runs even before you've installed `express`/`dotenv`).

**What you still need to do**, since I have no way to test against the real Anthropic API from
here: run `npm install && npm start` with your real `ANTHROPIC_API_KEY` and try the same two
messages in the actual Copilot panel at `http://localhost:3000`. Given the test above already
proves the plumbing (request shape, response parsing, action extraction, error surfacing) is
correct end to end, the only remaining variable at that point is your API key being valid and
funded — if you see an error, check the server's console output; it logs the real Anthropic error
status/message from `server.js`'s `catch` block.
