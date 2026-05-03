/**
 * Hubspace API discovery — device listing with real account ID from /v1/users/me
 * Run with: node discover.mjs
 */

import https from "https";
import { Buffer } from "buffer";
import zlib from "zlib";

const USERNAME = "wrxratd@gmail.com";
const PASSWORD = "bLE6BHDdvN@JEq@*";

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

function decodeJwt(token) {
  try { return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()); }
  catch { return null; }
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
  console.log("Full /me:", JSON.stringify(meRes.data, null, 2));

  if (!accountId) { console.log("No accountId found"); process.exit(1); }

  // Step 2: probe device endpoints with the real account ID
  console.log("\n── Device endpoints with real accountId ─────────────────────");

  const probes = [
    { url: `https://semantics2.afero.net/v1/accounts/${accountId}/metadevices?expansions=state`, host: "semantics2.afero.net" },
    { url: `https://api2.afero.net/v1/accounts/${accountId}/metadevices?expansions=state`, host: "api2.afero.net" },
    { url: `https://api2.afero.net/v1/accounts/${accountId}/devices`, host: "api2.afero.net" },
    { url: `https://api2.afero.net/v2/accounts/${accountId}/devices`, host: "api2.afero.net" },
    { url: `https://api2.afero.net/v1/accounts/${accountId}`, host: "api2.afero.net" },
    { url: `https://semantics2.afero.net/v1/accounts/${accountId}/devices`, host: "semantics2.afero.net" },
    // Also try with userId
    { url: `https://semantics2.afero.net/v1/accounts/${userId}/metadevices?expansions=state`, host: "semantics2.afero.net" },
    { url: `https://api2.afero.net/v1/accounts/${userId}/metadevices?expansions=state`, host: "api2.afero.net" },
  ];

  for (const { url, host } of probes) {
    try {
      const r = await request("GET", url, { headers: h(host) });
      console.log(`\n  ${r.status} GET ${url}`);
      if (r.status === 200) {
        console.log("  ✓✓✓ SUCCESS!");
        console.log(JSON.stringify(r.data, null, 2).slice(0, 2000));
      } else {
        console.log("  →", JSON.stringify(r.data).slice(0, 300));
      }
    } catch (e) {
      console.log(`  ERR ${url}: ${e.message}`);
    }
  }

  console.log("\n── Done ─────────────────────────────────────────────────────");
})();
