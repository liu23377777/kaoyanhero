const test = require("node:test");
const assert = require("node:assert/strict");

process.env.APP_ENCRYPTION_KEY = "test-only-encryption-key-at-least-32-characters";
process.env.ADMIN_PASSWORD = "test-only-admin-password";
const { calculateRewards } = require("../server");
const cloud = require("../cloud");

test("workload-aware rewards separate a brief check-in from substantial work", () => {
  const brief = calculateRewards({
    text: "背了单词。",
    photoCount: 0,
    score: 65,
    selectedTopics: ["英语"],
    review: { credibility: "low", detectedEvidence: [] },
  });
  const substantial = calculateRewards({
    text: "数学复习3小时，完成两套真题共80题，订正12道错题并整理了8页错题本，还复盘了极限和导数的薄弱点。",
    photoCount: 4,
    score: 86,
    selectedTopics: ["数学", "真题", "错题复盘"],
    review: { credibility: "high", detectedEvidence: ["4张练习照片", "80题完成记录", "12道错题订正"] },
  });

  assert.ok(substantial.xp >= brief.xp + 50, `${brief.xp} -> ${substantial.xp}`);
  assert.ok(substantial.coin >= brief.coin + 10, `${brief.coin} -> ${substantial.coin}`);
  assert.ok(Array.isArray(substantial.basis));
  assert.ok(substantial.basis.some((item) => /工作量|凭证|主题/.test(item)));
});

test("workload-aware rewards stay inside safe caps", () => {
  const reward = calculateRewards({
    text: `${"完成1000题并学习24小时。".repeat(500)}`,
    photoCount: 99,
    score: 100,
    selectedTopics: Array.from({ length: 30 }, (_, index) => `主题${index}`),
    review: { credibility: "high", detectedEvidence: Array(50).fill("证据") },
  });
  assert.ok(reward.xp <= 220);
  assert.ok(reward.coin <= 50);
});

test("reward approval only accepts final states and supplies default notes", () => {
  assert.deepEqual(
    cloud._test.cleanRewardReviewDecision({ status: "fulfilled", note: "  已通过并安排发放  " }),
    { status: "fulfilled", note: "已通过并安排发放" },
  );
  assert.deepEqual(
    cloud._test.cleanRewardReviewDecision({ status: "rejected", note: "  收款信息不完整  " }),
    { status: "rejected", note: "收款信息不完整" },
  );
  assert.throws(
    () => cloud._test.cleanRewardReviewDecision({ status: "pending", note: "稍后处理" }),
    (error) => error.status === 400,
  );
  assert.deepEqual(
    cloud._test.cleanRewardReviewDecision({ status: "fulfilled", note: "" }),
    { status: "fulfilled", note: "管理员审核通过" },
  );
  assert.deepEqual(
    cloud._test.cleanRewardReviewDecision({ status: "rejected", note: "" }),
    { status: "rejected", note: "管理员审核未通过，兑换金币已退还" },
  );
});

test("admin reward approval uses the service-role RPC for an atomic decision", async (t) => {
  const previous = {
    url: process.env.SUPABASE_URL,
    anon: process.env.SUPABASE_ANON_KEY,
    service: process.env.SUPABASE_SERVICE_ROLE_KEY,
    fetch: global.fetch,
  };
  process.env.SUPABASE_URL = "https://project-ref.supabase.co";
  process.env.SUPABASE_ANON_KEY = "test-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  let request;
  global.fetch = async (url, options) => {
    request = { url: String(url), options };
    return new Response(JSON.stringify({ id: "33333333-3333-4333-8333-333333333333", status: "rejected", refundedCoin: 50 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  t.after(() => {
    global.fetch = previous.fetch;
    if (previous.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previous.url;
    if (previous.anon === undefined) delete process.env.SUPABASE_ANON_KEY; else process.env.SUPABASE_ANON_KEY = previous.anon;
    if (previous.service === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = previous.service;
  });

  await cloud.adminReviewRewardRedemption(
    "33333333-3333-4333-8333-333333333333",
    { status: "rejected", note: "信息不完整" },
  );

  assert.match(request.url, /\/rest\/v1\/rpc\/review_reward_redemption$/);
  assert.equal(request.options.headers.Authorization, "Bearer test-service-role-key");
  assert.deepEqual(JSON.parse(request.options.body), {
    p_redemption_id: "33333333-3333-4333-8333-333333333333",
    p_status: "rejected",
    p_note: "信息不完整",
  });
});

test("admin redemption records include the member's private note", async (t) => {
  const previous = {
    url: process.env.SUPABASE_URL,
    anon: process.env.SUPABASE_ANON_KEY,
    service: process.env.SUPABASE_SERVICE_ROLE_KEY,
    fetch: global.fetch,
  };
  process.env.SUPABASE_URL = "https://project-ref.supabase.co";
  process.env.SUPABASE_ANON_KEY = "test-anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  const requested = [];
  global.fetch = async (url) => {
    const requestUrl = String(url);
    requested.push(requestUrl);
    let body = [];
    if (requestUrl.includes("/rest/v1/reward_redemptions")) body = [{
      id: "33333333-3333-4333-8333-333333333333",
      reward_id: "44444444-4444-4444-8444-444444444444",
      user_id: "11111111-1111-4111-8111-111111111111",
      coin_cost: 3,
      status: "pending",
      review_note: "",
      reviewed_at: null,
      created_at: "2026-09-27T01:37:00.000Z",
    }];
    else if (requestUrl.includes("/rest/v1/reward_catalog")) body = [{
      id: "44444444-4444-4444-8444-444444444444",
      title: "新手奖励",
      description: "",
      requires_review: true,
    }];
    else if (requestUrl.includes("/auth/v1/admin/users")) body = {
      users: [{ id: "11111111-1111-4111-8111-111111111111", email: "1941173209@qq.com" }],
    };
    else if (requestUrl.includes("/rest/v1/admin_user_notes")) body = [{
      user_id: "11111111-1111-4111-8111-111111111111",
      note: "哈哈哈",
    }];
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  t.after(() => {
    global.fetch = previous.fetch;
    if (previous.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previous.url;
    if (previous.anon === undefined) delete process.env.SUPABASE_ANON_KEY; else process.env.SUPABASE_ANON_KEY = previous.anon;
    if (previous.service === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = previous.service;
  });

  const records = await cloud.adminListRewardRedemptions();

  assert.equal(records[0].email, "1941173209@qq.com");
  assert.equal(records[0].adminNote, "哈哈哈");
  assert.ok(requested.some((url) => url.includes("/rest/v1/admin_user_notes")));
});
