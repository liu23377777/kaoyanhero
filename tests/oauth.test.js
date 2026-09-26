const test = require("node:test");
const assert = require("node:assert/strict");

const cloud = require("../cloud");

test("builds a GitHub OAuth URL only when the provider is enabled", (t) => {
  const previous = {
    url: process.env.SUPABASE_URL,
    anon: process.env.SUPABASE_ANON_KEY,
    enabled: process.env.ENABLE_GITHUB_AUTH,
    publicUrl: process.env.PUBLIC_APP_URL,
  };
  process.env.SUPABASE_URL = "https://project-ref.supabase.co";
  process.env.SUPABASE_ANON_KEY = "test-anon-key";
  process.env.ENABLE_GITHUB_AUTH = "true";
  process.env.PUBLIC_APP_URL = "https://kaoyan-hero.onrender.com/";
  t.after(() => {
    for (const [key, value] of Object.entries({
      SUPABASE_URL: previous.url,
      SUPABASE_ANON_KEY: previous.anon,
      ENABLE_GITHUB_AUTH: previous.enabled,
      PUBLIC_APP_URL: previous.publicUrl,
    })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  const url = new URL(cloud.githubOAuthUrl({ headers: {} }));
  assert.equal(url.origin, "https://project-ref.supabase.co");
  assert.equal(url.pathname, "/auth/v1/authorize");
  assert.equal(url.searchParams.get("provider"), "github");
  assert.equal(url.searchParams.get("redirect_to"), "https://kaoyan-hero.onrender.com/");
});

test("rejects GitHub OAuth while its server flag is disabled", (t) => {
  const previous = process.env.ENABLE_GITHUB_AUTH;
  process.env.ENABLE_GITHUB_AUTH = "false";
  t.after(() => {
    if (previous === undefined) delete process.env.ENABLE_GITHUB_AUTH; else process.env.ENABLE_GITHUB_AUTH = previous;
  });
  assert.throws(() => cloud.githubOAuthUrl({ headers: {} }), (error) => error.status === 503 && /尚未/.test(error.message));
});
