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
  assert.match(schema, /extensions\.gen_random_bytes\(8\)/i);
  assert.match(schema, /create or replace function public\.join_study_team[\s\S]*TEAM_FULL/i);
  assert.match(schema, /create or replace function public\.leave_study_team[\s\S]*v_next_owner/i);
});

test("teammate check-ins require both users to belong to the same team", () => {
  assert.match(schema, /create or replace function public\.get_study_team_checkins/i);
  assert.match(schema, /v_own_team\s+is null[\s\S]*v_own_team\s*<>\s*v_target_team[\s\S]*TEAM_ACCESS_DENIED/i);
  assert.match(schema, /grant execute on function public\.get_study_team_checkins\(uuid, integer\) to authenticated/i);
});

test("reward catalog supports audiences, groups, per-user limits, and atomic redemption", () => {
  assert.match(schema, /create table if not exists public\.reward_catalog/i);
  assert.match(schema, /per_user_limit\s+integer\s+not null\s+default\s+1/i);
  assert.match(schema, /audience_mode[\s\S]*'all'[\s\S]*'users'[\s\S]*'group'/i);
  assert.match(schema, /create table if not exists public\.reward_groups/i);
  assert.match(schema, /create table if not exists public\.reward_group_members/i);
  assert.match(schema, /create table if not exists public\.reward_redemptions/i);
  assert.match(schema, /create or replace function public\.get_available_rewards/i);
  assert.match(schema, /create or replace function public\.redeem_reward[\s\S]*for update/i);
  assert.match(schema, /REWARD_LIMIT_REACHED/i);
  assert.match(schema, /INSUFFICIENT_COINS/i);
});

test("reward redemptions support optional approval with atomic refund on rejection", () => {
  assert.match(schema, /requires_review\s+boolean\s+not null\s+default\s+false/i);
  assert.match(schema, /status[\s\S]*'pending'[\s\S]*'fulfilled'[\s\S]*'rejected'/i);
  assert.match(schema, /review_note\s+text/i);
  assert.match(schema, /create or replace function public\.review_reward_redemption/i);
  assert.match(schema, /review_reward_redemption[\s\S]*for update/i);
  assert.match(schema, /管理员审核通过/i);
  assert.match(schema, /管理员审核未通过，兑换金币已退还/i);
  assert.doesNotMatch(schema, /REJECTION_NOTE_REQUIRED/i);
  assert.match(schema, /p_status\s*=\s*'rejected'[\s\S]*set coin = coin \+ v_redemption\.coin_cost/i);
  assert.match(schema, /grant execute on function public\.review_reward_redemption[\s\S]*to service_role/i);
});

test("check-in rewards can only be written by the trusted service role and are capped", () => {
  assert.match(schema, /create or replace function public\.record_checkin_server/i);
  assert.match(schema, /auth\.role\(\)[\s\S]*service_role/i);
  assert.match(schema, /p_xp\s*>\s*220[\s\S]*p_coin\s*>\s*50/i);
  assert.match(schema, /revoke all on function public\.record_checkin\([\s\S]*from authenticated/i);
  assert.match(schema, /grant execute on function public\.record_checkin_server\([\s\S]*to service_role/i);
});
