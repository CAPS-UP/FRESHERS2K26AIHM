// Someone hands you cash at a table. This makes them a real pass — a ticket
// number, a signature, a row in the database — so it works at the door and can
// be emailed like any other. Better than a counter, because a counter cannot
// get anybody through the gate.
//
//   POST /api/admin/cash
//   { name, kind:"N"|"A"|"U", year:"1st Year", phone, email, amount, note }
//
// Needs: ADMIN_TOKEN, PASS_SECRET, DB

import { json, fail, requireToken, sign, passBody, nowISO } from "../_lib.js";
import { readSettings, priceFor } from "./settings.js";

const KINDS = ["N", "A", "U"];

export async function onRequestPost({ request, env }) {
  const denied = requireToken(request, env, "ADMIN_TOKEN");
  if (denied) return denied;
  if (!env.DB) return fail("no database bound", 500);
  if (!env.PASS_SECRET) return fail("PASS_SECRET is not set", 500);

  let body;
  try { body = await request.json(); } catch { return fail("bad json"); }

  const name = String(body.name || "").trim();
  if (name.length < 2) return fail("enter a name");

  const kind = String(body.kind || "N").toUpperCase();
  if (!KINDS.includes(kind)) return fail("pass must be N, A or U");

  const year = String(body.year || "1st Year").slice(0, 20);
  const phone = String(body.phone || "").replace(/\D/g, "").slice(0, 15);
  const email = String(body.email || "").trim().slice(0, 160);

  const cfg = await readSettings(env);

  // how many of this kind have gone, so the unlimited pass gets the right price
  let soldU = cfg.offset_ul;
  try {
    const r = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM registrations WHERE kind='U' AND status IN ('pending','issued')`
    ).first();
    soldU += Number(r?.n || 0);
  } catch { /* leave it at the offset */ }

  const amount = Number.isFinite(+body.amount) && +body.amount > 0
    ? Math.round(+body.amount)
    : priceFor(kind, cfg, soldU);

  const ticket = await freeTicket(env, phone);
  if (!ticket) return fail("could not allocate a ticket number, try again", 500);

  const at = nowISO();
  const signature = await sign(env.PASS_SECRET, passBody(ticket, kind, year));
  const label = kind === "N" ? cfg.label_na : kind === "A" ? cfg.label_al : cfg.label_ul;

  await env.DB.prepare(
    `INSERT INTO registrations
       (ticket,name,year,kind,email,phone,reference,utr,amount,order_json,
        photo,thumb,status,signature,note,created_at,issued_at)
     VALUES (?1,?2,?3,?4,?5,?6,'Paid in person','CASH',?7,?8,
             NULL,NULL,'issued',?9,?10,?11,?11)`
  ).bind(
    ticket, name, year, kind, email, phone, amount,
    label + " x1 (cash)", signature,
    String(body.note || "cash entry").slice(0, 200), at
  ).run();

  return json({
    ok: true,
    ticket, signature, kind, year, name, amount, label,
    body: passBody(ticket, kind, year),
  });
}

/** Ticket numbers follow the same shape as the website's, and must be unique. */
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
