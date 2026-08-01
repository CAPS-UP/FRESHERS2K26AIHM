// Ankit's panel talks to this.
//
//   GET  /api/admin/passes?status=pending      list registrations
//   GET  /api/admin/passes?ticket=F26-...      one registration, with the photo
//   POST /api/admin/passes  {action:'issue',  tickets:[...]}   sign and issue
//   POST /api/admin/passes  {action:'reject', tickets:[...], note}
//   POST /api/admin/passes  {action:'unissue',tickets:[...]}   put back to pending
//
// Needs: ADMIN_TOKEN, PASS_SECRET, DB

import { json, fail, requireToken, sign, passBody, nowISO, isTicket } from "../_lib.js";

const LIST_COLUMNS = `ticket,name,year,kind,email,phone,reference,utr,amount,
                      order_json,thumb,status,signature,note,created_at,issued_at`;

export async function onRequestGet({ request, env }) {
  const denied = requireToken(request, env, "ADMIN_TOKEN");
  if (denied) return denied;
  if (!env.DB) return fail("no database bound", 500);

  const url = new URL(request.url);
  const one = url.searchParams.get("ticket");

  if (one) {
    if (!isTicket(one)) return fail("bad ticket number");
    const row = await env.DB.prepare(
      `SELECT *, (SELECT at FROM checkins WHERE checkins.ticket = registrations.ticket) AS checked_in
         FROM registrations WHERE ticket = ?1`
    ).bind(one.toUpperCase()).first();
    return row ? json({ ok: true, row }) : fail("not found", 404);
  }

  const status = url.searchParams.get("status") || "all";
  const search = (url.searchParams.get("q") || "").trim();

  let sql = `SELECT ${LIST_COLUMNS},
               (SELECT at FROM checkins WHERE checkins.ticket = registrations.ticket) AS checked_in
             FROM registrations`;
  const where = [];
  const binds = [];

  if (status !== "all") { where.push(`status = ?${binds.length + 1}`); binds.push(status); }
  if (search) {
    const i = binds.length + 1;
    where.push(`(name LIKE ?${i} OR ticket LIKE ?${i} OR phone LIKE ?${i} OR utr LIKE ?${i})`);
    binds.push(`%${search}%`);
  }
  if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
  sql += ` ORDER BY created_at DESC LIMIT 500`;

  const { results } = await env.DB.prepare(sql).bind(...binds).all();

  const counts = await env.DB.prepare(
    `SELECT
       COUNT(*)                                        AS total,
       SUM(status = 'pending')                         AS pending,
       SUM(status = 'issued')                          AS issued,
       SUM(status = 'rejected')                        AS rejected,
       SUM(kind = 'A' AND status = 'issued')           AS alcoholic,
       SUM(kind = 'N' AND status = 'issued')           AS nonalcoholic,
       COALESCE(SUM(CASE WHEN status='issued' THEN amount END),0) AS collected
     FROM registrations`
  ).first();

  // paid twice with the same reference number â€” worth seeing
  const { results: dupes } = await env.DB.prepare(
    `SELECT utr, COUNT(*) n FROM registrations
      WHERE utr <> '' AND utr IS NOT NULL
      GROUP BY utr HAVING n > 1`
  ).all();

  return json({ ok: true, rows: results || [], counts, duplicate_utrs: dupes || [] });
}

export async function onRequestPost({ request, env }) {
  const denied = requireToken(request, env, "ADMIN_TOKEN");
  if (denied) return denied;
  if (!env.DB) return fail("no database bound", 500);
  if (!env.PASS_SECRET) return fail("PASS_SECRET is not set", 500);

  let body;
  try { body = await request.json(); } catch { return fail("bad json"); }

  const action = String(body.action || "");
  const tickets = (Array.isArray(body.tickets) ? body.tickets : [])
    .map((t) => String(t).toUpperCase())
    .filter(isTicket);

  if (!tickets.length) return fail("no tickets given");
  if (tickets.length > 200) return fail("too many at once â€” do 200 or fewer");

  if (action === "issue") {
    const at = nowISO();
    const done = [];

    for (const ticket of tickets) {
      const row = await env.DB.prepare(
        `SELECT ticket, kind, year FROM registrations WHERE ticket = ?1`
      ).bind(ticket).first();
      if (!row) continue;

      const signature = await sign(env.PASS_SECRET, passBody(row.ticket, row.kind, row.year));
      await env.DB.prepare(
        `UPDATE registrations SET status='issued', signature=?2, issued_at=?3 WHERE ticket=?1`
      ).bind(ticket, signature, at).run();

      done.push({ ticket, signature, kind: row.kind, year: row.year });
    }
    return json({ ok: true, issued: done });
  }

  if (action === "reject" || action === "unissue") {
    const status = action === "reject" ? "rejected" : "pending";
    const note = String(body.note || "").slice(0, 200);
    const marks = tickets.map((_, i) => `?${i + 3}`).join(",");

    await env.DB.prepare(
      `UPDATE registrations
          SET status = ?1, note = ?2, signature = NULL, issued_at = NULL
        WHERE ticket IN (${marks})`
    ).bind(status, note, ...tickets).run();

    return json({ ok: true, changed: tickets.length, status });
  }

  return fail("unknown action");
}
