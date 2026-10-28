# Vibe Room stats.fm backend

Returns the player's currently playing track plus a tiny album-cover mosaic
for the in-game "now playing" card.

    GET /now?user=NAME&size=10
    -> { "state": "playing", "progressMs": 4200,
         "track": { "name", "artist", "album", "durationMs", "mosaic", "mosaicSize" } }
    -> { "state": "idle" | "private" | "notfound" | "error" }

`mosaic` is `size*size*6` hex characters (RRGGBB per cell, row by row).

## Deploy (example: Render, free tier)

1. Put `server.js` and `package.json` in a GitHub repo.
2. Render -> New -> Web Service -> pick the repo.
3. Build command: `npm install`   Start command: `npm start`
4. Copy the service URL, e.g. `https://vibe-statsfm.onrender.com` (no trailing slash).

Railway, Fly.io, or any Node 18+ host works the same way. Free tiers sleep when idle,
so the first request after a pause can be slow; the game falls back to stats.fm
directly (no cover) while the backend wakes up.

## Hook it up in Roblox

1. Game Settings -> Security -> turn on **Allow HTTP Requests**.
2. In `ServerScriptService.Modules.StatsFmApi`, set:

       BackendUrl = "https://your-service.onrender.com",

Test it in a browser first: `https://your-service.onrender.com/now?user=YOUR_STATSFM_NAME&size=10`
