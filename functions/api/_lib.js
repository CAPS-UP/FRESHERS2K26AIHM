// Shared helpers. The leading underscore keeps Pages from routing this file.

export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export const fail = (message, status = 400) => json({ ok: false, error: message }, status);

/** Comparison that does not leak how much of the token was right. */
function sameToken(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Checks the Authorization header against one or more env vars.
 * Returns null when the caller is allowed, or a Response when they are not.
 */
export function requireToken(request, env, ...names) {
  const header = request.headers.get("Authorization") || "";
  const given = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!given) return fail("missing token", 401);

  for (const name of names) {
    const expected = env[name];
    if (expected && sameToken(given, expected)) return null;
  }
  return fail("bad token", 403);
}

const B32 = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // no 0 1 I O â€” nothing to misread

/** HMAC-SHA256 trimmed to ten base32 characters. 50 bits. */
export async function sign(secret, data) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));

  let bits = 0, val = 0, out = "";
  for (let i = 0; i < mac.length && out.length < 10; i++) {
    val = ((val << 8) | mac[i]) >>> 0;
    bits += 8;
    while (bits >= 5 && out.length < 10) {
      out += B32[(val >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

/** The three parts a signature covers. Changing any of them breaks it. */
export const passBody = (ticket, kind, year) =>
  `${ticket}|${kind}|${String(year || "").charAt(0) || "?"}`;

export const nowISO = () => new Date().toISOString();

export const istStamp = (iso) =>
  new Date(iso).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });

export const isTicket = (t) => /^F26-\d{4}-\d{4}$/.test(String(t || "").toUpperCase());
