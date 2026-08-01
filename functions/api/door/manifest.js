// What the scanner downloads so it can work with no signal.
//
//   GET /api/door/manifest        everything issued, plus who is already inside
//   GET /api/door/manifest?thin=1 same list without photos, for a slow connection
//
// The signing secret is never sent. Only the signatures are, which is all the
// scanner needs to tell a real pass from a forged one.
//
// Needs: DOOR_TOKEN (or ADMIN_TOKEN), DB

import { json, fail, requireToken, nowISO } from "../_lib.js";

export async function onRequestGet({ request, env }) {
  const denied = requireToken(request, env, "DOOR_TOKEN", "ADMIN_TOKEN");
  if (denied) return denied;
  if (!env.DB) return fail("no database bound", 500);

  const thin = new URL(request.url).searchParams.get("thin") === "1";

  const { results: passes } = await env.DB.prepare(
    `SELECT ticket, name, year, kind, signature${thin ? "" : ", thumb"}
       FROM registrations
      WHERE status = 'issued' AND signature IS NOT NULL
      ORDER BY name`
  ).all();

  const { results: inside } = await env.DB.prepare(
    `SELECT ticket, at, verified FROM checkins`
  ).all();

  return json({
    ok: true,
    at: nowISO(),
    passes: passes || [],
    inside: inside || [],
    count: (passes || []).length,
  });
}
