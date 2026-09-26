const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const schema = fs.readFileSync(path.join(__dirname, "..", "supabase-schema.sql"), "utf8");

test("profiles use a three-state review with pending as the default", () => {
  assert.match(schema, /approval_status\s+text[\s\S]*default\s+'pending'/i);
  assert.match(schema, /approval_comment\s+text/i);
  assert.match(schema, /reviewed_at\s+timestamptz/i);
  assert.match(schema, /approval_status[\s\S]*in\s*\(\s*'pending'\s*,\s*'approved'\s*,\s*'rejected'\s*\)/i);
});

test("database functions reject check-ins until an account is approved", () => {
  assert.match(schema, /create or replace function public\.record_checkin[\s\S]*ACCOUNT_PENDING_APPROVAL/i);
  assert.match(schema, /create or replace function public\.record_checkin[\s\S]*ACCOUNT_REJECTED/i);
  assert.match(schema, /create or replace function public\.consume_ai_quota[\s\S]*ACCOUNT_PENDING_APPROVAL/i);
});
