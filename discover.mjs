/**
 * Hubspace API discovery — device listing with real account ID from /v1/users/me
 * Run with: USERNAME=you@example.com PASSWORD=yourpass node discover.mjs
 */

import https from "https";
import { Buffer } from "buffer";
import zlib from "zlib";

const USERNAME = process.env.USERNAME;
const PASSWORD = process.env.PASSWORD;

if (!USERNAME || !PASSWORD) {
  console.error("Usage: USERNAME=you@example.com PASSWORD=yourpass node discover.mjs");
  process.exit(1);
}

function request(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        hostname: u.hostname,
        port: 443,
        path: u.pathname + u.search,
        method,
        headers: { Accept: "application/json", ...headers },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          const finish = (buf) => {
            const text = buf.toString("utf8");
            let data;
            try { data = JSON.parse(text); } catch { data = text.slice(0, 500); }
            resolve({ status: res.statusCode, headers: res.headers, data });
          };
          const enc = res.headers["content-encoding"];
          if (enc === "gzip") zlib.gunzip(raw, (e, b) => finish(e ? raw : b));
          else if (enc === "deflate") zlib.inflate(raw, (e, b) => finish(e ? raw : b));
          else finish(raw);
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  // Auth
  const authRes = await request(
    "POST",
    "https://accounts.hubspaceconnect.com/auth/realms/thd/protocol/openid-connect/token",
    {
      headers: { "Content-Type": "application/x-www-form-urlencoded", "user-agent": "Dart/2.18 (dart:io)" },
      body: new URLSearchParams({
        grant_type: "password", client_id: "hubspace_android",
        username: USERNAME, password: PASSWORD, scope: "openid offline_access",
      }).toString(),
    },
  );
  if (authRes.status !== 200) { console.log("Auth failed:", authRes.data); process.exit(1); }
  const token = authRes.data.access_token;
  console.log("✓ Authenticated");

  const h = (host) => ({
    authorization: `Bearer ${token}`,
    "user-agent": "Dart/2.18 (dart:io)",
    "host": host,
    "accept-encoding": "gzip",
  });

  // Step 1: get real account ID from /v1/users/me
  console.log("\n── /v1/users/me → real accountId ────────────────────────────");
  const meRes = await request("GET", "https://api2.afero.net/v1/users/me", {
    headers: h("api2.afero.net"),
  });
  console.log("status:", meRes.status);
  if (meRes.status !== 200) { console.log(meRes.data); process.exit(1); }

  const accountId = meRes.data.accountAccess?.[0]?.account?.accountId;
  const userId = meRes.data.userId;
  console.log(`accountId: ${accountId}`);
  console.log(`userId:    ${userId}`);

  if (!accountId) { console.log("No accountId found"); process.exit(1); }

  // Step 2: list metadevices
  console.log("\n── Metadevices ──────────────────────────────────────────────");
  const devRes = await request(
    "GET",
    `https://semantics2.afero.net/v1/accounts/${accountId}/metadevices?expansions=state`,
    { headers: h("semantics2.afero.net") },
  );
  console.log("status:", devRes.status);
  if (devRes.status === 200) {
    console.log(JSON.stringify(devRes.data, null, 2).slice(0, 5000));
  } else {
    console.log(devRes.data);
  }

  console.log("\n── Done ─────────────────────────────────────────────────────");
})();
