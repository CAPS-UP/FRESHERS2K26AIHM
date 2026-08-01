// Manual numbers you can change from the panel, no redeploy.
//
//   GET  /api/admin/settings
//   POST /api/admin/settings   {offset_na:14, offset_al:4, pass_limit:60}
//
// Needs: ADMIN_TOKEN, DB

import { json, fail, requireToken } from "../_lib.js";

const ALLOWED = {
  offset_na:    { min: 0, max: 5000 },
  offset_al:    { min: 0, max: 5000 },
  offset_money: { min: 0, max: 100_000_000 },
  pass_limit:   { min: 1, max: 100_000 },
};

const DEFAULTS = { offset_na: 0, offset_al: 0, offset_money: 0, pass_limit: 26 };

/** Reads settings, falling back to defaults if the table is missing. */
export async function readSettings(env) {
  const out = { ...DEFAULTS };
  if (env.PASS_LIMIT) out.pass_limit = Number(env.PASS_LIMIT) || out.pass_limit;
  if (!env.DB) return out;
  try {
    const { results } = await env.DB.prepare(`SELECT key, value FROM settings`).all();
    for (const row of results || []) {
      if (row.key in out) out[row.key] = Number(row.value) || 0;
    }
  } catch {
    // migration not run yet — defaults are fine
  }
  return out;
}

export async function onRequestGet({ request, env }) {
  const denied = requireToken(request, env, "ADMIN_TOKEN");
  if (denied) return denied;
  return json({ ok: true, settings: await readSettings(env) });
}

export async function onRequestPost({ request, env }) {
  const denied = requireToken(request, env, "ADMIN_TOKEN");
  if (denied) return denied;
  if (!env.DB) return fail("no database bound", 500);

  let body;
  try { body = await request.json(); } catch { return fail("bad json"); }

  const writes = [];
  for (const [key, rule] of Object.entries(ALLOWED)) {
    if (!(key in body)) continue;
    const n = Math.round(Number(body[key]));
    if (!Number.isFinite(n) || n < rule.min || n > rule.max) {
      return fail(`${key} must be a whole number between ${rule.min} and ${rule.max}`);
    }
    writes.push(
      env.DB.prepare(
        `INSERT INTO settings (key,value) VALUES (?1,?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).bind(key, String(n))
    );
  }

  if (!writes.length) return fail("nothing to change");

  try {
    await env.DB.batch(writes);
  } catch (err) {
    return fail("could not save — has migration-2.sql been run?", 500);
  }

  return json({ ok: true, settings: await readSettings(env) });
}
