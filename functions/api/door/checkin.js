// Records people coming through the gate.
//
//   POST /api/door/checkin
//   { device:"aarti-phone", scans:[ {raw:"F26-...|N|1|SIG", at:"ISO", verified:1} ] }
//
// Send one scan or a queue of them â€” the scanner posts its backlog the moment
// the signal returns. Every scan comes back with its own verdict, so a phone
// that was offline finds out it let in a duplicate.
//
// Duplicates are caught by the database, not by checking first and then
// inserting. Two phones scanning the same ticket at the same moment cannot both
// win, because `ticket` is the primary key and the second insert changes nothing.
//
// Needs: DOOR_TOKEN (or ADMIN_TOKEN), PASS_SECRET, DB

import { json, fail, requireToken, sign, passBody, nowISO, isTicket } from "../_lib.js";

export async function onRequestPost({ request, env }) {
  const denied = requireToken(request, env, "DOOR_TOKEN", "ADMIN_TOKEN");
  if (denied) return denied;
  if (!env.DB) return fail("no database bound", 500);
  if (!env.PASS_SECRET) return fail("PASS_SECRET is not set", 500);

  let body;
  try { body = await request.json(); } catch { return fail("bad json"); }

  const device = String(body.device || "unknown").slice(0, 40);
  const scans = Array.isArray(body.scans) ? body.scans.slice(0, 300) : [];
  if (!scans.length) return fail("no scans given");

  const out = [];
  for (const scan of scans) {
    out.push(await handleOne(env, device, scan));
  }

  const counts = await env.DB.prepare(
    `SELECT COUNT(*) AS inside,
            SUM(r.kind = 'A') AS alcoholic
       FROM checkins c JOIN registrations r ON r.ticket = c.ticket`
  ).first();

  return json({ ok: true, results: out, counts });
}

async function handleOne(env, device, scan) {
  const raw = String(scan.raw || "").trim().toUpperCase();
  const at = validISO(scan.at) || nowISO();
  const verified = scan.verified ? 1 : 0;
  const parts = raw.split("|");
  const ticket = parts[0];

  const reject = async (verdict, message, extra = {}) => {
    await env.DB.prepare(
      `INSERT INTO door_log (at,ticket,verdict,device,raw) VALUES (?1,?2,?3,?4,?5)`
    ).bind(at, isTicket(ticket) ? ticket : null, verdict, device, raw.slice(0, 120)).run();
    return { raw, ticket, verdict, message, ...extra };
  };

  if (!isTicket(ticket)) {
    return reject("unknown", "Not a Freshers 2K26 pass.");
  }

  const row = await env.DB.prepare(
    `SELECT ticket,name,year,kind,status,signature,thumb FROM registrations WHERE ticket = ?1`
  ).bind(ticket).first();

  if (!row) return reject("unknown", "This ticket was never issued.");
  if (row.status === "rejected") {
    return reject("revoked", "This pass was cancelled.", { name: row.name });
  }
  if (row.status !== "issued" || !row.signature) {
    return reject("unknown", "This pass has not been issued yet.", { name: row.name });
  }

  // A scanned QR carries the signature. A hand-typed number has only the ticket,
  // and is allowed through as unverified.
  if (parts.length === 4) {
    const expected = await sign(env.PASS_SECRET, passBody(row.ticket, row.kind, row.year));
    const tampered =
      parts[3] !== expected ||
      parts[1] !== row.kind ||
      parts[2] !== String(row.year || "").charAt(0);
    if (tampered) {
      return reject("forged", "This code does not match what was issued.",
        { name: row.name, thumb: row.thumb });
    }
  }

  // The insert is the lock. If it changes no rows, someone got here first.
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO checkins (ticket,at,device,verified) VALUES (?1,?2,?3,?4)`
  ).bind(ticket, at, device, verified).run();

  const inserted = (res.meta && (res.meta.changes || res.meta.rows_written)) || 0;

  if (!inserted) {
    const prior = await env.DB.prepare(
      `SELECT at, device FROM checkins WHERE ticket = ?1`
    ).bind(ticket).first();
    await env.DB.prepare(
      `INSERT INTO door_log (at,ticket,verdict,device,raw) VALUES (?1,?2,'duplicate',?3,?4)`
    ).bind(at, ticket, device, raw.slice(0, 120)).run();

    return {
      raw, ticket, verdict: "duplicate",
      message: "Already inside â€” came through at " + istTime(prior && prior.at),
      name: row.name, year: row.year, kind: row.kind, thumb: row.thumb,
      first_at: prior && prior.at, first_device: prior && prior.device,
    };
  }

  await env.DB.prepare(
    `INSERT INTO door_log (at,ticket,verdict,device,raw) VALUES (?1,?2,'admitted',?3,?4)`
  ).bind(at, ticket, device, raw.slice(0, 120)).run();

  return {
    raw, ticket, verdict: verified ? "admitted" : "admitted-unverified",
    message: verified ? "Let them in" : "Let in without a QR scan",
    name: row.name, year: row.year, kind: row.kind, thumb: row.thumb, at,
  };
}

function validISO(v) {
  const d = new Date(String(v || ""));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function istTime(iso) {
  if (!iso) return "earlier";
  return new Date(iso).toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit",
  });
}
