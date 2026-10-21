const UPSTREAM =
  "https://script.google.com/macros/s/AKfycby-Ts3XOkdUwSF27d8bx-5RI9iQ_B55wKnQhZA8fcVt1ezJhd_RvqqE8S6oV7v3o8XHow/exec";

const MEMORY_TTL_MS = 90 * 1000;
const UPSTREAM_TIMEOUT_MS = 55 * 1000;
const MAX_POST_BYTES = 20 * 1000;

let memoryCache = null;
let inflightSystemData = null;

function queryValue(value) {
  if (Array.isArray(value)) return value[0] == null ? "" : String(value[0]);
  return value == null ? "" : String(value);
}

function isSystemDataText(text) {
  try {
    const data = JSON.parse(text);
    return !!(data && Array.isArray(data.demos) && Array.isArray(data.observations));
  } catch (err) {
    return false;
  }
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
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

async function fetchUpstream(url, options) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    ...options,
  });
  const text = await response.text();
  return { status: response.status, text };
}

async function loadSystemData() {
  if (memoryCache && Date.now() - memoryCache.storedAt < MEMORY_TTL_MS) {
    return { status: 200, text: memoryCache.text, fromMemory: true };
  }
  if (!inflightSystemData) {
    inflightSystemData = fetchUpstream(`${UPSTREAM}?action=getSystemData`, { method: "GET" })
      .then((result) => {
        if (result.status === 200 && isSystemDataText(result.text)) {
          memoryCache = { text: result.text, storedAt: Date.now() };
        }
        return result;
      })
      .finally(() => {
        inflightSystemData = null;
      });
  }
  return inflightSystemData;
}

async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const action = queryValue(req.query && req.query.action);
      if (action === "getSystemData") {
        const result = await loadSystemData();
        res.statusCode = result.status;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        if (result.status === 200 && isSystemDataText(result.text)) {
          res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
          res.setHeader("CDN-Cache-Control", "public, s-maxage=90, stale-while-revalidate=180");
          res.setHeader("Vercel-CDN-Cache-Control", "public, s-maxage=90, stale-while-revalidate=180");
        } else {
          res.setHeader("Cache-Control", "no-store");
        }
        res.end(result.text);
        return;
      }

      if (action === "getUserBooking") {
        const email = queryValue(req.query && req.query.email).slice(0, 320);
        const url = `${UPSTREAM}?action=getUserBooking&email=${encodeURIComponent(email)}`;
        const result = await fetchUpstream(url, { method: "GET" });
        res.statusCode = result.status;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(result.text);
        return;
      }

      sendJson(res, 400, { success: false, message: "Unknown action" });
      return;
    }

    if (req.method === "POST") {
      const text = await readBody(req);
      if (text.length > MAX_POST_BYTES) {
        sendJson(res, 413, { success: false, message: "Payload too large" });
        return;
      }
      try {
        JSON.parse(text);
      } catch (err) {
        sendJson(res, 400, { success: false, message: "Invalid JSON" });
        return;
      }
      const result = await fetchUpstream(UPSTREAM, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: text,
      });
      res.statusCode = result.status;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(result.text);
      return;
    }

    res.setHeader("Allow", "GET, POST");
    sendJson(res, 405, { success: false, message: "Method not allowed" });
  } catch (err) {
    const timedOut = err && (err.name === "TimeoutError" || err.name === "AbortError");
    sendJson(res, timedOut ? 504 : 502, {
      success: false,
      message: timedOut
        ? "The booking service timed out. Please retry."
        : "The booking service is unavailable. Please retry.",
    });
  }
}

handler.config = { maxDuration: 60 };
module.exports = handler;
module.exports._resetCacheForTests = function resetCacheForTests() {
  memoryCache = null;
  inflightSystemData = null;
};
