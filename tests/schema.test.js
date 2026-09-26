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

test("study teams use invite codes, one-team membership, and security-definer access", () => {
  assert.match(schema, /create table if not exists public\.study_teams/i);
  assert.match(schema, /invite_code\s+text\s+not null\s+unique/i);
  assert.match(schema, /create table if not exists public\.study_team_members[\s\S]*unique\s*\(user_id\)/i);
  assert.match(schema, /create or replace function public\.create_study_team[\s\S]*security definer/i);
  assert.match(schema, /create or replace function public\.join_study_team[\s\S]*TEAM_FULL/i);
  assert.match(schema, /create or replace function public\.leave_study_team[\s\S]*v_next_owner/i);
});

test("teammate check-ins require both users to belong to the same team", () => {
  assert.match(schema, /create or replace function public\.get_study_team_checkins/i);
  assert.match(schema, /v_own_team\s+is null[\s\S]*v_own_team\s*<>\s*v_target_team[\s\S]*TEAM_ACCESS_DENIED/i);
  assert.match(schema, /grant execute on function public\.get_study_team_checkins\(uuid, integer\) to authenticated/i);
});
