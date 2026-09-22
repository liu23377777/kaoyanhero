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

async function signUp(req, res, payload) {
  const email = cleanEmail(payload?.email);
  const password = cleanPassword(payload?.password);
  const { data } = await supabaseRequest("/auth/v1/signup", { method: "POST", body: { email, password } });
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

async function getUserState(session) {
  const userId = encodeURIComponent(session.user.id);
  const [profiles, checkins, preferences] = await Promise.all([
    supabaseRequest(restPath("profiles", `id=eq.${userId}&select=id,xp,coin,streak,last_date,approved`), { accessToken: session.accessToken }),
    supabaseRequest(restPath("checkins", `user_id=eq.${userId}&select=id,score,title,provider,xp,created_at&order=created_at.desc&limit=20`), { accessToken: session.accessToken }),
    supabaseRequest(restPath("ai_preferences", `user_id=eq.${userId}&select=provider,reasoning_mode,detail_level,max_tokens,temperature&limit=1`), { accessToken: session.accessToken }),
  ]);
  const profile = profiles.data?.[0] || { xp: 0, coin: 0, streak: 0, last_date: null, approved: false };
  return {
    profile: {
      xp: Number(profile.xp || 0),
      coin: Number(profile.coin || 0),
      streak: Number(profile.streak || 0),
      lastDate: profile.last_date || "",
      approved: Boolean(profile.approved),
    },
    history: (checkins.data || []).map((item) => ({
      id: item.id,
      score: Number(item.score || 0),
      title: item.title || "学习打卡",
      provider: item.provider || "AI",
      xp: Number(item.xp || 0),
      createdAt: item.created_at,
    })),
    preferences: preferences.data?.[0] || null,
  };
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
    throw error;
  }
}

async function recordCheckin(session, payload) {
  const { data } = await supabaseRequest("/rest/v1/rpc/record_checkin", {
    method: "POST",
    accessToken: session.accessToken,
    body: {
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
  const [{ data: profileRows }, authUsers] = await Promise.all([
    supabaseRequest(restPath("profiles", "select=id,xp,coin,streak,approved,created_at&order=created_at.desc&limit=500"), { useServiceRole: true }),
    adminListAuthUsers(),
  ]);
  const emailById = new Map(authUsers.map((user) => [user.id, user.email]));
  return (profileRows || []).map((row) => ({
    id: row.id,
    email: emailById.get(row.id) || "(未知邮箱)",
    approved: Boolean(row.approved),
    xp: Number(row.xp || 0),
    coin: Number(row.coin || 0),
    streak: Number(row.streak || 0),
    createdAt: row.created_at,
  }));
}

async function adminSetApproval(userId, approved) {
  const id = String(userId || "").trim();
  if (!/^[0-9a-f-]{20,64}$/i.test(id)) throw Object.assign(new Error("用户 ID 不正确"), { status: 400 });
  await supabaseRequest(restPath("profiles", `id=eq.${encodeURIComponent(id)}`), {
    method: "PATCH",
    useServiceRole: true,
    prefer: "return=minimal",
    body: { approved: Boolean(approved) },
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

module.exports = {
  configured,
  publicConfig,
  signUp,
  signIn,
  acceptOAuthSession,
  sessionFromRequest,
  requireSession,
  signOut,
  getUserState,
  savePreferences,
  assertWithinDailyLimit,
  recordCheckin,
  saveHabiticaConnection,
  getHabiticaConnection,
  googleOAuthUrl,
  adminLogin,
  adminLogout,
  isAdminRequest,
  requireAdmin,
  adminListUsers,
  adminSetApproval,
  adminListUserCheckins,
  _test: { parseCookies, encryptSecret, decryptSecret },
};
