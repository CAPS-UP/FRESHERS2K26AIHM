// Where the website's registration form lands.
//
// Order matters: the database write happens first and is the thing that must
// succeed. Discord and the Google Sheet are notifications — if either is down,
// the student is still registered.
//
// Bindings and variables needed:
//   DB               D1 database          (required)
//   DISCORD_WEBHOOK  secret               (optional)
//   SHEET_URL        Apps Script /exec    (optional)

import { json, fail, nowISO, isTicket } from "./_lib.js";

// what the website calls each pass -> what the database stores
const KIND = {
  "Non-Alcoholic": "N",
  "Alcoholic": "A",
  "Unlimited": "U",
};

export async function onRequestPost({ request, env }) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return fail("could not read the form");
  }

  const meta = safeParse(form.get("meta_json"));
  if (!meta) return fail("missing meta_json");

  const ticket = String(meta.ticket || "").toUpperCase();
  if (!isTicket(ticket)) return fail("bad ticket number");
  if (!meta.name || String(meta.name).trim().length < 2) return fail("missing name");

  const row = {
    ticket,
    name: String(meta.name).trim().slice(0, 120),
    year: String(meta.year || "").slice(0, 20),
    kind: KIND[String(meta.pass || "")] || "N",
    email: String(meta.email || "").slice(0, 160),
    phone: String(meta.phone || "").replace(/\D/g, "").slice(0, 15),
    reference: String(meta.ref || "").slice(0, 120),
    utr: String(meta.utr || "").toUpperCase().slice(0, 32),
    amount: Number.isFinite(+meta.amount) ? Math.round(+meta.amount) : 0,
    order_json: String(meta.order || "").slice(0, 2000),
    photo: dataURL(form.get("photo_400"), 260_000),
    thumb: dataURL(form.get("photo_110"), 40_000),
    created_at: nowISO(),
  };

  if (env.DB) {
    try {
      // A repeat submission of the same ticket updates rather than erroring,
      // but never downgrades a pass that has already been issued.
      await env.DB.prepare(
        `INSERT INTO registrations
           (ticket,name,year,kind,email,phone,reference,utr,amount,order_json,
            photo,thumb,status,created_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'pending',?13)
         ON CONFLICT(ticket) DO UPDATE SET
           name=excluded.name, year=excluded.year, kind=excluded.kind,
           email=excluded.email, phone=excluded.phone, reference=excluded.reference,
           utr=excluded.utr, amount=excluded.amount, order_json=excluded.order_json,
           photo=excluded.photo, thumb=excluded.thumb
         WHERE registrations.status = 'pending'`
      ).bind(
        row.ticket, row.name, row.year, row.kind, row.email, row.phone,
        row.reference, row.utr, row.amount, row.order_json,
        row.photo, row.thumb, row.created_at
      ).run();
    } catch (err) {
      return fail("could not save your registration — please try again", 500);
    }
  }

  // ---- notifications, best effort ----
  const discord = form.get("payload_json") ? relayDiscord(form, env) : null;
  const sheet = form.get("sheet_json") ? relaySheet(form.get("sheet_json"), env) : null;
  await Promise.allSettled([discord, sheet].filter(Boolean));

  return json({ ok: true, ticket });
}

function safeParse(v) {
  if (!v) return null;
  try { return JSON.parse(String(v)); } catch { return null; }
}

function dataURL(value, limit) {
  const s = String(value || "");
  if (!s.startsWith("data:image/")) return null;
  return s.length > limit ? null : s;
}

async function relayDiscord(form, env) {
  if (!env.DISCORD_WEBHOOK) return;
  const out = new FormData();
  for (const [k, v] of form.entries()) {
    if (k === "meta_json" || k === "sheet_json" || k === "photo_400" || k === "photo_110") continue;
    out.append(k, v);
  }
  await fetch(env.DISCORD_WEBHOOK, { method: "POST", body: out });
}

async function relaySheet(payload, env) {
  if (!env.SHEET_URL) return;
  await fetch(env.SHEET_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: String(payload),
  });
}
