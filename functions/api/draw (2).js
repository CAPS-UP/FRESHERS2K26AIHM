// The lucky draw, as the website sees it.
//
//   GET  /api/draw            what phase we are in, and the times
//   GET  /api/draw?ref=LD-XX  one entrant's own result
//   POST /api/draw            enter  { name, year, phone, email, utr }
//
// Winners are picked by the server the first time anyone asks after the
// window closes. Nobody has to be awake to press a button, and the pick
// cannot be re-rolled — the update only lands while the status is still live.
//
// Needs: DB. No token — this is public.

import { json, fail, nowISO } from "./_lib.js";

const REF_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ ok: true, on: false });

  const url = new URL(request.url);
  const ref = (url.searchParams.get("ref") || "").toUpperCase().trim();

  const draw = await current(env);
  if (!draw) return json({ ok: true, on: false });

  await maybeDraw(env, draw);
  const fresh = await current(env);
  const view = shape(fresh);

  if (!ref) {
    const c = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM draw_entries WHERE draw_id = ?1`
    ).bind(fresh.id).first();
    view.entries = Number(c?.n || 0);
    return json({ ok: true, on: true, draw: view, now: nowISO() });
  }

  const row = await env.DB.prepare(
    `SELECT ref, name, won, ticket, at FROM draw_entries WHERE draw_id = ?1 AND ref = ?2`
  ).bind(fresh.id, ref).first();

  if (!row) return json({ ok: true, on: true, draw: view, found: false, now: nowISO() });

  return json({
    ok: true, on: true, draw: view, found: true, now: nowISO(),
    entry: {
      ref: row.ref, name: row.name,
      won: view.phase === "drawn" ? !!row.won : null,   // no peeking early
      ticket: row.won ? row.ticket : null,
    },
  });
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return fail("draw is not set up", 503);

  let body;
  try { body = await request.json(); } catch { return fail("bad json"); }

  const draw = await current(env);
  if (!draw || !draw.visible || draw.status === "off") return fail("the draw is not running", 403);

  const phase = phaseOf(draw);
  if (phase === "soon")   return fail("entries have not opened yet", 403);
  if (phase !== "live")   return fail("entries are closed", 403);

  const name  = String(body.name || "").trim().slice(0, 120);
  const phone = String(body.phone || "").replace(/\D/g, "").slice(0, 15);
  const email = String(body.email || "").trim().slice(0, 160);
  const year  = String(body.year || "").slice(0, 20);
  const utr   = String(body.utr || "").toUpperCase().trim().slice(0, 32);

  if (name.length < 2) return fail("enter your name");
  if (phone.length !== 10) return fail("enter a 10-digit phone number");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail("enter a valid email");
  if (draw.entry_fee > 0 && utr.length < 8) return fail("enter the UTR from your payment");

  // already in?
  const seen = await env.DB.prepare(
    `SELECT ref FROM draw_entries WHERE draw_id = ?1 AND phone = ?2`
  ).bind(draw.id, phone).first();
  if (seen) return json({ ok: true, ref: seen.ref, already: true });

  const ref = await freeRef(env);
  try {
    await env.DB.prepare(
      `INSERT INTO draw_entries (draw_id, ref, name, year, phone, email, paid, utr, at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`
    ).bind(draw.id, ref, name, year, phone, email,
           draw.entry_fee > 0 ? draw.entry_fee : 0, utr, nowISO()).run();
  } catch {
    // the unique index caught a double tap
    const again = await env.DB.prepare(
      `SELECT ref FROM draw_entries WHERE draw_id = ?1 AND phone = ?2`
    ).bind(draw.id, phone).first();
    if (again) return json({ ok: true, ref: again.ref, already: true });
    return fail("could not save your entry, try again", 500);
  }

  const c = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM draw_entries WHERE draw_id = ?1`
  ).bind(draw.id).first();

  return json({ ok: true, ref, entries: Number(c?.n || 0), result_at: draw.result_at });
}

/* ---------------- helpers ---------------- */

async function current(env) {
  try {
    return await env.DB.prepare(
      `SELECT * FROM draws ORDER BY id DESC LIMIT 1`
    ).first();
  } catch { return null; }
}

export function phaseOf(draw) {
  if (!draw || !draw.visible || draw.status === "off") return "off";
  if (draw.status === "drawn") return "drawn";
  const now = Date.now();
  if (now < Date.parse(draw.opens_at)) return "soon";
  if (now < Date.parse(draw.closes_at)) return "live";
  return "closed";
}

function shape(draw) {
  return {
    id: draw.id,
    title: draw.title,
    subtitle: draw.subtitle,
    kind: draw.kind,
    seats: draw.seats,
    entry_fee: draw.entry_fee,
    opens_at: draw.opens_at,
    closes_at: draw.closes_at,
    result_at: draw.result_at || draw.closes_at,
    phase: phaseOf(draw),
    winners: draw.status === "drawn" ? safeList(draw.winners) : null,
  };
}

function safeList(s) {
  try { return JSON.parse(s || "[]"); } catch { return []; }
}

/** Picks winners once the window has closed. Only the first caller wins the race. */
async function maybeDraw(env, draw) {
  if (!draw || draw.status !== "live") return;
  if (Date.now() < Date.parse(draw.result_at || draw.closes_at)) return;
  if (Date.now() < Date.parse(draw.closes_at)) return;

  const { results } = await env.DB.prepare(
    `SELECT id, ref, name, phone FROM draw_entries
      WHERE draw_id = ?1 AND (?2 = 0 OR paid > 0)
      ORDER BY RANDOM() LIMIT ?3`
  ).bind(draw.id, draw.entry_fee > 0 ? 1 : 0, draw.seats).all();

  const picked = results || [];
  const names = picked.map((r) => ({ ref: r.ref, name: r.name, phone: mask(r.phone) }));

  // only lands while the row still says live, so a second request cannot re-roll
  const res = await env.DB.prepare(
    `UPDATE draws SET status='drawn', winners=?2, drawn_at=?3 WHERE id=?1 AND status='live'`
  ).bind(draw.id, JSON.stringify(names), nowISO()).run();

  const changed = (res.meta && (res.meta.changes || res.meta.rows_written)) || 0;
  if (!changed) return;                       // somebody else drew first

  for (const w of picked) {
    await env.DB.prepare(`UPDATE draw_entries SET won=1 WHERE id=?1`).bind(w.id).run();
  }
}

const mask = (p) => String(p || "").replace(/^(\d{2})\d+(\d{2})$/, "$1••••••$2");

async function freeRef(env) {
  for (let i = 0; i < 14; i++) {
    let r = "LD-";
    for (let k = 0; k < 4; k++) {
      r += REF_ALPHABET[Math.floor(Math.random() * REF_ALPHABET.length)];
    }
    const clash = await env.DB.prepare(
      `SELECT 1 FROM draw_entries WHERE ref = ?1`
    ).bind(r).first();
    if (!clash) return r;
  }
  return "LD-" + Date.now().toString(36).toUpperCase().slice(-4);
}
