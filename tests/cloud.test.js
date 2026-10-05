const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

process.env.APP_ENCRYPTION_KEY = "test-only-encryption-key-at-least-32-characters";
process.env.ADMIN_PASSWORD = "test-only-admin-password";
const cloud = require("../cloud");

test("encrypts and decrypts user secrets", () => {
  const encrypted = cloud._test.encryptSecret("habitica-token-value");
  assert.notEqual(encrypted, "habitica-token-value");
  assert.equal(cloud._test.decryptSecret(encrypted), "habitica-token-value");
});

test("rejects tampered encrypted secrets", () => {
  const encrypted = cloud._test.encryptSecret("habitica-token-value");
  const parts = encrypted.split(".");
  parts[2] = `${parts[2][0] === "a" ? "b" : "a"}${parts[2].slice(1)}`;
  const tampered = parts.join(".");
  assert.throws(() => cloud._test.decryptSecret(tampered));
});

test("parses encoded cookies", () => {
  const cookies = cloud._test.parseCookies({ headers: { cookie: "kh_access=abc%20123; kh_refresh=xyz" } });
  assert.deepEqual(cookies, { kh_access: "abc 123", kh_refresh: "xyz" });
});

test("creates HttpOnly cookies and restores a Supabase session", async (t) => {
  const mock = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url.startsWith("/auth/v1/token")) {
      res.end(JSON.stringify({
        access_token: "mock-access",
        refresh_token: "mock-refresh",
        expires_in: 3600,
        user: { id: "user-1", email: "hero@example.com" },
      }));
      return;
    }
    if (req.url === "/auth/v1/user" && req.headers.authorization === "Bearer mock-access") {
      res.end(JSON.stringify({ id: "user-1", email: "hero@example.com" }));
      return;
    }
    res.statusCode = 401;
    res.end(JSON.stringify({ message: "unauthorized" }));
  });
  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
  t.after(() => mock.close());
  const previousUrl = process.env.SUPABASE_URL;
  const previousKey = process.env.SUPABASE_ANON_KEY;
  process.env.SUPABASE_URL = `http://127.0.0.1:${mock.address().port}`;
  process.env.SUPABASE_ANON_KEY = "mock-anon";
  t.after(() => {
    if (previousUrl === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.SUPABASE_ANON_KEY; else process.env.SUPABASE_ANON_KEY = previousKey;
  });

  const responseHeaders = {};
  const fakeResponse = { setHeader(name, value) { responseHeaders[name] = value; } };
  const login = await cloud.signIn({ headers: {} }, fakeResponse, { email: "hero@example.com", password: "123456" });
  assert.equal(login.user.email, "hero@example.com");
  assert.equal(responseHeaders["Set-Cookie"].length, 2);
  assert.match(responseHeaders["Set-Cookie"][0], /HttpOnly/);
  const cookie = responseHeaders["Set-Cookie"].map((line) => line.split(";")[0]).join("; ");
  const session = await cloud.sessionFromRequest({ headers: { cookie } }, fakeResponse);
  assert.equal(session.user.id, "user-1");
});

test("turns an unreachable Supabase project into a clear service error", async (t) => {
  const previous = {
    url: process.env.SUPABASE_URL,
    anon: process.env.SUPABASE_ANON_KEY,
    fetch: global.fetch,
  };
  process.env.SUPABASE_URL = "https://missing-project.supabase.co";
  process.env.SUPABASE_ANON_KEY = "test-anon-key";
  global.fetch = async () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    throw Object.assign(new TypeError("fetch failed"), { cause });
  };
  t.after(() => {
    global.fetch = previous.fetch;
    if (previous.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previous.url;
    if (previous.anon === undefined) delete process.env.SUPABASE_ANON_KEY; else process.env.SUPABASE_ANON_KEY = previous.anon;
  });

  await assert.rejects(
    () => cloud.signIn({ headers: {} }, { setHeader() {} }, { email: "hero@example.com", password: "123456" }),
    (error) => error.status === 503 && /Supabase.*项目地址/.test(error.message),
  );
});

test("rejects admin login with a wrong password", async () => {
  const fakeResponse = { setHeader() {} };
  await assert.rejects(
    () => cloud.adminLogin({ headers: {} }, fakeResponse, { password: "wrong-password" }),
    (error) => error.status === 401,
  );
});

test("accepts a correct admin password and issues a verifiable session cookie", async () => {
  const responseHeaders = {};
  const fakeResponse = { setHeader(name, value) { responseHeaders[name] = value; } };
  const result = await cloud.adminLogin({ headers: {} }, fakeResponse, { password: "test-only-admin-password" });
  assert.equal(result.ok, true);
  const setCookie = responseHeaders["Set-Cookie"];
  assert.match(setCookie, /kh_admin=/);
  assert.match(setCookie, /HttpOnly/);
  const cookieValue = setCookie.split(";")[0];
  const adminReq = { headers: { cookie: cookieValue } };
  assert.equal(cloud.isAdminRequest(adminReq), true);
  assert.doesNotThrow(() => cloud.requireAdmin(adminReq));
});

test("rejects a tampered or missing admin session cookie", () => {
  assert.equal(cloud.isAdminRequest({ headers: {} }), false);
  assert.equal(cloud.isAdminRequest({ headers: { cookie: "kh_admin=1234567890.deadbeef" } }), false);
  assert.throws(() => cloud.requireAdmin({ headers: {} }), (error) => error.status === 401);
});

test("user state keeps complete AI reviews so every historical check-in can be reopened", async (t) => {
  const previous = {
    url: process.env.SUPABASE_URL,
    anon: process.env.SUPABASE_ANON_KEY,
    fetch: global.fetch,
  };
  process.env.SUPABASE_URL = "https://project-ref.supabase.co";
  process.env.SUPABASE_ANON_KEY = "test-anon-key";
  const requestedUrls = [];
  global.fetch = async (url) => {
    requestedUrls.push(String(url));
    let data = [];
    if (String(url).includes("/profiles?")) {
      data = [{ id: "user-1", xp: 200, coin: 30, streak: 2, approval_status: "approved" }];
    } else if (String(url).includes("/checkins?")) {
      data = [{
        id: "checkin-1", study_text: "数学真题复盘", topics: ["数学"], photo_count: 2,
        score: 88, title: "真题推进", review: { score: 88, summary: "完成充分", highlights: [], suggestions: [], detectedEvidence: [] },
        provider: "智谱 GLM", model: "glm-4.6v-flash", xp: 120, coin: 28, created_at: "2026-09-26T08:30:00Z",
      }];
    }
    return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  t.after(() => {
    global.fetch = previous.fetch;
    if (previous.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previous.url;
    if (previous.anon === undefined) delete process.env.SUPABASE_ANON_KEY; else process.env.SUPABASE_ANON_KEY = previous.anon;
  });

  const state = await cloud.getUserState({ user: { id: "user-1" }, accessToken: "signed-user-token" });
  assert.deepEqual(state.history[0].review.summary, "完成充分");
  assert.equal(state.history[0].studyText, "数学真题复盘");
  assert.equal(state.history[0].coin, 28);
  assert.equal(state.history[0].model, "glm-4.6v-flash");
  assert.ok(requestedUrls.some((url) => url.includes("review") && url.includes("coin") && url.includes("model")));
});
