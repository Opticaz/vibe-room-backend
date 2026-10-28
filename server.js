// Vibe Room stats.fm backend
// GET /now?user=NAME&size=10  ->  { state, progressMs, track: { name, artist, album, durationMs, mosaic, mosaicSize } }
// `mosaic` is size*size*6 hex chars (RRGGBB per cell, row by row, top-left first),
// exactly what StatsFmApi.sanitizeBackend and StatsFmCards.setMosaic expect.

const http = require("http");
const sharp = require("sharp");

const PORT = process.env.PORT || 3000;
const API = "https://api.stats.fm/api/v1/users/";
const MAX_SIZE = 128;
const NOW_CACHE_MS = 6000;       // share results between requests for the same user
const MOSAIC_CACHE_MAX = 150;    // cached cover mosaics (keyed by image url + size)
const FETCH_TIMEOUT_MS = 8000;

const nowCache = new Map();      // user -> { at, result }
const mosaicCache = new Map();   // `${url}|${size}` -> hex string

function clip(s, n) {
  if (typeof s !== "string") return "";
  return Array.from(s.replace(/[\u0000-\u001f]/g, " ")).slice(0, n).join("");
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  let body = null;
  try { body = await res.json(); } catch { /* not json */ }
  return { status: res.status, body };
}

// Downscale the cover to size x size and return RRGGBB hex for every cell.
async function makeMosaic(imageUrl, size) {
  const key = `${imageUrl}|${size}`;
  if (mosaicCache.has(key)) return mosaicCache.get(key);

  const res = await fetch(imageUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error("cover HTTP " + res.status);
  const input = Buffer.from(await res.arrayBuffer());

  const { data } = await sharp(input)
    .removeAlpha()
    .resize(size, size, { fit: "cover", kernel: "lanczos3" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  let hex = "";
  for (let i = 0; i < size * size; i++) {
    hex += data.subarray(i * 3, i * 3 + 3).toString("hex");
  }
  if (mosaicCache.size >= MOSAIC_CACHE_MAX) {
    mosaicCache.delete(mosaicCache.keys().next().value);
  }
  mosaicCache.set(key, hex);
  return hex;
}

function pickImage(track) {
  const album = Array.isArray(track.albums) ? track.albums[0] : null;
  if (album && typeof album.image === "string") return album.image;
  if (album && Array.isArray(album.images) && album.images[0]?.url) return album.images[0].url;
  if (typeof track.image === "string") return track.image;
  return null;
}

async function profileIsPrivate(user) {
  try {
    const { status, body } = await getJson(API + encodeURIComponent(user));
    return status === 200 && body?.item?.privacySettings?.currentlyPlaying === false;
  } catch {
    return false;
  }
}

async function fetchNow(user, size) {
  const { status, body } = await getJson(API + encodeURIComponent(user) + "/streams/current");
  if (status === 404) return { state: "notfound" };
  if (status === 401 || status === 403) return { state: "private" };
  if (status !== 200 || !body) return { state: "error", message: "stats.fm HTTP " + status };

  const item = body.item;
  if (!item || typeof item !== "object") {
    return (await profileIsPrivate(user)) ? { state: "private" } : { state: "idle" };
  }
  if (item.isPlaying === false) return { state: "idle" };

  const t = item.track;
  if (!t || typeof t.name !== "string") return { state: "idle" };

  const artists = (Array.isArray(t.artists) ? t.artists : [])
    .slice(0, 3).map((a) => a?.name).filter(Boolean).join(", ");

  const track = {
    name: clip(t.name, 60),
    artist: clip(artists, 60),
    album: clip(Array.isArray(t.albums) && t.albums[0] ? t.albums[0].name : "", 60),
    durationMs: Math.max(0, Number(t.durationMs) || 0),
  };

  const imageUrl = pickImage(t);
  if (imageUrl) {
    try {
      track.mosaic = await makeMosaic(imageUrl, size);
      track.mosaicSize = size;
    } catch (err) {
      console.warn("mosaic failed:", err.message); // card falls back to placeholder
    }
  }

  return {
    state: "playing",
    progressMs: Math.max(0, Number(item.progressMs) || 0),
    track,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const send = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(obj));
  };

  if (url.pathname === "/" || url.pathname === "/health") return send(200, { ok: true });
  if (url.pathname !== "/now") return send(404, { state: "error", message: "not found" });

  const user = (url.searchParams.get("user") || "").trim();
  if (!/^[\w.\-]{2,64}$/.test(user)) return send(400, { state: "notfound" });
  const size = Math.min(MAX_SIZE, Math.max(1, parseInt(url.searchParams.get("size"), 10) || 10));

  const key = `${user.toLowerCase()}|${size}`;
  const cached = nowCache.get(key);
  if (cached && Date.now() - cached.at < NOW_CACHE_MS) return send(200, cached.result);

  try {
    const result = await fetchNow(user, size);
    nowCache.set(key, { at: Date.now(), result });
    send(200, result);
  } catch (err) {
    console.warn("fetchNow failed:", err.message);
    send(200, { state: "error", message: "backend error" });
  }
});

// Keep the now-playing cache from growing forever.
setInterval(() => {
  const cutoff = Date.now() - 120000;
  for (const [k, v] of nowCache) if (v.at < cutoff) nowCache.delete(k);
}, 60000).unref();

server.listen(PORT, () => console.log("statsfm backend listening on " + PORT));
