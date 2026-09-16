// AI Gateway Route Studio — Cloudflare Worker
// 登录门 + Cloudflare API 反代（动态路由 CRUD / 版本 / 部署 / 网关设置 / 模型列表拉取）
// 部署：
//   wrangler secret put ADMIN_TOKEN      ← 管理台访问口令（自定）
//   wrangler secret put CF_API_TOKEN     ← Cloudflare API Token（需 AI Gateway 编辑权限 + Account.Resources.Read）
//   wrangler secret put OPENAI_API_KEY   ← 可选，拉取各厂商模型列表用
//   wrangler deploy

const CF_API = "https://api.cloudflare.com/client/v4";

// 各厂商模型列表接口（部署后由 Worker 反代；未配置密钥的厂商返回提示）
const MODEL_APIS = {
  openai:       { url: "https://api.openai.com/v1/models",           key: "OPENAI_API_KEY" },
  anthropic:    { url: "https://api.anthropic.com/v1/models",        key: "ANTHROPIC_API_KEY", extra: { "anthropic-version": "2023-06-01" } },
  "google-ai-studio": { url: "https://generativelanguage.googleapis.com/v1beta/models", key: "GEMINI_API_KEY", pick: (j) => (j.models || []).map((m) => String(m.name || "").replace("models/", "")) },
  deepseek:     { url: "https://api.deepseek.com/models",            key: "DEEPSEEK_API_KEY" },
  moonshot:     { url: "https://api.moonshot.cn/v1/models",          key: "MOONSHOT_API_KEY" },
  xai:          { url: "https://api.x.ai/v1/models",                 key: "XAI_API_KEY" },
  groq:         { url: "https://api.groq.com/openai/v1/models",      key: "GROQ_API_KEY" },
  mistral:      { url: "https://api.mistral.ai/v1/models",           key: "MISTRAL_API_KEY" },
  openrouter:   { url: "https://openrouter.ai/api/v1/models",        key: "OPENROUTER_API_KEY" },
  perplexity:   { url: "https://api.perplexity.ai/models",           key: "PERPLEXITY_API_KEY" },
};

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

async function sha256hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function getCookie(request, name) {
  const m = (request.headers.get("Cookie") || "").match(new RegExp("(?:^|;\\s*)" + name + "=([a-f0-9]{64})"));
  return m ? m[1] : null;
}

async function isAuthed(request, env) {
  if (!env.ADMIN_TOKEN) return false; // 未配置口令 → 拒绝并提示
  const expect = await sha256hex(env.ADMIN_TOKEN);
  return getCookie(request, "studio") === expect;
}

// Cloudflare API 反代
async function cf(env, path, { method = "GET", body } = {}) {
  const res = await fetch(CF_API + path, {
    method,
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) { /* keep null */ }
  return { status: res.status, data };
}

// 上游响应包装：Cloudflare 侧鉴权失败（401/403，以及 400+code 9106 "Authentication failed"）
// 不能透传成 401，否则前端会误判为"登录过期"而跳回登录页。统一转成 502 + 明确提示。
function upstream(data, status) {
  const cfCode = data?.errors?.[0]?.code;
  if (status === 401 || status === 403 || cfCode === 9106) {
    return json({
      error: "Cloudflare API 鉴权失败（状态 " + status + "，code " + cfCode + "）：请检查 CF_API_TOKEN 是否有效、是否具备 AI Gateway 编辑权限与 Account 资源读取权限",
      upstreamStatus: status,
      upstreamErrors: data?.errors || null,
    }, 502);
  }
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ── 登录 ──
    if (path === "/api/login" && request.method === "POST") {
      if (!env.ADMIN_TOKEN) return json({ error: "Worker 未配置 ADMIN_TOKEN（wrangler secret put ADMIN_TOKEN）" }, 500);
      const body = await request.json().catch(() => ({}));
      if (body.token && body.token === env.ADMIN_TOKEN) {
        const h = await sha256hex(env.ADMIN_TOKEN);
        return json({ ok: true }, 200, {
          "Set-Cookie": `studio=${h}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`,
        });
      }
      return json({ error: "口令错误" }, 401);
    }

    // ── 静态资源 / 应用外壳（需登录） ──
    if (!path.startsWith("/api/")) {
      if (!(await isAuthed(request, env))) {
        // 未登录一律回登录页（静态资源也保护）
        return env.ASSETS.fetch(new URL("/login.html", url.origin));
      }
      return env.ASSETS.fetch(request);
    }

    // ── API 鉴权 ──
    if (!(await isAuthed(request, env))) return json({ error: "未登录" }, 401);

    if (!env.CF_API_TOKEN) return json({ error: "Worker 未配置 CF_API_TOKEN（wrangler secret put CF_API_TOKEN）" }, 500);
    const acc = env.ACCOUNT_ID;
    if (!acc || acc.includes("替换")) return json({ error: "未配置 ACCOUNT_ID（编辑 wrangler.jsonc 里的 vars）" }, 500);

    try {
      // GET /api/meta — 账户 + 网关列表
      if (path === "/api/meta") {
        const { status, data } = await cf(env, `/accounts/${acc}/ai-gateway/gateways?per_page=50`);
        const gateways = (data && (data.result || [])) || [];
        return json({ ok: true, accountId: acc, gateways: gateways.map((g) => ({ id: g.id, created_at: g.created_at })), upstreamStatus: status, upstreamError: !data?.success ? data?.errors : null });
      }

      // GET /api/models/:provider — 反代厂商模型列表
      const mModel = path.match(/^\/api\/models\/([a-z0-9-]+)$/);
      if (mModel && request.method === "GET") {
        const conf = MODEL_APIS[mModel[1]];
        if (!conf) return json({ models: [], error: "该厂商暂不支持自动拉取，请直接输入模型名" });
        const key = env[conf.key];
        if (!key) return json({ models: [], error: `未配置 ${conf.key}（wrangler secret put ${conf.key}），可手动输入模型名` });
        const res = await fetch(conf.url, { headers: { Authorization: `Bearer ${key}`, ...(conf.extra || {}) } });
        const data = await res.json().catch(() => ({}));
        const models = conf.pick ? conf.pick(data) : (data.data || []).map((m) => m.id).filter(Boolean);
        return json({ models: (models || []).sort() });
      }

      // /api/gw/:gw/... — 网关与动态路由
      const mGw = path.match(/^\/api\/gw\/([^/]+)(\/routes(?:\/([^/]+))?(\/(versions|deployments))?)?$/);
      if (mGw) {
        const gw = mGw[1], rid = mGw[3], sub = mGw[4];
        const base = `/accounts/${acc}/ai-gateway/gateways/${encodeURIComponent(gw)}`;

        // 网关设置（GET / PUT 网关对象本身）
        if (!path.includes("/routes")) {
          if (request.method === "GET") {
            const { status, data } = await cf(env, base);
            return upstream(data, status);
          }
          if (request.method === "PUT") {
            const body = await request.json().catch(() => ({}));
            const { status, data } = await cf(env, base, { method: "PUT", body });
            return upstream(data, status);
          }
        }

        // 动态路由 CRUD
        if (!rid) {
          if (request.method === "GET") {
            const { status, data } = await cf(env, `${base}/routes?per_page=100`);
            return upstream(data, status);
          }
          if (request.method === "POST") {
            const body = await request.json().catch(() => ({})); // {name, elements}
            const { status, data } = await cf(env, `${base}/routes`, { method: "POST", body });
            return upstream(data, status);
          }
        }

        if (rid && !sub) {
          if (request.method === "GET") {
            const { status, data } = await cf(env, `${base}/routes/${encodeURIComponent(rid)}`);
            return upstream(data, status);
          }
          if (request.method === "PATCH") {
            const body = await request.json().catch(() => ({})); // {name}
            const { status, data } = await cf(env, `${base}/routes/${encodeURIComponent(rid)}`, { method: "PATCH", body });
            return upstream(data, status);
          }
          if (request.method === "DELETE") {
            const { status, data } = await cf(env, `${base}/routes/${encodeURIComponent(rid)}`, { method: "DELETE" });
            return upstream(data, status);
          }
        }

        if (rid && sub === "versions") {
          if (request.method === "GET") {
            const { status, data } = await cf(env, `${base}/routes/${encodeURIComponent(rid)}/versions`);
            return upstream(data, status);
          }
          if (request.method === "POST") {
            const body = await request.json().catch(() => ({})); // {elements}
            const { status, data } = await cf(env, `${base}/routes/${encodeURIComponent(rid)}/versions`, { method: "POST", body });
            return upstream(data, status);
          }
        }

        if (rid && sub === "deployments") {
          if (request.method === "GET") {
            const { status, data } = await cf(env, `${base}/routes/${encodeURIComponent(rid)}/deployments`);
            return upstream(data, status);
          }
          if (request.method === "POST") {
            const body = await request.json().catch(() => ({})); // {version_id}
            const { status, data } = await cf(env, `${base}/routes/${encodeURIComponent(rid)}/deployments`, { method: "POST", body });
            return upstream(data, status);
          }
        }
      }

      return json({ error: "未知接口：" + path }, 404);
    } catch (e) {
      return json({ error: "代理异常：" + (e.message || e) }, 500);
    }
  },
};
