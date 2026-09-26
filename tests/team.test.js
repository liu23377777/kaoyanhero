const test = require("node:test");
const assert = require("node:assert/strict");

process.env.APP_ENCRYPTION_KEY = "test-only-encryption-key-at-least-32-characters";
process.env.ADMIN_PASSWORD = "test-only-admin-password";
const cloud = require("../cloud");

test("normalizes and validates team input", () => {
  assert.equal(cloud._test.cleanTeamText("  冲刺小队  ", "队伍名称", 30), "冲刺小队");
  assert.equal(cloud._test.cleanInviteCode(" a1b2c3d4 "), "A1B2C3D4");
  assert.throws(() => cloud._test.cleanTeamText("", "队伍名称", 30), (error) => error.status === 400);
  assert.throws(() => cloud._test.cleanInviteCode("ABC"), (error) => error.status === 400);
});

test("turns database team errors into clear API errors", () => {
  const notFound = cloud._test.translateTeamError(new Error("TEAM_NOT_FOUND"));
  assert.equal(notFound.status, 404);
  assert.match(notFound.message, /邀请码/);

  const denied = cloud._test.translateTeamError(new Error("TEAM_ACCESS_DENIED"));
  assert.equal(denied.status, 403);
  assert.match(denied.message, /权限/);
});

test("calls team RPCs with the signed-in user's access token", async (t) => {
  const previous = {
    url: process.env.SUPABASE_URL,
    anon: process.env.SUPABASE_ANON_KEY,
    fetch: global.fetch,
  };
  process.env.SUPABASE_URL = "https://project-ref.supabase.co";
  process.env.SUPABASE_ANON_KEY = "test-anon-key";
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ id: "team-1", name: "冲刺小队" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  t.after(() => {
    global.fetch = previous.fetch;
    if (previous.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previous.url;
    if (previous.anon === undefined) delete process.env.SUPABASE_ANON_KEY; else process.env.SUPABASE_ANON_KEY = previous.anon;
  });

  await cloud.createStudyTeam(
    { user: { id: "user-1" }, accessToken: "signed-user-token" },
    { name: "冲刺小队", nickname: "小刘" },
  );

  assert.match(requests[0].url, /\/rest\/v1\/rpc\/create_study_team$/);
  assert.equal(requests[0].options.headers.Authorization, "Bearer signed-user-token");
  assert.deepEqual(JSON.parse(requests[0].options.body), { p_name: "冲刺小队", p_nickname: "小刘" });
});
