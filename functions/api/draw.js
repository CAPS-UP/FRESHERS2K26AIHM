// What luckydrawpanel talks to.
//
//   GET  /api/admin/draw                      settings, entries, winners
//   POST /api/admin/draw {action:'save',  ...}  times, fee, seats, wording
//   POST /api/admin/draw {action:'draw'}        pick winners now
//   POST /api/admin/draw {action:'reset'}       clear the result, reopen
//   POST /api/admin/draw {action:'clear'}       delete every entry
//   POST /api/admin/draw {action:'issue', ref}  turn a winner into a real pass
//   POST /api/admin/draw {action:'new',   ...}  start a fresh draw
//
// Needs: ADMIN_TOKEN, PASS_SECRET, DB

import { json, fail, requireToken, sign, passBody, nowISO } from "../_lib.js";
import { phaseOf } from "../draw.js";

const KINDS = ["N", "A", "U"];

export async function onRequestGet({ request, env }) {
  const denied = requireToken(request, env, "ADMIN_TOKEN");
  if (denied) return denied;
  if (!env.DB) return fail("no database bound", 500);

  const draw = await latest(env);
  if (!draw) return json({ ok: true, draw: null, entries: [] });

  const { results } = await env.DB.prepare(
    `SELECT id, ref, name, year, phone, email, paid, utr, won, ticket, at
       FROM draw_entries WHERE draw_id = ?1 ORDER BY at DESC LIMIT 500`
  ).bind(draw.id).all();

  return json({
    ok: true,
    draw: { ...draw, phase: phaseOf(draw), winners: parse(draw.winners) },
    entries: results || [],
    now: nowISO(),
  });
}

export async function onRequestPost({ request, env }) {
  const denied = requireToken(request, env, "ADMIN_TOKEN");
  if (denied) return denied;
  if (!env.DB) return fail("no database bound", 500);

  let body;
  try { body = await request.json(); } catch { return fail("bad json"); }
  const action = String(body.action || "");

  if (action === "new") {
    await env.DB.prepare(
      `INSERT INTO draws (title, subtitle, kind, seats, entry_fee,
                          opens_at, closes_at, result_at, visible, status, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,1,'live',?9)`
    ).bind(
      str(body.title, "Free Pass", 60),
      str(body.subtitle, "Two seats. No charge. Pure luck.", 120),
      KINDS.includes(body.kind) ? body.kind : "N",
      clamp(body.seats, 1, 500, 2),
      clamp(body.entry_fee, 0, 100000, 0),
      iso(body.opens_at), iso(body.closes_at),
      iso(body.result_at || body.closes_at),
      nowISO()
    ).run();
    return json({ ok: true, created: true });
  }

  const draw = await latest(env);
  if (!draw) return fail("no draw yet — create one first", 404);

  if (action === "save") {
    const opens  = iso(body.opens_at)  || draw.opens_at;
    const closes = iso(body.closes_at) || draw.closes_at;
    const result = iso(body.result_at) || closes;

    if (Date.parse(closes) <= Date.parse(opens)) {
      return fail("the closing time must be after the opening time");
    }
    if (Date.parse(result) < Date.parse(closes)) {
      return fail("results cannot be before entries close");
    }

    await env.DB.prepare(
      `UPDATE draws SET title=?2, subtitle=?3, kind=?4, seats=?5, entry_fee=?6,
                        opens_at=?7, closes_at=?8, result_at=?9, visible=?10
        WHERE id=?1`
    ).bind(
      draw.id,
      str(body.title, draw.title, 60),
      str(body.subtitle, draw.subtitle, 120),
      KINDS.includes(body.kind) ? body.kind : draw.kind,
      clamp(body.seats, 1, 500, draw.seats),
      clamp(body.entry_fee, 0, 100000, draw.entry_fee),
      opens, closes, result,
      body.visible ? 1 : 0
    ).run();

    return json({ ok: true, draw: { ...(await latest(env)) } });
  }

  if (action === "draw") {
    if (draw.status === "drawn") return fail("already drawn — reset first");

    const { results } = await env.DB.prepare(
      `SELECT id, ref, name, phone FROM draw_entries
        WHERE draw_id = ?1 AND (?2 = 0 OR paid > 0)
        ORDER BY RANDOM() LIMIT ?3`
    ).bind(draw.id, draw.entry_fee > 0 ? 1 : 0, draw.seats).all();

    const picked = results || [];
    if (!picked.length) return fail("nobody has entered yet");

    const names = picked.map((r) => ({
      ref: r.ref, name: r.name,
      phone: String(r.phone).replace(/^(\d{2})\d+(\d{2})$/, "$1••••••$2"),
    }));

    await env.DB.prepare(
      `UPDATE draws SET status='drawn', winners=?2, drawn_at=?3 WHERE id=?1`
    ).bind(draw.id, JSON.stringify(names), nowISO()).run();

    for (const w of picked) {
      await env.DB.prepare(`UPDATE draw_entries SET won=1 WHERE id=?1`).bind(w.id).run();
    }
    return json({ ok: true, winners: names });
  }

  if (action === "reset") {
    await env.DB.prepare(
      `UPDATE draws SET status='live', winners=NULL, drawn_at=NULL WHERE id=?1`
    ).bind(draw.id).run();
    await env.DB.prepare(`UPDATE draw_entries SET won=0 WHERE draw_id=?1`).bind(draw.id).run();
    return json({ ok: true });
  }

  if (action === "clear") {
    await env.DB.prepare(`DELETE FROM draw_entries WHERE draw_id=?1`).bind(draw.id).run();
    await env.DB.prepare(
      `UPDATE draws SET status='live', winners=NULL, drawn_at=NULL WHERE id=?1`
    ).bind(draw.id).run();
    return json({ ok: true, cleared: true });
  }

  /* Turns a winner into a real pass, so they go through the door like anyone else. */
  if (action === "issue") {
    if (!env.PASS_SECRET) return fail("PASS_SECRET is not set", 500);
    const ref = String(body.ref || "").toUpperCase();

    const e = await env.DB.prepare(
      `SELECT * FROM draw_entries WHERE draw_id=?1 AND ref=?2`
    ).bind(draw.id, ref).first();
    if (!e) return fail("no such entry", 404);
    if (!e.won) return fail("that entry did not win");
    if (e.ticket) return json({ ok: true, ticket: e.ticket, already: true });

    const ticket = await freeTicket(env, e.phone);
    if (!ticket) return fail("could not allocate a ticket number", 500);

    const year = e.year || "1st Year";
    const at = nowISO();
    const signature = await sign(env.PASS_SECRET, passBody(ticket, draw.kind, year));

    await env.DB.prepare(
      `INSERT INTO registrations
         (ticket,name,year,kind,email,phone,reference,utr,amount,order_json,
          photo,thumb,status,signature,note,created_at,issued_at)
       VALUES (?1,?2,?3,?4,?5,?6,'Lucky draw','DRAW',0,?7,
               NULL,NULL,'issued',?8,?9,?10,?10)`
    ).bind(ticket, e.name, year, draw.kind, e.email, e.phone,
           draw.title + " (won)", signature, "lucky draw winner " + ref, at).run();

    await env.DB.prepare(
      `UPDATE draw_entries SET ticket=?2 WHERE id=?1`
    ).bind(e.id, ticket).run();

    return json({ ok: true, ticket, name: e.name });
  }

  return fail("unknown action");
}

/* ---------------- helpers ---------------- */
const latest = (env) => env.DB.prepare(`SELECT * FROM draws ORDER BY id DESC LIMIT 1`).first();
const parse = (s) => { try { return JSON.parse(s || "null"); } catch { return null; } };
const str = (v, fallback, max) => {
  const s = String(v == null ? "" : v).trim();
  return s ? s.slice(0, max) : fallback;
};
function clamp(v, lo, hi, fallback) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : fallback;
}
function iso(v) {
  if (!v) return null;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d.toISOString();
}
async function freeTicket(env, phone) {
  const tail = String(phone || "").slice(-4).padStart(4, "0");
  for (let i = 0; i < 12; i++) {
    const c = `F26-${tail}-${Math.floor(1000 + Math.random() * 9000)}`;
    const clash = await env.DB.prepare(`SELECT 1 FROM registrations WHERE ticket=?1`).bind(c).first();
    if (!clash) return c;
  }
  return null;
}
