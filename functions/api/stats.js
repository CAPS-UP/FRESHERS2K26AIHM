// Public, no token. Lets the website show a real "9 of 26 left" instead of a
// number you have to remember to edit.
//
//   GET /api/stats
//
// Counts online registrations from the database and adds whatever you entered
// by hand in the panel for passes sold in person. Only counts — no names, no
// contact details, nothing personal.

import { json } from "./_lib.js";
import { readSettings } from "./admin/settings.js";

export async function onRequestGet({ env }) {
  const cfg = await readSettings(env);
  const total = cfg.pass_limit;

  const base = {
    ok: true, total,
    sold: cfg.offset_na + cfg.offset_al,
    left: Math.max(0, total - cfg.offset_na - cfg.offset_al),
    alcoholic: cfg.offset_al,
    nonalcoholic: cfg.offset_na,
    live: false,
  };
  if (!env.DB) return json(base);

  try {
    const row = await env.DB.prepare(
      `SELECT SUM(kind='A') AS alcoholic, SUM(kind='N') AS nonalcoholic
         FROM registrations
        WHERE status IN ('pending','issued')`
    ).first();

    const alcoholic    = Number(row?.alcoholic || 0)    + cfg.offset_al;
    const nonalcoholic = Number(row?.nonalcoholic || 0) + cfg.offset_na;
    const sold = alcoholic + nonalcoholic;

    return json({
      ok: true, live: true, total, sold,
      left: Math.max(0, total - sold),
      alcoholic, nonalcoholic,
    });
  } catch {
    return json(base);
  }
}
