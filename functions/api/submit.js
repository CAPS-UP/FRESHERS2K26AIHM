// Receives the registration form, fans it out to Discord and (optionally)
// to a Google Sheet. The webhook URL never appears in the website source.
//
// Cloudflare Pages -> Settings -> Variables and secrets:
//   DISCORD_WEBHOOK   required   your webhook URL
//   SHEET_URL         optional   the Apps Script /exec URL

export async function onRequestPost({ request, env }) {
  const hook = env.DISCORD_WEBHOOK;
  if (!hook) {
    return new Response("DISCORD_WEBHOOK is not set", { status: 500 });
  }

  const incoming = await request.formData();

  // The sheet payload is ours, not Discord's — pull it out before forwarding.
  const sheetJson = incoming.get("sheet_json");

  const discord = new FormData();
  for (const [key, value] of incoming.entries()) {
    if (key === "sheet_json") continue;
    discord.append(key, value);
  }

  const res = await fetch(hook, { method: "POST", body: discord });

  // Best effort only. A sheet problem must never cost somebody their registration.
  if (sheetJson && env.SHEET_URL) {
    try {
      await fetch(env.SHEET_URL, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: sheetJson,
      });
    } catch (_) {}
  }

  return new Response(res.ok ? "ok" : "upstream rejected the form", {
    status: res.ok ? 200 : 502,
  });
}
