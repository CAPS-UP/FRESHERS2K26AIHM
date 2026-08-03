// Public, no token. Feeds the live counters on the website.
//
//   GET /api/stats
//
// Counts online registrations, adds whatever you entered by hand for passes
// sold in person, and works out what the unlimited pass costs right now.
// Only counts and prices. Nothing personal.

import { json } from "./_lib.js";
import { readSettings, priceFor } from "./admin/settings.js";

export async function onRequestGet({ env }) {
  const cfg = await readSettings(env);

  let online = { N: 0, A: 0, U: 0 };
  let live = false;

  if (env.DB) {
    try {
      const row = await env.DB.prepare(
        `SELECT SUM(kind='N') AS n, SUM(kind='A') AS a, SUM(kind='U') AS u
           FROM registrations
          WHERE status IN ('pending','issued')`
      ).first();
      online = { N: Number(row?.n || 0), A: Number(row?.a || 0), U: Number(row?.u || 0) };
      live = true;
    } catch { /* fall through to offsets only */ }
  }

  const sold = {
    N: online.N + cfg.offset_na,
    A: online.A + cfg.offset_al,
    U: online.U + cfg.offset_ul,
  };

  const tier = (kind, limit, label) => ({
    kind, label, limit,
    sold: sold[kind],
    left: Math.max(0, limit - sold[kind]),
    price: priceFor(kind, cfg, sold.U),
  });

  const tiers = {
    N: tier("N", cfg.limit_na, cfg.label_na),
    A: tier("A", cfg.limit_al, cfg.label_al),
    U: tier("U", cfg.limit_ul, cfg.label_ul),
  };

  // the unlimited pass steps up in price after the first few
  tiers.U.early_qty   = cfg.ul_early_qty;
  tiers.U.early_price = cfg.ul_early_price;
  tiers.U.full_price  = cfg.ul_price;
  tiers.U.early_left  = Math.max(0, cfg.ul_early_qty - sold.U);
  tiers.U.show_early  = cfg.show_early === 1 && tiers.U.early_left > 0;

  const total = cfg.limit_na + cfg.limit_al + cfg.limit_ul;
  const gone = sold.N + sold.A + sold.U;

  return json({
    ok: true, live, tiers,
    total, sold: gone, left: Math.max(0, total - gone),
  });
}
