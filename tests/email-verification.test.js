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

test("accepts exactly six numeric characters as an email verification code", () => {
  assert.equal(cloud._test.cleanEmailOtp(" 123456 "), "123456");
  assert.throws(() => cloud._test.cleanEmailOtp("12345"), (error) => error.status === 400);
  assert.throws(() => cloud._test.cleanEmailOtp("12A456"), (error) => error.status === 400);
});

test("verifies a signup OTP and creates HttpOnly session cookies", async (t) => {
  let request;
  withSupabaseMock(t, async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({
      access_token: "verified-access",
      refresh_token: "verified-refresh",
      expires_in: 3600,
      user: { id: "user-verified", email: "hero@example.com" },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const headers = {};
  const response = { setHeader(name, value) { headers[name] = value; } };

  const result = await cloud.verifyEmailOtp(
    { headers: {} },
    response,
    { email: "Hero@example.com", token: "123456" },
  );

  assert.equal(result.signedIn, true);
  assert.equal(result.user.email, "hero@example.com");
  assert.match(request.url, /\/auth\/v1\/verify$/);
  assert.deepEqual(JSON.parse(request.options.body), { type: "email", email: "hero@example.com", token: "123456" });
  assert.equal(headers["Set-Cookie"].length, 2);
  assert.match(headers["Set-Cookie"][0], /HttpOnly/);
});

test("resends a signup confirmation as an email OTP", async (t) => {
  let request;
  withSupabaseMock(t, async (url, options) => {
    request = { url, options };
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  });

  assert.deepEqual(await cloud.resendSignupOtp({ email: "hero@example.com" }), { ok: true });
  assert.match(request.url, /\/auth\/v1\/resend$/);
  assert.deepEqual(JSON.parse(request.options.body), { type: "signup", email: "hero@example.com" });
});
