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

test("reward approval only accepts final states and requires a note when rejected", () => {
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
  assert.throws(
    () => cloud._test.cleanRewardReviewDecision({ status: "rejected", note: "" }),
    (error) => error.status === 400 && /原因/.test(error.message),
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
