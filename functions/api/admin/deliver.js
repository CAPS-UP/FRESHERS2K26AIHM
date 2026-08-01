// Sends an issued pass to the student by email and files a copy in Drive.
//
//   POST /api/admin/deliver
//   { ticket:"F26-1234-5678", png:"<base64, no data: prefix>" }
//
// The panel renders the pass, this hands it to your Apps Script, which does the
// actual sending from your Gmail. The recipient address is read from the
// database here rather than trusted from the browser.
//
// Needs: ADMIN_TOKEN, DB, DELIVER_URL, DELIVER_KEY

import { json, fail, requireToken, isTicket, nowISO } from "../_lib.js";

export async function onRequestPost({ request, env }) {
  const denied = requireToken(request, env, "ADMIN_TOKEN");
  if (denied) return denied;
  if (!env.DB) return fail("no database bound", 500);
  if (!env.DELIVER_URL || !env.DELIVER_KEY) {
    return fail("DELIVER_URL and DELIVER_KEY are not set — see deliver.gs", 500);
  }

  let body;
  try { body = await request.json(); } catch { return fail("bad json"); }

  const ticket = String(body.ticket || "").toUpperCase();
  if (!isTicket(ticket)) return fail("bad ticket number");

  const png = String(body.png || "").replace(/^data:image\/png;base64,/, "");
  if (!png) return fail("no pass image");
  if (png.length > 3_000_000) return fail("pass image too large");

  const row = await env.DB.prepare(
    `SELECT ticket,name,email,kind,status FROM registrations WHERE ticket = ?1`
  ).bind(ticket).first();

  if (!row) return fail("no such ticket", 404);
  if (row.status !== "issued") return fail("issue the pass before sending it");

  let result;
  try {
    const res = await fetch(env.DELIVER_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        key: env.DELIVER_KEY,
        ticket: row.ticket,
        name: row.name,
        email: row.email,
        kind: row.kind,
        png,
      }),
    });
    result = await res.json();
  } catch (err) {
    return fail("could not reach the delivery script", 502);
  }

  if (!result || !result.ok) {
    return fail((result && result.error) || "delivery script refused", 502);
  }

  // remember what happened so the panel can show who still needs sending
  try {
    await env.DB.prepare(
      `UPDATE registrations SET note = ?2 WHERE ticket = ?1`
    ).bind(ticket,
      (result.emailed ? "emailed " : "drive only ") + nowISO().slice(0, 16).replace("T", " ")
    ).run();
  } catch { /* the note is a convenience, not the point */ }

  return json({
    ok: true,
    ticket,
    emailed: !!result.emailed,
    to: row.email,
    driveLink: result.driveLink || "",
    quotaLeft: result.quotaLeft,
    mailError: result.mailError || "",
  });
}
