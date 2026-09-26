const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

test("registration UI includes inline email verification and password confirmation", () => {
  assert.match(html, /id="authEmailCode"/);
  assert.match(html, /id="sendEmailCode"/);
  assert.match(html, /id="authConfirmPassword"/);
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
