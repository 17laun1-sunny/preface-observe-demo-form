// Browser fetch to this Apps Script URL hangs on phones: the web app
// answers with a cross-origin 302 to script.googleusercontent.com, and
// iOS WebKit often never settles that redirect. The page calls this
// same-origin proxy instead. The script URL stays the data source.
const APPS_SCRIPT_URL =
  "https://script.google.com/macros/s/AKfycby-Ts3XOkdUwSF27d8bx-5RI9iQ_B55wKnQhZA8fcVt1ezJhd_RvqqE8S6oV7v3o8XHow/exec";

const GET_ACTIONS = new Set(["getSystemData", "getUserBooking"]);
const GET_TIMEOUT_MS = 28000;
const POST_TIMEOUT_MS = 50000;
const MEMORY_TTL_MS = 60000;
const SYSTEM_CACHE_CONTROL =
  "public, max-age=30, s-maxage=60, stale-while-revalidate=300, stale-if-error=600";

let memoryCache = { at: 0, body: "" };

function sendJson(res, status, body, cacheControl) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", cacheControl);
  res.end(payload);
}

function requestParams(req) {
  const params = new URLSearchParams();
  const raw = req.url || "";
  const query = raw.includes("?") ? raw.slice(raw.indexOf("?") + 1) : "";
  const fromUrl = new URLSearchParams(query);
  for (const [key, value] of fromUrl) params.set(key, value);
  if (req.query && typeof req.query === "object") {
    for (const [key, value] of Object.entries(req.query)) {
      if (!params.has(key) && typeof value === "string") params.set(key, value);
    }
  }
  return params;
}

function readBody(req) {
  if (typeof req.body === "string") return Promise.resolve(req.body);
  if (Buffer.isBuffer(req.body)) return Promise.resolve(req.body.toString("utf8"));
  if (req.body && typeof req.body === "object") return Promise.resolve(JSON.stringify(req.body));
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handler(req, res) {
  const method = String(req.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return sendJson(res, 405, { error: "Method not allowed." }, "no-store");
  }

  const incoming = requestParams(req);
  const action = incoming.get("action") || "";
  const upstream = new URL(APPS_SCRIPT_URL);

  if (method === "GET") {
    if (!GET_ACTIONS.has(action)) {
      return sendJson(res, 400, { error: "Unknown action." }, "no-store");
    }
    upstream.searchParams.set("action", action);
    if (action === "getUserBooking") {
      const email = (incoming.get("email") || "").trim().toLowerCase();
      if (!email || email.length > 200) {
        return sendJson(res, 400, { error: "A valid email is required." }, "no-store");
      }
      upstream.searchParams.set("email", email);
    }
    if (
      action === "getSystemData" &&
      memoryCache.body &&
      Date.now() - memoryCache.at < MEMORY_TTL_MS
    ) {
      return sendJson(res, 200, memoryCache.body, SYSTEM_CACHE_CONTROL);
    }
  }

  let body;
  if (method === "POST") {
    body = await readBody(req);
    if (!body || body.length > 100000) {
      return sendJson(res, 400, { error: "Invalid booking." }, "no-store");
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (err) {
      return sendJson(res, 400, { error: "Invalid booking." }, "no-store");
    }
    if (!parsed || typeof parsed !== "object" || !parsed.name || !parsed.email) {
      return sendJson(res, 400, { error: "Name and email are required." }, "no-store");
    }
    body = JSON.stringify(parsed);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), method === "POST" ? POST_TIMEOUT_MS : GET_TIMEOUT_MS);
  try {
    const upstreamRes = await fetch(upstream, {
      method,
      redirect: "follow",
      signal: controller.signal,
      headers: method === "POST" ? { "Content-Type": "text/plain;charset=utf-8" } : undefined,
      body: method === "POST" ? body : undefined,
    });
    const text = await upstreamRes.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      parsed = undefined;
    }
    // getUserBooking returns JSON null when the email has no booking.
    if (!upstreamRes.ok || parsed === undefined) {
      return sendJson(
        res,
        502,
        { error: "The schedule service returned an unexpected response." },
        "no-store"
      );
    }
    if (method === "GET" && action === "getSystemData") {
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.observations) || !Array.isArray(parsed.demos)) {
        return sendJson(res, 502, { error: "The schedule service returned an unexpected response." }, "no-store");
      }
      memoryCache = { at: Date.now(), body: text };
      return sendJson(res, 200, text, SYSTEM_CACHE_CONTROL);
    }
    return sendJson(res, 200, text, "no-store");
  } catch (err) {
    const aborted = err && (err.name === "AbortError" || err.name === "TimeoutError");
    return sendJson(
      res,
      504,
      {
        error: aborted
          ? "The schedule service took too long to respond."
          : "Could not reach the schedule service.",
      },
      "no-store"
    );
  } finally {
    clearTimeout(timer);
  }
}

module.exports = handler;
module.exports.config = { maxDuration: 60 };
