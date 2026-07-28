export async function onRequestPost({ request, env }) {
  const hook = env.DISCORD_WEBHOOK;
  if (!hook) {
    return new Response("DISCORD_WEBHOOK is not set", { status: 500 });
  }

  const form = await request.formData();

  const res = await fetch(hook, { method: "POST", body: form });

  return new Response(res.ok ? "ok" : "upstream rejected the form", {
    status: res.ok ? 200 : 502,
  });
}
