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
  assert.match(html, /id="adminRewardRequiresReview"/);
  assert.match(html, /data-admin-tab="redemptions"/);
  assert.match(html, /id="adminRedemptions"/);
  assert.match(html, /id="adminRedemptionModal"/);
  assert.match(html, /\/api\/admin\/reward-redemptions/);
  assert.match(html, /留空时系统会自动记录默认说明/);
  assert.doesNotMatch(html, /拒绝兑换时请填写原因/);
});

test("history rows can reopen complete AI evaluations and show same-day times", () => {
  assert.match(html, /data-history-id=/);
  assert.match(html, /historyList\.addEventListener\("click"/);
  assert.match(html, /formatCloudDateTime/);
  assert.match(html, /showHistoricalReview/);
});

test("signed-in members have a profile editor and admins can keep private notes", () => {
  assert.match(html, /id="profileModal"/);
  assert.match(html, /class="profile-page"/);
  assert.match(html, /body\.profile-open\s*>\s*\.shell/);
  assert.match(html, /history\.pushState\([^)]*#profile/);
  assert.match(html, /location\.hash\s*===\s*"#profile"/);
  assert.doesNotMatch(html, /id="profileModal"[^>]*aria-modal="true"/);
  assert.match(html, /profile-story-line">让你的每一次坚持，<\/span><span class="profile-story-line">都有一个名字。/);
  assert.match(html, /id="profileDisplayName"/);
  assert.match(html, /用户昵称用于全站展示，队内昵称仍可单独设置/);
  assert.match(html, /\/api\/user\/profile/);
  assert.match(html, /id="adminNoteModal"/);
  assert.match(html, /\/api\/admin\/users\/[^`]+\/note/);
  assert.match(html, /仅管理员可见/);
});
