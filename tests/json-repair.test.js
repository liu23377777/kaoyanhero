const test = require("node:test");
const assert = require("node:assert/strict");
const { safeJsonFromModel } = require("../server");

function reviewJson(highlights) {
  return `{
    "score": 82,
    "title": "复盘扎实",
    "summary": "完成了今天的学习任务。",
    "discoveredTopics": ["定积分"],
    "topicReviews": [],
    "highlights": ${highlights},
    "suggestions": ["整理错题"],
    "nextGoal": "完成一道综合题",
    "credibility": "high",
    "detectedEvidence": ["学习记录"]
  }`;
}

test("parses valid model JSON", () => {
  const review = safeJsonFromModel(reviewJson('["目标明确", "完成复盘"]'));
  assert.equal(review.score, 82);
  assert.deepEqual(review.highlights, ["目标明确", "完成复盘"]);
});

test("repairs a missing comma between array elements", () => {
  const review = safeJsonFromModel(reviewJson('["目标明确" "完成复盘"]'));
  assert.deepEqual(review.highlights, ["目标明确", "完成复盘"]);
});

test("repairs trailing commas", () => {
  const review = safeJsonFromModel(reviewJson('["目标明确", "完成复盘",]'));
  assert.deepEqual(review.highlights, ["目标明确", "完成复盘"]);
});
