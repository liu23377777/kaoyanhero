const test = require("node:test");
const assert = require("node:assert/strict");

process.env.APP_ENCRYPTION_KEY = "test-only-encryption-key-at-least-32-characters";
process.env.ADMIN_PASSWORD = "test-only-admin-password";
const cloud = require("../cloud");

test("normalizes current and legacy account review states", () => {
  assert.deepEqual(
    cloud._test.approvalView({
      approval_status: "rejected",
      approval_comment: "  请使用常用邮箱重新申请  ",
      reviewed_at: "2026-09-26T01:00:00.000Z",
    }),
    {
      status: "rejected",
      comment: "请使用常用邮箱重新申请",
      reviewedAt: "2026-09-26T01:00:00.000Z",
      approved: false,
    },
  );

  assert.equal(cloud._test.approvalView({ approved: true }).status, "approved");
  assert.equal(cloud._test.approvalView({ approved: false }).status, "pending");
  assert.equal(cloud._test.approvalView({}).status, "pending");
});

test("requires a review comment for both approval outcomes", () => {
  assert.deepEqual(
    cloud._test.cleanReviewDecision({ status: "approved", comment: "  坚持打卡，准予通过。  " }),
    { status: "approved", comment: "坚持打卡，准予通过。" },
  );
  assert.deepEqual(
    cloud._test.cleanReviewDecision({ status: "rejected", comment: "邮箱信息不完整" }),
    { status: "rejected", comment: "邮箱信息不完整" },
  );
  assert.throws(
    () => cloud._test.cleanReviewDecision({ status: "approved", comment: "" }),
    (error) => error.status === 400 && /评语/.test(error.message),
  );
  assert.throws(
    () => cloud._test.cleanReviewDecision({ status: "pending", comment: "稍后处理" }),
    (error) => error.status === 400,
  );
});

test("detects an older profiles schema without review columns", () => {
  const missingColumn = Object.assign(new Error("Could not find the 'approval_status' column"), { upstream: true });
  assert.equal(cloud._test.missingApprovalSchema(missingColumn), true);
  assert.equal(cloud._test.missingApprovalSchema(new Error("network failed")), false);
});

test("admin review persists the status, comment, and review time", async (t) => {
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
    request = { url, options };
    return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
  };
  t.after(() => {
    global.fetch = previous.fetch;
    if (previous.url === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = previous.url;
    if (previous.anon === undefined) delete process.env.SUPABASE_ANON_KEY; else process.env.SUPABASE_ANON_KEY = previous.anon;
    if (previous.service === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = previous.service;
  });

  await cloud.adminReviewUser(
    "11111111-1111-4111-8111-111111111111",
    { status: "rejected", comment: "  资料需要补充  " },
  );

  assert.match(request.url, /\/rest\/v1\/profiles\?id=eq\.11111111-1111-4111-8111-111111111111$/);
  assert.equal(request.options.method, "PATCH");
  const body = JSON.parse(request.options.body);
  assert.equal(body.approval_status, "rejected");
  assert.equal(body.approval_comment, "资料需要补充");
  assert.match(body.reviewed_at, /^\d{4}-\d{2}-\d{2}T/);
});
