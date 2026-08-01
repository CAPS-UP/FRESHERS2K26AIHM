// Public, no token. Lets the website show a real "9 of 26 left" instead of a
// number you have to remember to edit.
//
//   GET /api/stats  ->  { total, sold, left, alcoholic, nonalcoholic }
//
// Only counts. No names, no contact details, nothing personal.

import { json } from "./_lib.js";

export async function onRequestGet({ env }) {
  const total = Number(env.PASS_LIMIT || 26);

  if (!env.DB) return json({ ok: true, total, sold: 0, left: total, live: false });

  try {
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS sold,
              SUM(kind='A') AS alcoholic,
              SUM(kind='N') AS nonalcoholic
         FROM registrations
        WHERE status IN ('pending','issued')`
    ).first();

    const sold = Number(row?.sold || 0);
    return json({
      ok: true, live: true, total, sold,
      left: Math.max(0, total - sold),
      alcoholic: Number(row?.alcoholic || 0),
      nonalcoholic: Number(row?.nonalcoholic || 0),
    });
  } catch {
    return json({ ok: true, total, sold: 0, left: total, live: false });
  }
}
