const crypto = require("node:crypto");

const ACCESS_COOKIE = "kh_access";
const REFRESH_COOKIE = "kh_refresh";
const ADMIN_COOKIE = "kh_admin";
const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;

function configured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);
}

function dailyLimit() {
  const value = Number(process.env.DAILY_AI_REQUEST_LIMIT || 10);
  return Number.isFinite(value) ? Math.max(1, Math.min(1000, Math.round(value))) : 10;
}

function publicConfig() {
  return {
    cloudMode: configured(),
    googleAuth: configured() && process.env.ENABLE_GOOGLE_AUTH === "true",
    githubAuth: configured() && process.env.ENABLE_GITHUB_AUTH === "true",
    dailyAiRequestLimit: dailyLimit(),
  };
}

function supabaseBase() {
  if (!configured()) throw Object.assign(new Error("Supabase 尚未配置"), { status: 503 });
  return process.env.SUPABASE_URL.replace(/\/$/, "");
}

async function supabaseRequest(apiPath, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 15_000);
  const anonKey = process.env.SUPABASE_ANON_KEY;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (options.useServiceRole && !serviceKey) {
    throw Object.assign(new Error("SUPABASE_SERVICE_ROLE_KEY 尚未配置"), { status: 503 });
  }
  const authKey = options.useServiceRole ? serviceKey : (options.accessToken || anonKey);
  const headers = {
    apikey: options.useServiceRole ? serviceKey : anonKey,
    Authorization: `Bearer ${authKey}`,
    ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...(options.prefer ? { Prefer: options.prefer } : {}),
    ...options.headers,
  };
  try {
    const response = await fetch(`${supabaseBase()}${apiPath}`, {
      method: options.method || "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const raw = await response.text();
    let data = null;
    if (raw) {
      try { data = JSON.parse(raw); } catch { data = raw; }
    }
    if (!response.ok) {
      const message = data?.msg || data?.message || data?.error_description || data?.error || `Supabase 返回 ${response.status}`;
      throw Object.assign(new Error(String(message)), { status: response.status, upstream: true });
    }
    return { data, response };
  } catch (error) {
    if (error.name === "AbortError") throw Object.assign(new Error("云端服务连接超时"), { status: 504 });
    const networkCode = error?.cause?.code || error?.code;
    if (["ENOTFOUND", "EAI_AGAIN"].includes(networkCode)) {
      throw Object.assign(new Error("Supabase 项目地址无法访问，请联系管理员检查 SUPABASE_URL 或项目状态"), {
        status: 503,
        code: "SUPABASE_ADDRESS_UNREACHABLE",
      });
    }
    if (error instanceof TypeError && error.message === "fetch failed") {
      throw Object.assign(new Error("云端账户服务连接失败，请稍后重试或联系管理员"), {
        status: 502,
        code: "SUPABASE_CONNECTION_FAILED",
      });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function parseCookies(req) {
  const result = {};
  for (const pair of String(req.headers.cookie || "").split(";")) {
    const divider = pair.indexOf("=");
    if (divider < 1) continue;
    const key = pair.slice(0, divider).trim();
    try { result[key] = decodeURIComponent(pair.slice(divider + 1).trim()); } catch { result[key] = ""; }
  }
  return result;
}

function secureRequest(req) {
  return String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim() === "https"
    || String(process.env.PUBLIC_APP_URL || "").startsWith("https://");
}

function cookieLine(req, name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureRequest(req) ? "; Secure" : ""}`;
}

function setSessionCookies(req, res, session) {
  const accessMaxAge = Math.max(60, Number(session.expires_in || 3600));
  res.setHeader("Set-Cookie", [
    cookieLine(req, ACCESS_COOKIE, session.access_token, accessMaxAge),
    cookieLine(req, REFRESH_COOKIE, session.refresh_token, 60 * 60 * 24 * 30),
  ]);
}

function clearSessionCookies(req, res) {
  res.setHeader("Set-Cookie", [
    cookieLine(req, ACCESS_COOKIE, "", 0),
    cookieLine(req, REFRESH_COOKIE, "", 0),
  ]);
}

function cleanEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    throw Object.assign(new Error("请输入有效邮箱"), { status: 400 });
  }
  return email;
}

function cleanPassword(value) {
  const password = String(value || "");
  if (password.length < 6 || password.length > 128) {
    throw Object.assign(new Error("密码长度应为 6 到 128 位"), { status: 400 });
  }
  return password;
}

const APPROVAL_STATUSES = new Set(["pending", "approved", "rejected"]);

function approvalView(profile = {}) {
  const storedStatus = String(profile.approval_status || "").trim();
  const status = APPROVAL_STATUSES.has(storedStatus)
    ? storedStatus
    : (profile.approved === true ? "approved" : "pending");
  return {
    status,
    comment: String(profile.approval_comment || "").trim(),
    reviewedAt: profile.reviewed_at || null,
    approved: status === "approved",
  };
}

function cleanReviewDecision(payload) {
  const status = String(payload?.status || "").trim();
  const comment = String(payload?.comment || "").trim();
  if (!["approved", "rejected"].includes(status)) {
    throw Object.assign(new Error("审核结果必须是通过或未通过"), { status: 400 });
  }
  if (!comment) throw Object.assign(new Error("请填写审核评语"), { status: 400 });
  if (comment.length > 500) throw Object.assign(new Error("审核评语不能超过 500 字"), { status: 400 });
  return { status, comment };
}

function cleanRewardReviewDecision(payload) {
  const status = String(payload?.status || "").trim();
  if (!["fulfilled", "rejected"].includes(status)) {
    throw Object.assign(new Error("兑换审核结果必须是通过或拒绝"), { status: 400 });
  }
  const note = String(payload?.note || "").trim() || (status === "fulfilled"
    ? "管理员审核通过"
    : "管理员审核未通过，兑换金币已退还");
  if (note.length > 500) throw Object.assign(new Error("审核说明不能超过 500 字"), { status: 400 });
  return { status, note };
}

function cleanDisplayName(value) {
  const name = String(value || "").trim();
  if (name.length < 1 || name.length > 30) {
    throw Object.assign(new Error("用户昵称应为 1 到 30 个字符"), { status: 400 });
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw Object.assign(new Error("用户昵称包含不支持的字符"), { status: 400 });
  }
  return name;
}

function cleanAdminNote(value) {
  const note = String(value || "").trim();
  if (note.length > 100) throw Object.assign(new Error("管理员备注不能超过 100 字"), { status: 400 });
  return note;
}

async function signUp(req, res, payload) {
  const email = cleanEmail(payload?.email);
  const password = cleanPassword(payload?.password);
  let data;
  try {
    ({ data } = await supabaseRequest("/auth/v1/signup", { method: "POST", body: { email, password } }));
  } catch (error) {
    if (/user already registered/i.test(String(error.message || ""))) {
      throw Object.assign(new Error("该邮箱已注册，请直接登录"), { status: 409 });
    }
    throw error;
  }
  if (data?.access_token && data?.refresh_token) setSessionCookies(req, res, data);
  return {
    user: data?.user ? { id: data.user.id, email: data.user.email } : null,
    signedIn: Boolean(data?.access_token),
    needsEmailConfirmation: Boolean(data?.user && !data?.access_token),
  };
}

async function signIn(req, res, payload) {
  const email = cleanEmail(payload?.email);
  const password = cleanPassword(payload?.password);
  let data;
  try {
    ({ data } = await supabaseRequest("/auth/v1/token?grant_type=password", { method: "POST", body: { email, password } }));
  } catch (error) {
    if ([400, 401].includes(error.status)) throw Object.assign(new Error("邮箱或密码不正确，或邮箱尚未验证"), { status: 401 });
    throw error;
  }
  setSessionCookies(req, res, data);
  return { user: { id: data.user.id, email: data.user.email }, signedIn: true };
}

async function requestPasswordReset(payload) {
  const email = cleanEmail(payload?.email);
  const publicUrl = String(process.env.PUBLIC_APP_URL || "").replace(/\/$/, "");
  if (!publicUrl) throw Object.assign(new Error("密码重置功能尚未配置 PUBLIC_APP_URL"), { status: 503 });
  try {
    await supabaseRequest(`/auth/v1/recover?redirect_to=${encodeURIComponent(`${publicUrl}/`)}`, {
      method: "POST",
      body: { email },
    });
  } catch (error) {
    if (error.status === 429) {
      throw Object.assign(new Error("重置邮件发送过于频繁，请稍后再试"), { status: 429 });
    }
    throw error;
  }
  return { ok: true };
}

async function updatePassword(session, payload) {
  const password = cleanPassword(payload?.password);
  await supabaseRequest("/auth/v1/user", {
    method: "PUT",
    accessToken: session.accessToken,
    body: { password },
  });
  return { ok: true };
}

async function acceptOAuthSession(req, res, payload) {
  const accessToken = String(payload?.accessToken || "");
  const refreshToken = String(payload?.refreshToken || "");
  if (!accessToken || !refreshToken) throw Object.assign(new Error("第三方登录信息不完整"), { status: 400 });
  const { data: user } = await supabaseRequest("/auth/v1/user", { accessToken });
  setSessionCookies(req, res, { access_token: accessToken, refresh_token: refreshToken, expires_in: Number(payload?.expiresIn || 3600) });
  return { user: { id: user.id, email: user.email }, signedIn: true };
}

async function sessionFromRequest(req, res) {
  if (!configured()) return null;
  const cookies = parseCookies(req);
  const accessToken = cookies[ACCESS_COOKIE];
  const refreshToken = cookies[REFRESH_COOKIE];
  if (accessToken) {
    try {
      const { data: user } = await supabaseRequest("/auth/v1/user", { accessToken });
      return { user, accessToken };
    } catch (error) {
      if (error.status !== 401) throw error;
    }
  }
  if (!refreshToken) return null;
  try {
    const { data } = await supabaseRequest("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: { refresh_token: refreshToken } });
    setSessionCookies(req, res, data);
    return { user: data.user, accessToken: data.access_token };
  } catch (error) {
    clearSessionCookies(req, res);
    if ([400, 401].includes(error.status)) return null;
    throw error;
  }
}

async function requireSession(req, res) {
  const session = await sessionFromRequest(req, res);
  if (!session) throw Object.assign(new Error("请先登录云端账户"), { status: 401 });
  return session;
}

async function signOut(req, res) {
  const cookies = parseCookies(req);
  if (cookies[ACCESS_COOKIE]) {
    try { await supabaseRequest("/auth/v1/logout", { method: "POST", accessToken: cookies[ACCESS_COOKIE] }); } catch {}
  }
  clearSessionCookies(req, res);
}

function restPath(table, query = "") {
  return `/rest/v1/${table}${query ? `?${query}` : ""}`;
}

function missingApprovalSchema(error) {
  const message = String(error?.message || "").toLowerCase();
  return error?.upstream === true
    && ["approval_status", "approval_comment", "reviewed_at"].some((column) => message.includes(column));
}

function missingProfileIdentitySchema(error) {
  const message = String(error?.message || "").toLowerCase();
  return error?.upstream === true
    && ["display_name", "admin_user_notes", "update_my_profile"].some((column) => message.includes(column));
}

async function requestOwnProfile(userId, accessToken) {
  try {
    return await supabaseRequest(
      restPath("profiles", `id=eq.${userId}&select=id,display_name,xp,coin,streak,last_date,approval_status,approval_comment,reviewed_at`),
      { accessToken },
    );
  } catch (error) {
    if (!missingProfileIdentitySchema(error) && !missingApprovalSchema(error)) throw error;
    try {
      return await supabaseRequest(
        restPath("profiles", `id=eq.${userId}&select=id,xp,coin,streak,last_date,approval_status,approval_comment,reviewed_at`),
        { accessToken },
      );
    } catch (legacyError) {
      if (!missingApprovalSchema(legacyError)) throw legacyError;
      return supabaseRequest(
        restPath("profiles", `id=eq.${userId}&select=id,xp,coin,streak,last_date,approved`),
        { accessToken },
      );
    }
  }
}

async function requestAdminProfiles() {
  try {
    return await supabaseRequest(
      restPath("profiles", "select=id,display_name,xp,coin,streak,approval_status,approval_comment,reviewed_at,created_at&order=created_at.desc&limit=500"),
      { useServiceRole: true },
    );
  } catch (error) {
    if (!missingProfileIdentitySchema(error) && !missingApprovalSchema(error)) throw error;
    try {
      return await supabaseRequest(
        restPath("profiles", "select=id,xp,coin,streak,approval_status,approval_comment,reviewed_at,created_at&order=created_at.desc&limit=500"),
        { useServiceRole: true },
      );
    } catch (legacyError) {
      if (!missingApprovalSchema(legacyError)) throw legacyError;
      return supabaseRequest(
        restPath("profiles", "select=id,xp,coin,streak,approved,created_at&order=created_at.desc&limit=500"),
        { useServiceRole: true },
      );
    }
  }
}

async function requestAdminNotes() {
  try {
    return await supabaseRequest(
      restPath("admin_user_notes", "select=user_id,note&limit=500"),
      { useServiceRole: true },
    );
  } catch (error) {
    if (missingProfileIdentitySchema(error)) return { data: [] };
    throw error;
  }
}

async function getUserState(session) {
  const userId = encodeURIComponent(session.user.id);
  const [profiles, checkins, preferences] = await Promise.all([
    requestOwnProfile(userId, session.accessToken),
    supabaseRequest(restPath("checkins", `user_id=eq.${userId}&select=id,study_text,topics,photo_count,score,title,review,provider,model,xp,coin,created_at&order=created_at.desc&limit=20`), { accessToken: session.accessToken }),
    supabaseRequest(restPath("ai_preferences", `user_id=eq.${userId}&select=provider,reasoning_mode,detail_level,max_tokens,temperature&limit=1`), { accessToken: session.accessToken }),
  ]);
  const profile = profiles.data?.[0] || { xp: 0, coin: 0, streak: 0, last_date: null, approval_status: "pending" };
  const approval = approvalView(profile);
  return {
    profile: {
      displayName: String(profile.display_name || "").trim(),
      xp: Number(profile.xp || 0),
      coin: Number(profile.coin || 0),
      streak: Number(profile.streak || 0),
      lastDate: profile.last_date || "",
      approved: approval.approved,
      approvalStatus: approval.status,
      approvalComment: approval.comment,
      reviewedAt: approval.reviewedAt,
    },
    history: (checkins.data || []).map((item) => ({
      id: item.id,
      studyText: item.study_text || "",
      topics: Array.isArray(item.topics) ? item.topics : [],
      photoCount: Number(item.photo_count || 0),
      score: Number(item.score || 0),
      title: item.title || "学习打卡",
      review: item.review || null,
      provider: item.provider || "AI",
      model: item.model || "",
      xp: Number(item.xp || 0),
      coin: Number(item.coin || 0),
      createdAt: item.created_at,
    })),
    preferences: preferences.data?.[0] || null,
  };
}

async function updateUserProfile(session, payload) {
  const displayName = cleanDisplayName(payload?.displayName);
  try {
    const { data } = await supabaseRequest("/rest/v1/rpc/update_my_profile", {
      method: "POST",
      accessToken: session.accessToken,
      body: { p_display_name: displayName },
    });
    return { displayName: String(data?.displayName || displayName) };
  } catch (error) {
    if (missingProfileIdentitySchema(error)) {
      throw Object.assign(new Error("个人资料字段尚未升级，请先执行最新的 supabase-schema.sql"), { status: 503 });
    }
    throw error;
  }
}

async function savePreferences(session, provider, options) {
  await supabaseRequest(restPath("ai_preferences", "on_conflict=user_id"), {
    method: "POST",
    accessToken: session.accessToken,
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      user_id: session.user.id,
      provider,
      reasoning_mode: options.reasoningMode,
      detail_level: options.detailLevel,
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      updated_at: new Date().toISOString(),
    },
  });
}

async function assertWithinDailyLimit(session) {
  try {
    await supabaseRequest("/rest/v1/rpc/consume_ai_quota", {
      method: "POST",
      accessToken: session.accessToken,
      body: { p_limit: dailyLimit() },
    });
  } catch (error) {
    if (String(error.message).includes("DAILY_AI_LIMIT_REACHED")) {
      throw Object.assign(new Error(`今日 AI 打卡次数已达到上限（${dailyLimit()} 次）`), { status: 429 });
    }
    if (String(error.message).includes("ACCOUNT_PENDING_APPROVAL")) {
      throw Object.assign(new Error("账号正在等待管理员审核通过，暂时无法使用打卡功能"), { status: 403 });
    }
    if (String(error.message).includes("ACCOUNT_REJECTED")) {
      throw Object.assign(new Error("账号审核未通过，请查看管理员评语"), { status: 403 });
    }
    throw error;
  }
}

async function recordCheckin(session, payload) {
  const { data } = await supabaseRequest("/rest/v1/rpc/record_checkin_server", {
    method: "POST",
    useServiceRole: true,
    body: {
      p_user_id: session.user.id,
      p_text: payload.text,
      p_topics: payload.topics,
      p_photo_count: payload.photoCount,
      p_review: payload.review,
      p_provider: payload.provider,
      p_model: payload.model,
      p_xp: payload.xp,
      p_coin: payload.coin,
      p_ai_options: payload.aiOptions,
    },
  });
  return data;
}

function cleanTeamText(value, label, maxLength) {
  const text = String(value || "").trim();
  if (!text || text.length > maxLength) {
    throw Object.assign(new Error(`${label}应为 1 到 ${maxLength} 个字符`), { status: 400 });
  }
  return text;
}

function cleanInviteCode(value) {
  const code = String(value || "").trim().toUpperCase().replace(/\s+/g, "");
  if (!/^[A-Z0-9]{8}$/.test(code)) {
    throw Object.assign(new Error("邀请码应为 8 位字母或数字"), { status: 400 });
  }
  return code;
}

function translateTeamError(error) {
  const message = String(error?.message || "");
  if (/could not find the function|schema cache|study_team/i.test(message) && /function|relation|table/i.test(message)) {
    return Object.assign(new Error("队友模式数据库尚未升级，请先在 Supabase 执行最新的 supabase-schema.sql"), { status: 503 });
  }
  const known = [
    ["ACCOUNT_NOT_APPROVED", "账号审核通过后才能使用队友模式", 403],
    ["ALREADY_IN_TEAM", "你已经加入了一个队伍", 409],
    ["TEAM_NOT_FOUND", "没有找到该邀请码对应的队伍", 404],
    ["TEAM_FULL", "这个队伍已满（最多 12 人）", 409],
    ["TEAM_ACCESS_DENIED", "你没有权限查看该队员的打卡记录", 403],
    ["NOT_IN_TEAM", "你当前没有加入队伍", 409],
    ["INVALID_TEAM_NAME", "队伍名称格式不正确", 400],
    ["INVALID_NICKNAME", "队内昵称格式不正确", 400],
  ];
  for (const [code, friendly, status] of known) {
    if (message.includes(code)) return Object.assign(new Error(friendly), { status });
  }
  return error;
}

async function teamRpc(session, functionName, body = {}) {
  try {
    const { data } = await supabaseRequest(`/rest/v1/rpc/${functionName}`, {
      method: "POST",
      accessToken: session.accessToken,
      body,
    });
    return data;
  } catch (error) {
    throw translateTeamError(error);
  }
}

async function getStudyTeam(session) {
  return teamRpc(session, "get_my_study_team");
}

async function createStudyTeam(session, payload) {
  return teamRpc(session, "create_study_team", {
    p_name: cleanTeamText(payload?.name, "队伍名称", 30),
    p_nickname: cleanTeamText(payload?.nickname, "队内昵称", 20),
  });
}

async function joinStudyTeam(session, payload) {
  return teamRpc(session, "join_study_team", {
    p_invite_code: cleanInviteCode(payload?.inviteCode),
    p_nickname: cleanTeamText(payload?.nickname, "队内昵称", 20),
  });
}

async function leaveStudyTeam(session) {
  return teamRpc(session, "leave_study_team");
}

async function getStudyTeamCheckins(session, userId, limit = 20) {
  const id = cleanUserId(userId);
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 20));
  const data = await teamRpc(session, "get_study_team_checkins", { p_user_id: id, p_limit: safeLimit });
  return Array.isArray(data) ? data : [];
}

function translateRewardError(error) {
  const message = String(error?.message || "");
  if (/could not find the function|schema cache|reward_catalog|reward_redemptions/i.test(message)) {
    return Object.assign(new Error("奖励中心数据库尚未升级，请先在 Supabase 执行最新的 supabase-schema.sql"), { status: 503 });
  }
  const known = [
    ["ACCOUNT_NOT_APPROVED", "账号审核通过后才能兑换奖励", 403],
    ["REWARD_NOT_FOUND", "没有找到这个奖励", 404],
    ["REWARD_UNAVAILABLE", "这个奖励当前不可兑换", 409],
    ["REWARD_NOT_FOR_USER", "这个奖励没有发布给当前账号", 403],
    ["REWARD_LIMIT_REACHED", "你已达到该奖励的兑换次数上限", 409],
    ["REWARD_OUT_OF_STOCK", "这个奖励已经兑完了", 409],
    ["INSUFFICIENT_COINS", "勇者金币不足，继续打卡积累吧", 409],
  ];
  for (const [code, friendly, status] of known) {
    if (message.includes(code)) return Object.assign(new Error(friendly), { status });
  }
  return error;
}

async function rewardRpc(session, functionName, body = {}) {
  try {
    const { data } = await supabaseRequest(`/rest/v1/rpc/${functionName}`, {
      method: "POST",
      accessToken: session.accessToken,
      body,
    });
    return data;
  } catch (error) {
    throw translateRewardError(error);
  }
}

async function getAvailableRewards(session) {
  return rewardRpc(session, "get_available_rewards");
}

async function redeemReward(session, rewardId) {
  return rewardRpc(session, "redeem_reward", { p_reward_id: cleanUserId(rewardId) });
}

function encryptionKey() {
  const secret = String(process.env.APP_ENCRYPTION_KEY || "");
  if (secret.length < 32) throw Object.assign(new Error("APP_ENCRYPTION_KEY 至少需要 32 个字符"), { status: 503 });
  return crypto.createHash("sha256").update(secret).digest();
}

function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

function decryptSecret(value) {
  const [version, ivPart, tagPart, encryptedPart] = String(value || "").split(".");
  if (version !== "v1" || !ivPart || !tagPart || !encryptedPart) throw new Error("加密配置格式不正确");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivPart, "base64url"));
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedPart, "base64url")), decipher.final()]).toString("utf8");
}

async function saveHabiticaConnection(session, config) {
  await supabaseRequest(restPath("habitica_connections", "on_conflict=user_id"), {
    method: "POST",
    accessToken: session.accessToken,
    prefer: "resolution=merge-duplicates,return=minimal",
    body: {
      user_id: session.user.id,
      habitica_user_id: config.userId,
      token_ciphertext: encryptSecret(config.apiToken),
      task_id: config.taskId,
      client_id: config.clientId,
      task_name: config.taskName || "考研勇者每日打卡",
      updated_at: new Date().toISOString(),
    },
  });
}

async function getHabiticaConnection(session, includeToken = true) {
  if (!session) return null;
  const userId = encodeURIComponent(session.user.id);
  const { data } = await supabaseRequest(restPath("habitica_connections", `user_id=eq.${userId}&select=habitica_user_id,token_ciphertext,task_id,client_id,task_name&limit=1`), { accessToken: session.accessToken });
  const row = data?.[0];
  if (!row) return null;
  return {
    userId: row.habitica_user_id,
    apiToken: includeToken ? decryptSecret(row.token_ciphertext) : "",
    taskId: row.task_id,
    clientId: row.client_id,
    taskName: row.task_name,
  };
}

function googleOAuthUrl(req) {
  if (!publicConfig().googleAuth) throw Object.assign(new Error("Google 登录尚未在服务端启用"), { status: 503 });
  if (!process.env.PUBLIC_APP_URL) throw Object.assign(new Error("启用 Google 登录前必须配置 PUBLIC_APP_URL"), { status: 503 });
  const redirectTo = `${String(process.env.PUBLIC_APP_URL).replace(/\/$/, "")}/`;
  return `${supabaseBase()}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(redirectTo)}`;
}

function githubOAuthUrl(req) {
  if (!publicConfig().githubAuth) throw Object.assign(new Error("GitHub 登录尚未在服务端启用"), { status: 503 });
  if (!process.env.PUBLIC_APP_URL) throw Object.assign(new Error("启用 GitHub 登录前必须配置 PUBLIC_APP_URL"), { status: 503 });
  const redirectTo = `${String(process.env.PUBLIC_APP_URL).replace(/\/$/, "")}/`;
  return `${supabaseBase()}/auth/v1/authorize?provider=github&redirect_to=${encodeURIComponent(redirectTo)}`;
}

// ---- Admin panel（新用户审核）----

function adminSecret() {
  const secret = String(process.env.ADMIN_PASSWORD || "");
  if (!secret) throw Object.assign(new Error("管理员功能尚未配置 ADMIN_PASSWORD"), { status: 503 });
  return secret;
}

function signAdminToken(expiresAt) {
  const hmac = crypto.createHmac("sha256", adminSecret()).update(String(expiresAt)).digest("hex");
  return `${expiresAt}.${hmac}`;
}

function verifyAdminToken(token) {
  if (!token || typeof token !== "string") return false;
  const [expiresAtStr, hmac] = token.split(".");
  const expiresAt = Number(expiresAtStr);
  if (!expiresAt || Date.now() > expiresAt || !hmac) return false;
  let expected;
  try {
    expected = crypto.createHmac("sha256", adminSecret()).update(String(expiresAt)).digest("hex");
  } catch {
    return false;
  }
  try {
    const a = Buffer.from(hmac, "hex");
    const b = Buffer.from(expected, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function passwordsMatch(a, b) {
  const hashA = crypto.createHash("sha256").update(String(a)).digest();
  const hashB = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
}

async function adminLogin(req, res, payload) {
  const password = String(payload?.password || "");
  const expected = String(process.env.ADMIN_PASSWORD || "");
  if (!expected) throw Object.assign(new Error("管理员登录尚未在服务端配置（缺少 ADMIN_PASSWORD）"), { status: 503 });
  if (!password || !passwordsMatch(password, expected)) {
    throw Object.assign(new Error("管理员密码不正确"), { status: 401 });
  }
  const expiresAt = Date.now() + ADMIN_SESSION_MS;
  const token = signAdminToken(expiresAt);
  res.setHeader("Set-Cookie", cookieLine(req, ADMIN_COOKIE, token, Math.floor(ADMIN_SESSION_MS / 1000)));
  return { ok: true };
}

function adminLogout(req, res) {
  res.setHeader("Set-Cookie", cookieLine(req, ADMIN_COOKIE, "", 0));
}

function isAdminRequest(req) {
  const cookies = parseCookies(req);
  return verifyAdminToken(cookies[ADMIN_COOKIE]);
}

function requireAdmin(req) {
  if (!isAdminRequest(req)) throw Object.assign(new Error("请先登录管理员账户"), { status: 401 });
}

async function adminListAuthUsers() {
  const perPage = 200;
  let page = 1;
  let all = [];
  for (let i = 0; i < 10; i += 1) {
    const { data } = await supabaseRequest(`/auth/v1/admin/users?page=${page}&per_page=${perPage}`, { useServiceRole: true });
    const users = Array.isArray(data?.users) ? data.users : [];
    all = all.concat(users.map((user) => ({ id: user.id, email: user.email })));
    if (users.length < perPage) break;
    page += 1;
  }
  return all;
}

async function adminListUsers() {
  const [{ data: profileRows }, authUsers, { data: noteRows }] = await Promise.all([
    requestAdminProfiles(),
    adminListAuthUsers(),
    requestAdminNotes(),
  ]);
  const emailById = new Map(authUsers.map((user) => [user.id, user.email]));
  const noteById = new Map((noteRows || []).map((item) => [item.user_id, item.note]));
  return (profileRows || []).map((row) => {
    const approval = approvalView(row);
    return {
      id: row.id,
      email: emailById.get(row.id) || "(未知邮箱)",
      displayName: String(row.display_name || "").trim(),
      adminNote: String(noteById.get(row.id) || "").trim(),
      approved: approval.approved,
      approvalStatus: approval.status,
      approvalComment: approval.comment,
      reviewedAt: approval.reviewedAt,
      xp: Number(row.xp || 0),
      coin: Number(row.coin || 0),
      streak: Number(row.streak || 0),
      createdAt: row.created_at,
    };
  });
}

async function adminUpdateUserNote(userId, payload) {
  const id = cleanUserId(userId);
  const note = cleanAdminNote(payload?.note);
  try {
    if (note) {
      await supabaseRequest(restPath("admin_user_notes", "on_conflict=user_id"), {
        method: "POST",
        useServiceRole: true,
        prefer: "resolution=merge-duplicates,return=minimal",
        body: { user_id: id, note, updated_at: new Date().toISOString() },
      });
    } else {
      await supabaseRequest(restPath("admin_user_notes", `user_id=eq.${encodeURIComponent(id)}`), {
        method: "DELETE",
        useServiceRole: true,
        prefer: "return=minimal",
      });
    }
  } catch (error) {
    if (missingProfileIdentitySchema(error)) {
      throw Object.assign(new Error("管理员备注字段尚未升级，请先执行最新的 supabase-schema.sql"), { status: 503 });
    }
    throw error;
  }
  return { note };
}

function cleanUserId(userId) {
  const id = String(userId || "").trim();
  if (!/^[0-9a-f-]{20,64}$/i.test(id)) throw Object.assign(new Error("用户 ID 不正确"), { status: 400 });
  return id;
}

async function adminReviewUser(userId, payload) {
  const id = cleanUserId(userId);
  const decision = cleanReviewDecision(payload);
  try {
    await supabaseRequest(restPath("profiles", `id=eq.${encodeURIComponent(id)}`), {
      method: "PATCH",
      useServiceRole: true,
      prefer: "return=minimal",
      body: {
        approval_status: decision.status,
        approval_comment: decision.comment,
        reviewed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    });
  } catch (error) {
    if (missingApprovalSchema(error)) {
      throw Object.assign(new Error("数据库审核字段尚未升级，请先执行最新的 supabase-schema.sql"), { status: 503 });
    }
    throw error;
  }
  return decision;
}

async function adminSetApproval(userId, approved) {
  if (approved) return adminReviewUser(userId, { status: "approved", comment: "管理员审核通过" });
  const id = cleanUserId(userId);
  await supabaseRequest(restPath("profiles", `id=eq.${encodeURIComponent(id)}`), {
    method: "PATCH",
    useServiceRole: true,
    prefer: "return=minimal",
    body: { approval_status: "pending", approval_comment: "", reviewed_at: null, updated_at: new Date().toISOString() },
  });
}

async function adminListUserCheckins(userId, limit = 50) {
  const id = String(userId || "").trim();
  if (!/^[0-9a-f-]{20,64}$/i.test(id)) throw Object.assign(new Error("用户 ID 不正确"), { status: 400 });
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const { data } = await supabaseRequest(
    restPath(
      "checkins",
      `user_id=eq.${encodeURIComponent(id)}&select=id,study_text,topics,photo_count,score,title,review,provider,model,xp,coin,created_at&order=created_at.desc&limit=${safeLimit}`,
    ),
    { useServiceRole: true },
  );
  return (data || []).map((row) => ({
    id: row.id,
    studyText: row.study_text || "",
    topics: Array.isArray(row.topics) ? row.topics : [],
    photoCount: Number(row.photo_count || 0),
    score: Number(row.score || 0),
    title: row.title || "学习打卡",
    review: row.review || null,
    provider: row.provider || "",
    model: row.model || "",
    xp: Number(row.xp || 0),
    coin: Number(row.coin || 0),
    createdAt: row.created_at,
  }));
}

function cleanShortText(value, label, maxLength, { required = true } = {}) {
  const text = String(value || "").trim();
  if ((required && !text) || text.length > maxLength) {
    throw Object.assign(new Error(`${label}${required ? `应为 1 到 ${maxLength} 个字符` : `不能超过 ${maxLength} 个字符`}`), { status: 400 });
  }
  return text;
}

function parseRecipientIds(value) {
  const parts = Array.isArray(value) ? value : String(value || "").split(/[\s,;，；]+/);
  const ids = [...new Set(parts.map((item) => String(item || "").trim()).filter(Boolean))];
  for (const id of ids) cleanUserId(id);
  return ids;
}

function cleanWholeNumber(value, label, { min = 0, max = 999999, nullable = false } = {}) {
  if (nullable && (value === "" || value === null || value === undefined)) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw Object.assign(new Error(`${label}应为 ${min} 到 ${max} 的整数`), { status: 400 });
  }
  return number;
}

async function adminListRewardGroups() {
  const [{ data: groups }, { data: members }, authUsers] = await Promise.all([
    supabaseRequest(restPath("reward_groups", "select=id,name,created_at&order=created_at.desc"), { useServiceRole: true }),
    supabaseRequest(restPath("reward_group_members", "select=group_id,user_id"), { useServiceRole: true }),
    adminListAuthUsers(),
  ]);
  const emailById = new Map(authUsers.map((user) => [user.id, user.email]));
  return (groups || []).map((group) => ({
    id: group.id,
    name: group.name,
    createdAt: group.created_at,
    members: (members || []).filter((member) => member.group_id === group.id).map((member) => ({
      userId: member.user_id,
      email: emailById.get(member.user_id) || "(未知邮箱)",
    })),
  }));
}

async function adminCreateRewardGroup(payload) {
  const name = cleanShortText(payload?.name, "分组名称", 40);
  const memberIds = parseRecipientIds(payload?.memberIds);
  if (!memberIds.length) throw Object.assign(new Error("请至少选择一位分组成员"), { status: 400 });
  const { data } = await supabaseRequest(restPath("reward_groups"), {
    method: "POST",
    useServiceRole: true,
    prefer: "return=representation",
    body: { name },
  });
  const group = data?.[0];
  if (!group?.id) throw Object.assign(new Error("奖励分组创建失败"), { status: 502 });
  await supabaseRequest(restPath("reward_group_members"), {
    method: "POST",
    useServiceRole: true,
    prefer: "return=minimal",
    body: memberIds.map((userId) => ({ group_id: group.id, user_id: userId })),
  });
  return { id: group.id, name, memberIds };
}

async function adminListRewards() {
  const [{ data: rewards }, { data: groups }, { data: redemptions }, authUsers] = await Promise.all([
    supabaseRequest(restPath("reward_catalog", "select=*&order=created_at.desc&limit=200"), { useServiceRole: true }),
    supabaseRequest(restPath("reward_groups", "select=id,name"), { useServiceRole: true }),
    supabaseRequest(restPath("reward_redemptions", "select=reward_id,user_id,status,created_at&order=created_at.desc&limit=5000"), { useServiceRole: true }),
    adminListAuthUsers(),
  ]);
  const groupById = new Map((groups || []).map((group) => [group.id, group.name]));
  const emailById = new Map(authUsers.map((user) => [user.id, user.email]));
  return (rewards || []).map((reward) => ({
    id: reward.id,
    title: reward.title,
    description: reward.description || "",
    coinCost: Number(reward.coin_cost || 0),
    stock: reward.stock === null ? null : Number(reward.stock),
    perUserLimit: Number(reward.per_user_limit || 1),
    audienceMode: reward.audience_mode,
    targetUserIds: Array.isArray(reward.target_user_ids) ? reward.target_user_ids : [],
    groupId: reward.group_id,
    groupName: groupById.get(reward.group_id) || "",
    requiresReview: Boolean(reward.requires_review),
    active: Boolean(reward.active),
    redeemedTotal: (redemptions || []).filter((item) => item.reward_id === reward.id && !["cancelled", "rejected"].includes(item.status)).length,
    pendingTotal: (redemptions || []).filter((item) => item.reward_id === reward.id && item.status === "pending").length,
    redemptions: (redemptions || []).filter((item) => item.reward_id === reward.id && item.status !== "cancelled").slice(0, 20).map((item) => ({
      userId: item.user_id,
      email: emailById.get(item.user_id) || "(未知邮箱)",
      status: item.status,
      createdAt: item.created_at,
    })),
    createdAt: reward.created_at,
  }));
}

async function adminCreateReward(payload) {
  const audienceMode = ["all", "users", "group"].includes(payload?.audienceMode) ? payload.audienceMode : "all";
  const targetUserIds = audienceMode === "users" ? parseRecipientIds(payload?.targetUserIds) : [];
  const groupId = audienceMode === "group" ? cleanUserId(payload?.groupId) : null;
  if (audienceMode === "users" && !targetUserIds.length) {
    throw Object.assign(new Error("定向奖励至少需要一位用户 ID"), { status: 400 });
  }
  const row = {
    title: cleanShortText(payload?.title, "奖励名称", 60),
    description: cleanShortText(payload?.description, "奖励说明", 500, { required: false }),
    coin_cost: cleanWholeNumber(payload?.coinCost, "兑换金币", { min: 0, max: 999999 }),
    stock: cleanWholeNumber(payload?.stock, "总库存", { min: 1, max: 999999, nullable: true }),
    per_user_limit: cleanWholeNumber(payload?.perUserLimit, "每人限兑次数", { min: 1, max: 999 }),
    audience_mode: audienceMode,
    target_user_ids: targetUserIds,
    group_id: groupId,
    requires_review: payload?.requiresReview === true || payload?.requiresReview === "on" || payload?.requiresReview === "true",
    active: payload?.active !== false,
  };
  const { data } = await supabaseRequest(restPath("reward_catalog"), {
    method: "POST",
    useServiceRole: true,
    prefer: "return=representation",
    body: row,
  });
  return data?.[0] || row;
}

async function adminListRewardRedemptions() {
  const [{ data: redemptions }, { data: rewards }, authUsers, { data: noteRows }] = await Promise.all([
    supabaseRequest(restPath("reward_redemptions", "select=id,reward_id,user_id,coin_cost,status,review_note,reviewed_at,created_at&order=created_at.desc&limit=2000"), { useServiceRole: true }),
    supabaseRequest(restPath("reward_catalog", "select=id,title,description,requires_review"), { useServiceRole: true }),
    adminListAuthUsers(),
    requestAdminNotes(),
  ]);
  const rewardById = new Map((rewards || []).map((reward) => [reward.id, reward]));
  const emailById = new Map(authUsers.map((user) => [user.id, user.email]));
  const noteById = new Map((noteRows || []).map((item) => [item.user_id, item.note]));
  return (redemptions || []).map((item) => {
    const reward = rewardById.get(item.reward_id) || {};
    return {
      id: item.id,
      rewardId: item.reward_id,
      rewardTitle: reward.title || "已删除奖励",
      rewardDescription: reward.description || "",
      requiresReview: Boolean(reward.requires_review),
      userId: item.user_id,
      email: emailById.get(item.user_id) || "(未知邮箱)",
      adminNote: noteById.get(item.user_id) || "",
      coinCost: Number(item.coin_cost || 0),
      status: item.status,
      reviewNote: item.review_note || "",
      reviewedAt: item.reviewed_at || null,
      createdAt: item.created_at,
    };
  });
}

async function adminReviewRewardRedemption(redemptionId, payload) {
  const id = cleanUserId(redemptionId);
  const decision = cleanRewardReviewDecision(payload);
  const { data } = await supabaseRequest("/rest/v1/rpc/review_reward_redemption", {
    method: "POST",
    useServiceRole: true,
    body: { p_redemption_id: id, p_status: decision.status, p_note: decision.note },
  });
  return data;
}

module.exports = {
  configured,
  publicConfig,
  signUp,
  signIn,
  requestPasswordReset,
  updatePassword,
  acceptOAuthSession,
  sessionFromRequest,
  requireSession,
  signOut,
  getUserState,
  updateUserProfile,
  savePreferences,
  assertWithinDailyLimit,
  recordCheckin,
  getStudyTeam,
  createStudyTeam,
  joinStudyTeam,
  leaveStudyTeam,
  getStudyTeamCheckins,
  getAvailableRewards,
  redeemReward,
  saveHabiticaConnection,
  getHabiticaConnection,
  googleOAuthUrl,
  githubOAuthUrl,
  adminLogin,
  adminLogout,
  isAdminRequest,
  requireAdmin,
  adminListUsers,
  adminUpdateUserNote,
  adminReviewUser,
  adminSetApproval,
  adminListUserCheckins,
  adminListRewards,
  adminCreateReward,
  adminListRewardRedemptions,
  adminReviewRewardRedemption,
  adminListRewardGroups,
  adminCreateRewardGroup,
  _test: { parseCookies, encryptSecret, decryptSecret, approvalView, cleanReviewDecision, cleanRewardReviewDecision, cleanDisplayName, cleanAdminNote, missingApprovalSchema, missingProfileIdentitySchema, cleanTeamText, cleanInviteCode, translateTeamError, translateRewardError, parseRecipientIds },
};
