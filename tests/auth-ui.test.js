const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

test("registration uses direct email and password without an inline verification code", () => {
  assert.doesNotMatch(html, /id="authEmailCode"/);
  assert.doesNotMatch(html, /id="sendEmailCode"/);
  assert.match(html, /id="authConfirmPassword"/);
  assert.match(html, /id="authConfirmPassword"[^>]*autocomplete="off"[^>]*data-manual-confirm/);
  assert.match(html, /placeholder="请输入邮箱"/);
  assert.match(html, /placeholder="请输入密码"/);
  assert.match(html, /placeholder="请再次输入密码"/);
});

test("authentication UI provides distinct login and registration headings", () => {
  assert.match(html, /欢迎回来/);
  assert.match(html, /创建账户/);
  assert.match(html, /已有账户/);
  assert.match(html, /还没有账户/);
});

test("authentication is a full page with correctly anchored input icons", () => {
  assert.match(html, /class="auth-page"/);
  assert.doesNotMatch(html, /aria-modal="true" aria-labelledby="authTitle"/);
  assert.match(html, /\.auth-input-shell\s*\{[^}]*display:\s*block;/s);
  assert.match(html, /overscroll-behavior-x:\s*none/);
});

test("social login is limited to the login mode and disabled providers start hidden", () => {
  assert.match(html, /id="authSocial"[^>]*data-auth-only="login"/);
  assert.match(html, /data-social="Google" hidden/);
  assert.match(html, /data-social="GitHub" hidden/);
});

test("password recovery has request and new-password modes", () => {
  assert.match(html, /data-auth-copy="forgot"/);
  assert.match(html, /data-auth-copy="reset"/);
  assert.match(html, /\/api\/auth\/password\/reset-request/);
  assert.match(html, /\/api\/auth\/password\/update/);
});

test("rewards have a member redemption view and admin publishing and grouping views", () => {
  assert.match(html, /id="rewardButton"/);
  assert.match(html, /id="rewardModal"/);
  assert.match(html, /id="adminRewardForm"/);
  assert.match(html, /id="adminGroupForm"/);
  assert.match(html, /\/api\/rewards/);
  assert.match(html, /\/api\/admin\/rewards/);
  assert.match(html, /\/api\/admin\/reward-groups/);
});

test("history rows can reopen complete AI evaluations and show same-day times", () => {
  assert.match(html, /data-history-id=/);
  assert.match(html, /historyList\.addEventListener\("click"/);
  assert.match(html, /formatCloudDateTime/);
  assert.match(html, /showHistoricalReview/);
});
