const test = require("node:test");
const assert = require("node:assert/strict");

process.env.APP_ENCRYPTION_KEY = "test-only-encryption-key-at-least-32-characters";
process.env.ADMIN_PASSWORD = "test-only-admin-password";
const { calculateRewards } = require("../server");

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

