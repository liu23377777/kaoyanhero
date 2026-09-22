const crypto = require("node:crypto");

const ACCESS_COOKIE = "kh_access";
const REFRESH_COOKIE = "kh_refresh";

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
  const headers = {
    apikey: anonKey,
    Authorization: `Bearer ${options.accessToken || anonKey}`,
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
    supabaseRequest(restPath("profiles", `id=eq.${userId}&select=id,xp,coin,streak,last_date`), { accessToken: session.accessToken }),
    supabaseRequest(restPath("checkins", `user_id=eq.${userId}&select=id,score,title,provider,xp,created_at&order=created_at.desc&limit=20`), { accessToken: session.accessToken }),
    supabaseRequest(restPath("ai_preferences", `user_id=eq.${userId}&select=provider,reasoning_mode,detail_level,max_tokens,temperature&limit=1`), { accessToken: session.accessToken }),
  ]);
  const profile = profiles.data?.[0] || { xp: 0, coin: 0, streak: 0, last_date: null };
  return {
    profile: {
      xp: Number(profile.xp || 0),
      coin: Number(profile.coin || 0),
      streak: Number(profile.streak || 0),
      lastDate: profile.last_date || "",
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
  _test: { parseCookies, encryptSecret, decryptSecret },
};
