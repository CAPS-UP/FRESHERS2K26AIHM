// Everything you can change from the panel without redeploying.
//
//   GET  /api/admin/settings
//   POST /api/admin/settings   { limit_na:75, price_al:1299, label_ul:"...", ... }
//
// Needs: ADMIN_TOKEN, DB

import { json, fail, requireToken } from "../_lib.js";

const NUMBERS = {
  limit_na: [0, 100000], limit_al: [0, 100000], limit_ul: [0, 100000],
  offset_na: [0, 100000], offset_al: [0, 100000], offset_ul: [0, 100000],
  offset_money: [0, 100000000],
  price_na: [0, 100000], price_al: [0, 100000],
  ul_early_qty: [0, 100000], ul_early_price: [0, 100000], ul_price: [0, 100000],
  show_early: [0, 1],
  pass_limit: [0, 100000],
};

const TEXTS = { label_na: 40, label_al: 40, label_ul: 40 };

const DEFAULTS = {
  limit_na: 75, limit_al: 75, limit_ul: 40,
  offset_na: 0, offset_al: 0, offset_ul: 0, offset_money: 0,
  price_na: 999, price_al: 1299,
  ul_early_qty: 20, ul_early_price: 1400, ul_price: 1500,
  show_early: 1, pass_limit: 190,
  label_na: "Non-Alcoholic Pass",
  label_al: "Alcoholic Pass",
  label_ul: "Unlimited Pass",
};

/** Current settings, falling back to defaults if the migration has not run. */
export async function readSettings(env) {
  const out = { ...DEFAULTS };
  if (!env.DB) return out;
  try {
    const { results } = await env.DB.prepare(`SELECT key, value FROM settings`).all();
    for (const row of results || []) {
      if (!(row.key in out)) continue;
      out[row.key] = row.key in TEXTS ? String(row.value) : (Number(row.value) || 0);
    }
  } catch { /* table not there yet */ }
  return out;
}

/** What a pass of this kind costs right now, given how many have gone. */
export function priceFor(kind, cfg, soldUL) {
  if (kind === "N") return cfg.price_na;
  if (kind === "A") return cfg.price_al;
  return soldUL < cfg.ul_early_qty ? cfg.ul_early_price : cfg.ul_price;
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

  for (const [key, [lo, hi]] of Object.entries(NUMBERS)) {
    if (!(key in body)) continue;
    const n = Math.round(Number(body[key]));
    if (!Number.isFinite(n) || n < lo || n > hi) {
      return fail(`${key} must be a whole number between ${lo} and ${hi}`);
    }
    writes.push(save(env, key, String(n)));
  }

  for (const [key, max] of Object.entries(TEXTS)) {
    if (!(key in body)) continue;
    const v = String(body[key]).trim().slice(0, max);
    if (!v) return fail(`${key} cannot be empty`);
    writes.push(save(env, key, v));
  }

  if (!writes.length) return fail("nothing to change");

  try { await env.DB.batch(writes); }
  catch { return fail("could not save — has migration-3.sql been run?", 500); }

  return json({ ok: true, settings: await readSettings(env) });
}

function save(env, key, value) {
  return env.DB.prepare(
    `INSERT INTO settings (key,value) VALUES (?1,?2)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).bind(key, value);
}
