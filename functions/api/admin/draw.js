// What luckydrawpanel talks to.
//
//   GET  /api/admin/draw
//   POST /api/admin/draw {action:'save', ...}
//   POST /api/admin/draw {action:'draw'}
//   POST /api/admin/draw {action:'reset'}
//   POST /api/admin/draw {action:'clear'}
//   POST /api/admin/draw {action:'issue', ref:...}
//   POST /api/admin/draw {action:'new', ...}
//
// Needs: ADMIN_TOKEN, PASS_SECRET, DB

import { json, fail, requireToken, sign, passBody, nowISO } from "../../_lib.js";
import { phaseOf } from "../draw.js";

const KINDS = ["N", "A", "U"];

/* Ensures timestamps are saved with +05:30 IST offset without UTC conversion */
function cleanIST(val) {
  const s = String(val || "").trim();
  if (!s) return "";
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s)) return s + ":00+05:30";
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s)) return s + "+05:30";
  return s;
}

export async function onRequestGet({ request, env }) {
  const denied = requireToken(request, env, "ADMIN_TOKEN");
  if (denied) return denied;
  if (!env.DB) return fail("no database bound", 500);

  const draw = await latest(env);
  if (!draw) return json({ ok: true, draw: null, entries: [] });

  const { results } = await env.DB.prepare(
    `SELECT id, ref, name, year, phone, email, paid, utr, won, ticket, at
       FROM draw_entries WHERE draw_id = ?1 ORDER BY id DESC`
  ).bind(draw.id).all();

  return json({
    ok: true,
    draw: shape(draw),
    entries: results || [],
  });
}

export async function onRequestPost({ request, env }) {
  const denied = requireToken(request, env, "ADMIN_TOKEN");
  if (denied) return denied;
  if (!env.DB) return fail("no database bound", 500);

  let body;
  try { body = await request.json(); } catch { return fail("bad json"); }

  const action = String(body.action || "");
  const draw = await latest(env);

  if (action === "save") {
    if (!draw) return fail("no draw exists yet");
    const title     = String(body.title || "Free Pass").trim().slice(0, 60);
    const subtitle  = String(body.subtitle || "").trim().slice(0, 120);
    const kind      = KINDS.includes(body.kind) ? body.kind : "N";
    const seats     = Math.max(1, Math.min(100, Math.round(+body.seats || 2)));
    const entry_fee = Math.max(0, Math.min(10000, Math.round(+body.entry_fee || 0)));
    const visible   = body.visible ? 1 : 0;

    const opens_at  = cleanIST(body.opens_at  || draw.opens_at);
    const closes_at = cleanIST(body.closes_at || draw.closes_at);
    const result_at = cleanIST(body.result_at || body.closes_at || draw.result_at);

    await env.DB.prepare(
      `UPDATE draws SET
         title=?2, subtitle=?3, kind=?4, seats=?5, entry_fee=?6,
         opens_at=?7, closes_at=?8, result_at=?9, visible=?10
       WHERE id=?1`
    ).bind(draw.id, title, subtitle, kind, seats, entry_fee,
           opens_at, closes_at, result_at, visible).run();

    return json({ ok: true, draw: shape(await latest(env)) });
  }

  if (action === "new") {
    const title     = String(body.title || "Free Pass").trim().slice(0, 60);
    const subtitle  = String(body.subtitle || "").trim().slice(0, 120);
    const kind      = KINDS.includes(body.kind) ? body.kind : "N";
    const seats     = Math.max(1, Math.min(100, Math.round(+body.seats || 2)));
    const entry_fee = Math.max(0, Math.min(10000, Math.round(+body.entry_fee || 0)));

    const opens_at  = cleanIST(body.opens_at  || nowISO());
    const closes_at = cleanIST(body.closes_at || nowISO());
    const result_at = cleanIST(body.result_at || body.closes_at || nowISO());

    await env.DB.prepare(
      `INSERT INTO draws (title, subtitle, kind, seats, entry_fee,
                          opens_at, closes_at, result_at, visible, status, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,1,'live',?9)`
    ).bind(title, subtitle, kind, seats, entry_fee,
           opens_at, closes_at, result_at, nowISO()).run();

    return json({ ok: true, draw: shape(await latest(env)) });
  }

  if (action === "draw") {
    if (!draw) return fail("no draw exists");
    if (draw.status === "drawn") return fail("already drawn");

    const { results } = await env.DB.prepare(
      `SELECT id, ref, name, phone FROM draw_entries
        WHERE draw_id = ?1 AND (?2 = 0 OR paid > 0)
        ORDER BY RANDOM() LIMIT ?3`
    ).bind(draw.id, draw.entry_fee > 0 ? 1 : 0, draw.seats).all();

    const picked = results || [];
    const names = picked.map((r) => ({ ref: r.ref, name: r.name, phone: mask(r.phone) }));

    await env.DB.prepare(
      `UPDATE draws SET status='drawn', winners=?2, drawn_at=?3 WHERE id=?1`
    ).bind(draw.id, JSON.stringify(names), nowISO()).run();

    for (const w of picked) {
      await env.DB.prepare(`UPDATE draw_entries SET won=1 WHERE id=?1`).bind(w.id).run();
    }

    return json({ ok: true, winners: names });
  }

  if (action === "reset") {
    if (!draw) return fail("no draw exists");
    await env.DB.prepare(
      `UPDATE draws SET status='live', winners=NULL, drawn_at=NULL WHERE id=?1`
    ).bind(draw.id).run();
    await env.DB.prepare(
      `UPDATE draw_entries SET won=0, ticket=NULL WHERE draw_id=?1`
    ).bind(draw.id).run();
    return json({ ok: true });
  }

  if (action === "clear") {
    if (!draw) return fail("no draw exists");
    await env.DB.prepare(`DELETE FROM draw_entries WHERE draw_id=?1`).bind(draw.id).run();
    return json({ ok: true });
  }

  if (action === "issue") {
    if (!draw) return fail("no draw exists");
    if (!env.PASS_SECRET) return fail("PASS_SECRET is not set", 500);
    const ref = String(body.ref || "").trim();
    const entry = await env.DB.prepare(
      `SELECT * FROM draw_entries WHERE draw_id=?1 AND ref=?2`
    ).bind(draw.id, ref).first();

    if (!entry) return fail("no such entry", 404);
    if (!entry.won) return fail("only winning entries can be issued passes");
    if (entry.ticket) return json({ ok: true, ticket: entry.ticket, already: true });

    const phone = String(entry.phone || "").replace(/\D/g, "").slice(0, 15);
    const ticket = await freeTicket(env, phone);
    if (!ticket) return fail("could not allocate ticket number", 500);

    const kind = draw.kind;
    const year = entry.year || "1st Year";
    const at = nowISO();
    const signature = await sign(env.PASS_SECRET, passBody(ticket, kind, year));
    const label = (kind === "N" ? "Non-Alcoholic" : kind === "A" ? "Alcoholic" : "Unlimited") +
                  " Pass (Giveaway Winner)";

    await env.DB.prepare(
      `INSERT INTO registrations
         (ticket,name,year,kind,email,phone,reference,utr,amount,order_json,
          photo,thumb,status,signature,note,created_at,issued_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,'LUCKYDRAW',0,?8,NULL,NULL,'issued',?9,?10,?11,?11)`
    ).bind(
      ticket, entry.name, year, kind, entry.email || "", phone, ref,
      label, signature, "giveaway winner " + ref, at
    ).run();

    await env.DB.prepare(
      `UPDATE draw_entries SET ticket=?2 WHERE id=?1`
    ).bind(entry.id, ticket).run();

    return json({ ok: true, ticket, signature });
  }

  return fail("unknown action");
}

async function latest(env) {
  try {
    return await env.DB.prepare(`SELECT * FROM draws ORDER BY id DESC LIMIT 1`).first();
  } catch { return null; }
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
    visible: !!draw.visible,
    status: draw.status,
    phase: phaseOf(draw),
    winners: draw.winners ? safeList(draw.winners) : null,
  };
}

function safeList(s) {
  try { return JSON.parse(s || "[]"); } catch { return []; }
}

const mask = (p) => String(p || "").replace(/^(\d{2})\d+(\d{2})$/, "$1••••••$2");

async function freeTicket(env, phone) {
  const tail = (phone || "").slice(-4).padStart(4, "0");
  for (let attempt = 0; attempt < 12; attempt++) {
    const rnd = Math.floor(1000 + Math.random() * 9000);
    const candidate = `F26-${tail}-${rnd}`;
    const clash = await env.DB.prepare(
      `SELECT 1 FROM registrations WHERE ticket = ?1`
    ).bind(candidate).first();
    if (!clash) return candidate;
  }
  return null;
}
