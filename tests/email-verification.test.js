const test = require("node:test");
const assert = require("node:assert/strict");

process.env.APP_ENCRYPTION_KEY = "test-only-encryption-key-at-least-32-characters";
const cloud = require("../cloud");

function withSupabaseMock(t, handler) {
  const previous = {
    url: process.env.SUPABASE_URL,
    anon: process.env.SUPABASE_ANON_KEY,
    fetch: global.fetch,
  };
  process.env.SUPABASE_URL = "https://project-ref.supabase.co";
  process.env.SUPABASE_ANON_KEY = "test-anon-key";
  global.fetch = handler;
  t.after(() => {
    global.fetch = previous.fetch;
    if (previous.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previous.url;
    if (previous.anon === undefined) delete process.env.SUPABASE_ANON_KEY; else process.env.SUPABASE_ANON_KEY = previous.anon;
  });
}

test("requests a password recovery email with the configured site callback", async (t) => {
  let request;
  const previousPublicUrl = process.env.PUBLIC_APP_URL;
  process.env.PUBLIC_APP_URL = "https://kaoyan-hero.onrender.com/";
  t.after(() => {
    if (previousPublicUrl === undefined) delete process.env.PUBLIC_APP_URL; else process.env.PUBLIC_APP_URL = previousPublicUrl;
  });
  withSupabaseMock(t, async (url, options) => {
    request = { url, options };
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  });

  assert.deepEqual(await cloud.requestPasswordReset({ email: "Hero@example.com" }), { ok: true });
  const url = new URL(request.url);
  assert.equal(url.pathname, "/auth/v1/recover");
  assert.equal(url.searchParams.get("redirect_to"), "https://kaoyan-hero.onrender.com/");
  assert.deepEqual(JSON.parse(request.options.body), { email: "hero@example.com" });
});

test("updates a signed-in user's password", async (t) => {
  let request;
  withSupabaseMock(t, async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ id: "user-1" }), { status: 200, headers: { "Content-Type": "application/json" } });
  });

  assert.deepEqual(await cloud.updatePassword({ accessToken: "recovery-access" }, { password: "new-secret12" }), { ok: true });
  assert.match(request.url, /\/auth\/v1\/user$/);
  assert.equal(request.options.headers.Authorization, "Bearer recovery-access");
  assert.deepEqual(JSON.parse(request.options.body), { password: "new-secret12" });
});

test("translates Supabase duplicate registration errors", async (t) => {
  withSupabaseMock(t, async () => new Response(JSON.stringify({ message: "User already registered" }), {
    status: 422,
    headers: { "Content-Type": "application/json" },
  }));
  const response = { setHeader() {} };

  await assert.rejects(
    cloud.signUp({ headers: {} }, response, { email: "hero@example.com", password: "secret12" }),
    (error) => error.status === 409 && error.message === "该邮箱已注册，请直接登录",
  );
});
