/*
 * 本地持久化层。
 *
 * 这里存两类东西：
 *   1. 答题流水（answers）—— 每答一题记一条，是同步给服务端"对账"用的凭据；
 *   2. 服务端状态的只读缓存（cache）—— 上次同步拿到的余额、昵称、已拥有物品。
 *
 * 注意这里故意 **不保存"权威分数"**：本地显示的积分 = 服务端缓存 + 本地待结算，
 * 其中"本地待结算"是从还没上传的流水里算出来的。真正的分数永远由服务端复核后给出。
 * 这样未登录、断网也能玩、分数也不丢，同时客户端改不了服务端的余额。
 */
const Store = (function () {
  const KEY = "lty.state.v1";
  const VERSION = 1;

  /* 待上传流水最多留这么多条，超了丢最旧的，免得把本地存储撑爆 */
  const MAX_PENDING = 2000;

  /* 浏览器禁用存储（隐私模式等）时退化成内存，至少本次会话内不丢 */
  let memory = null;

  const usable = (function () {
    try {
      const probe = "__lty_probe__";
      window.localStorage.setItem(probe, "1");
      window.localStorage.removeItem(probe);
      return true;
    } catch (error) {
      return false;
    }
  })();

  function randomId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function fresh() {
    return {
      v: VERSION,
      anonId: randomId(),   /* 未登录时的本机身份，换个浏览器就不同 */
      seq: 0,               /* 流水自增键：同步时靠它精确删除已提交的那几条 */
      session: null,        /* 登录态：token 与账号信息 */
      answers: [],          /* 待上传的答题流水 */
      pendingPoints: 0,     /* 流水里已判定、还没被服务端确认的积分 */
      cache: null           /* 上次同步拿到的服务端状态 */
    };
  }

  function load() {
    if (!usable) {
      if (!memory) memory = fresh();
      return memory;
    }
    try {
      const raw = window.localStorage.getItem(KEY);
      if (!raw) return fresh();

      const parsed = JSON.parse(raw);
      if (!parsed || parsed.v !== VERSION) return fresh();

      /* 逐字段兜底：不能因为旧数据缺个字段就把整个游戏带崩 */
      const base = fresh();
      base.anonId = parsed.anonId || base.anonId;
      base.seq = Number(parsed.seq) || 0;
      base.session = parsed.session || null;
      base.answers = Array.isArray(parsed.answers) ? parsed.answers : [];
      base.pendingPoints = Number(parsed.pendingPoints) || 0;
      base.cache = parsed.cache || null;
      return base;
    } catch (error) {
      /* 数据坏了就当新用户 */
      return fresh();
    }
  }

  let state = load();

  function save() {
    if (!usable) { memory = state; return; }
    try {
      window.localStorage.setItem(KEY, JSON.stringify(state));
    } catch (error) {
      /* 写不进去就只留在内存里，不影响本次游玩 */
    }
  }

  /* ---------- 只读查询 ---------- */

  /* 界面上显示的积分：服务端确认过的 + 本地待结算的 */
  function points() {
    const settled = state.cache && typeof state.cache.points === "number" ? state.cache.points : 0;
    return settled + state.pendingPoints;
  }

  function isLoggedIn() {
    return !!(state.session && state.session.accessToken);
  }

  function nickname() {
    if (state.session && state.session.nickname) return state.session.nickname;
    if (state.cache && state.cache.nickname) return state.cache.nickname;
    return "未命名锦依卫";
  }

  function inventory() {
    return (state.cache && state.cache.inventory) || [];
  }

  function pendingCount() {
    return state.answers.length;
  }

  function session() {
    return state.session;
  }

  function anonId() {
    return state.anonId;
  }

  /* ---------- 写入 ---------- */

  function setSession(next) {
    state.session = next || null;
    save();
  }

  function clearSession() {
    state.session = null;
    save();
  }

  /* token 快过期时刷新用 */
  function updateTokens(accessToken, refreshToken, expiresAt) {
    if (!state.session) return;
    state.session.accessToken = accessToken;
    state.session.refreshToken = refreshToken;
    state.session.expiresAt = expiresAt;
    save();
  }

  /*
   * 记一条答题流水。
   * rec 形如 { id, mode, choice, ms }，delta 是这题本地判定的得分（答错传 0）。
   * rec.id 必须是真的题目指纹，服务端要用它查题库复核。
   * 返回这条流水的键，同步成功后拿它来删除。
   */
  function logAnswer(rec, delta) {
    state.seq = (state.seq || 0) + 1;
    rec.k = state.seq;
    rec.at = Date.now();
    state.answers.push(rec);

    if (state.answers.length > MAX_PENDING) {
      state.answers.splice(0, state.answers.length - MAX_PENDING);
    }
    if (delta > 0) state.pendingPoints += delta;

    save();
    return rec.k;
  }

  /* 取一份待上传流水的快照（不清空，同步成功后才按键清） */
  function pendingAnswers() {
    return state.answers.slice();
  }

  /*
   * 同步成功后的收尾：把已经交给服务端的那批流水按键删掉，
   * 并把服务端给出的权威余额写进缓存。
   * 按键删而不是清空整个数组，才不会误删同步过程中新答出来的流水。
   */
  function confirmSync(sentKeys, serverPoints) {
    if (sentKeys && sentKeys.length) {
      const done = {};
      sentKeys.forEach(function (k) { done[k] = true; });
      state.answers = state.answers.filter(function (rec) { return !done[rec.k]; });
    }
    state.pendingPoints = 0;

    if (typeof serverPoints === "number") {
      state.cache = state.cache || {};
      state.cache.points = serverPoints;
    }
    save();
  }

  /* 把从服务端拿到的账号状态写进缓存 */
  function setCache(data) {
    state.cache = data || null;
    save();
  }

  /* 全部清空 */
  function reset() {
    state = fresh();
    save();
  }

  return {
    usable: usable,
    points: points,
    isLoggedIn: isLoggedIn,
    nickname: nickname,
    inventory: inventory,
    pendingCount: pendingCount,
    session: session,
    anonId: anonId,
    setSession: setSession,
    clearSession: clearSession,
    updateTokens: updateTokens,
    logAnswer: logAnswer,
    pendingAnswers: pendingAnswers,
    confirmSync: confirmSync,
    setCache: setCache,
    reset: reset
  };
})();
