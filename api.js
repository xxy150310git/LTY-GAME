/*
 * 后端客户端。全部走 Supabase 的 REST 接口（Auth 用 GoTrue，数据用 PostgREST）。
 *
 * 三条设计约定：
 *   1. 任何函数都不会抛异常，统一返回 { ok, ... }，调用方不用写 try/catch；
 *   2. 没配置后端（纯本地模式）或断网时，返回 { ok:false, offline:true }，
 *      调用方据此降级到本地逻辑，游戏照样能玩；
 *   3. 这里不碰本地存储，token 由调用方传进来 —— 这样这一层是纯函数式的，好测。
 */
const Api = (function () {
  const cfg = window.LTY_CONFIG || {};
  const baseUrl = String(cfg.supabaseUrl || "").replace(/\/+$/, "");
  const anonKey = String(cfg.supabaseAnonKey || "");

  /* 测试时可以被替换掉 */
  let fetchImpl = (typeof window.fetch === "function") ? window.fetch.bind(window) : null;

  function setFetch(fn) {
    fetchImpl = fn;
  }

  function configured() {
    return !!(baseUrl && anonKey);
  }

  /* 把服务端返回的英文报错换成看得懂的中文 */
  function friendly(message) {
    const text = String(message || "");
    if (!text) return "请求失败，请稍后再试";
    if (/Invalid login credentials/i.test(text)) return "邮箱或密码不对";
    if (/User already registered|already been registered/i.test(text)) return "这个邮箱已经注册过了";
    if (/Password should be at least/i.test(text)) return "密码太短了，至少 6 位";
    if (/Email not confirmed/i.test(text)) return "邮箱还没确认，先去收件箱点一下确认链接";
    if (/Email address .* is invalid/i.test(text)) return "邮箱格式不对";
    if (/rate limit|too many/i.test(text)) return "操作太频繁了，歇一会儿再试";
    if (/violates row-level security|permission denied/i.test(text)) return "没有权限做这个操作";
    return text;
  }

  function pickError(data) {
    if (!data) return "";
    if (typeof data === "string") return data;
    return data.msg || data.message || data.error_description || data.error || "";
  }

  function headers(auth, extra) {
    const out = {
      apikey: anonKey,
      "Content-Type": "application/json"
    };
    /* 没带用户 token 时用 anon key 顶，PostgREST 要求 Authorization 必须存在 */
    out.Authorization = "Bearer " + (auth || anonKey);
    if (extra) Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
    return out;
  }

  async function call(path, options) {
    if (!configured()) {
      return { ok: false, offline: true, error: "还没配置后端（当前是纯本地模式）" };
    }
    if (!fetchImpl) {
      return { ok: false, offline: true, error: "当前环境不支持网络请求" };
    }

    const opts = options || {};
    try {
      const res = await fetchImpl(baseUrl + path, {
        method: opts.method || "GET",
        headers: headers(opts.auth, opts.headers),
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
      });

      const text = await res.text();
      let data = null;
      if (text) {
        try { data = JSON.parse(text); } catch (error) { data = text; }
      }

      if (!res.ok) {
        return { ok: false, status: res.status, data: data, error: friendly(pickError(data)) };
      }
      return { ok: true, status: res.status, data: data };
    } catch (error) {
      return { ok: false, offline: true, error: "网络不可用：" + (error && error.message ? error.message : error) };
    }
  }

  /* ---------- 账号 ---------- */

  /* 把 GoTrue 返回的一坨转成我们自己的会话结构 */
  function toSession(data) {
    const d = data || {};
    const user = d.user || {};
    const meta = user.user_metadata || {};
    return {
      accessToken: d.access_token || "",
      refreshToken: d.refresh_token || "",
      expiresAt: Date.now() + (Number(d.expires_in) || 3600) * 1000,
      userId: user.id || "",
      email: user.email || "",
      nickname: meta.nickname || ""
    };
  }

  async function signUp(email, password, nickname) {
    const body = { email: email, password: password };
    if (nickname) body.data = { nickname: nickname };

    const r = await call("/auth/v1/signup", { method: "POST", body: body });
    if (!r.ok) return { ok: false, offline: r.offline, error: r.error };

    /* 开了邮箱确认时只返回用户信息、没有会话 */
    if (r.data && r.data.access_token) return { ok: true, session: toSession(r.data) };
    return { ok: true, needConfirm: true };
  }

  async function signIn(email, password) {
    const r = await call("/auth/v1/token?grant_type=password", {
      method: "POST",
      body: { email: email, password: password }
    });
    if (!r.ok) return { ok: false, offline: r.offline, error: r.error };
    return { ok: true, session: toSession(r.data) };
  }

  async function refreshSession(refreshToken) {
    const r = await call("/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      body: { refresh_token: refreshToken }
    });
    if (!r.ok) return { ok: false, offline: r.offline, error: r.error };
    return { ok: true, session: toSession(r.data) };
  }

  async function signOut(accessToken) {
    const r = await call("/auth/v1/logout", { method: "POST", auth: accessToken });
    /* 服务端登出失败也要让本地清掉，不能把人卡在登录态里 */
    return { ok: true, error: r.ok ? "" : r.error };
  }

  /* ---------- 我的数据 ---------- */

  async function me(accessToken) {
    const results = await Promise.all([
      call("/rest/v1/profiles?select=nickname,points&limit=1", { auth: accessToken }),
      call("/rest/v1/inventory?select=item_code,count", { auth: accessToken })
    ]);

    const profile = results[0];
    if (!profile.ok) return { ok: false, offline: profile.offline, error: profile.error };

    const row = (profile.data && profile.data[0]) || {};
    const inv = results[1].ok && Array.isArray(results[1].data) ? results[1].data : [];

    return {
      ok: true,
      data: {
        nickname: row.nickname || "",
        points: Number(row.points) || 0,
        inventory: inv.map(function (it) {
          return { code: it.item_code, count: Number(it.count) || 0 };
        })
      }
    };
  }

  /*
   * 改昵称。
   * 服务端对这一列单独开了 update 权限（其余列一律不可写），
   * 所以这里只能改 nickname，改分数是改不动的。
   */
  async function updateNickname(accessToken, userId, nickname) {
    const r = await call("/rest/v1/profiles?id=eq." + encodeURIComponent(userId), {
      method: "PATCH",
      auth: accessToken,
      headers: { Prefer: "return=representation" },
      body: { nickname: nickname }
    });
    if (!r.ok) return { ok: false, offline: r.offline, error: r.error };

    const row = (Array.isArray(r.data) && r.data[0]) || null;
    return { ok: true, data: { nickname: (row && row.nickname) || nickname } };
  }

  /*
   * 上传一批答题流水让服务端复核。
   * items 形如 [{ id, mode, choice, ms }]；
   * batch 是这一批的批次号，服务端靠它做幂等，重复上传不会重复入账。
   */
  async function syncRuns(accessToken, items, batch) {
    const r = await call("/rest/v1/rpc/sync_runs", {
      method: "POST",
      auth: accessToken,
      body: { p_items: items, p_batch: batch }
    });
    if (!r.ok) return { ok: false, offline: r.offline, error: r.error };
    return { ok: true, data: r.data };
  }

  /* ---------- 商店 ---------- */

  async function shopItems(accessToken) {
    const r = await call("/rest/v1/items?select=code,name,descr,category,price,payload&active=eq.true&order=price.asc", {
      auth: accessToken
    });
    if (!r.ok) return { ok: false, offline: r.offline, error: r.error };
    return { ok: true, data: Array.isArray(r.data) ? r.data : [] };
  }

  async function buyItem(accessToken, code) {
    const r = await call("/rest/v1/rpc/buy_item", {
      method: "POST",
      auth: accessToken,
      body: { p_code: code }
    });
    if (!r.ok) return { ok: false, offline: r.offline, error: r.error };
    return { ok: true, data: r.data };
  }

  async function useItem(accessToken, code) {
    const r = await call("/rest/v1/rpc/use_item", {
      method: "POST",
      auth: accessToken,
      body: { p_code: code }
    });
    if (!r.ok) return { ok: false, offline: r.offline, error: r.error };
    return { ok: true, data: r.data };
  }

  return {
    configured: configured,
    setFetch: setFetch,
    friendly: friendly,
    signUp: signUp,
    signIn: signIn,
    refreshSession: refreshSession,
    signOut: signOut,
    me: me,
    updateNickname: updateNickname,
    syncRuns: syncRuns,
    shopItems: shopItems,
    buyItem: buyItem,
    useItem: useItem
  };
})();
