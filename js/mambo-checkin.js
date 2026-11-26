// Mambo (mambo-hachimi.biliblili.uk) 自动签到 for Surge
// 流程: 查状态 -> 已签到结束 -> Peak 解 Turnstile -> 签到; 登录态过期则先 Peak 解题重新登录
// 参数由模块面板传入 ($argument 为 & 分隔字符串)

const STORE_KEY = "mambo_checkin_store_v1";
const BASE = "https://mambo-hachimi.biliblili.uk";
const FALLBACK_SITEKEY = "0x4AAAAAAB5_0tUcL7Homqv5";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0.1 Mobile/15E148 Safari/604.1";

// ---------- 参数解析 ----------
function parseArgs(str) {
  const out = {};
  if (!str) return out;
  str.split("&").forEach(function (pair) {
    const i = pair.indexOf("=");
    if (i > 0) out[pair.slice(0, i)] = decodeURIComponent(pair.slice(i + 1) || "");
  });
  return out;
}
const args = parseArgs(typeof $argument !== "undefined" ? $argument : "");
function val(x) {
  const s = (x || "").trim();
  return s === "none" ? "" : s; // 面板里 none 表示留空 (Surge 参数声明不允许空默认值)
}
const CFG = {
  username: val(args.username),
  password: val(args.password),
  peakKey: val(args.peak_key),
  peakTaskType: val(args.peak_task_type) || "TurnstileTaskProxyLess",
  peakProxy: val(args.peak_proxy),
  extraCookie: val(args.extra_cookie),
  notifyMode: val(args.notify_mode) || "all", // all = 成功也通知, fail = 仅失败通知
};

// ---------- 存储 ----------
function loadStore() {
  try {
    const raw = $persistentStore.read(STORE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}
function saveStore(obj) {
  $persistentStore.write(JSON.stringify(obj), STORE_KEY);
}

// ---------- HTTP (Promise 包装 $httpClient) ----------
function http(options) {
  return new Promise(function (resolve, reject) {
    const method = (options.method || "GET").toLowerCase();
    const fn = $httpClient[method] || $httpClient.get;
    fn(options, function (error, response, data) {
      if (error) return reject(new Error(String(error)));
      let body = data;
      try { body = JSON.parse(data); } catch (e) { /* 非 JSON 保持原文 */ }
      resolve({ status: response && response.status, headers: (response && response.headers) || {}, body: body, raw: data });
    });
  });
}

function siteHeaders(extra) {
  const h = {
    "User-Agent": UA,
    "Accept": "*/*",
    "Content-Type": "application/json",
    "Origin": BASE,
    "Referer": BASE + "/dashboard",
    "Accept-Language": "zh-CN,zh-Hans;q=0.9",
  };
  if (CFG.extraCookie) h["Cookie"] = CFG.extraCookie;
  return Object.assign(h, extra || {});
}

// ---------- JWT 过期判断 (纯 JS base64url 解码 payload) ----------
function b64urlDecode(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "====".slice(b64.length % 4);
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  let bits = 0, val = 0;
  const s = (b64 + pad).replace(/=+$/, "");
  for (let i = 0; i < s.length; i++) {
    const idx = chars.indexOf(s[i]);
    if (idx < 0) continue;
    val = (val << 6) | idx; bits += 6;
    if (bits >= 8) { bits -= 8; out += String.fromCharCode((val >> bits) & 0xff); }
  }
  return out;
}
function jwtValid(token) {
  if (!token) return false;
  try {
    const parts = token.split(".");
    const payload = JSON.parse(b64urlDecode(parts[1]));
    // 提前 1 小时视为过期, 留出重新登录余量
    return payload.exp && payload.exp * 1000 - Date.now() > 3600 * 1000;
  } catch (e) {
    return false;
  }
}

// ---------- Peak 解题 ----------
async function solveTurnstile(pageUrl, sitekey) {
  const payload = {
    task_type: CFG.peakTaskType,
    url: pageUrl,
    sitekey: sitekey,
  };
  if (CFG.peakProxy) payload.proxy = CFG.peakProxy;
  const res = await http({
    method: "POST",
    url: "https://api.peak.fo/solve",
    headers: { "X-API-Key": CFG.peakKey, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    timeout: 60,
  });
  if (res.body && res.body.success && res.body.data && res.body.data.token) {
    return res.body.data.token;
  }
  const code = res.body && res.body.error_code ? res.body.error_code : "unknown";
  const msg = res.body && res.body.error ? res.body.error : ("HTTP " + res.status);
  throw new Error("Peak 解题失败 [" + code + "]: " + msg);
}
async function solveWithRetry(pageUrl, sitekey) {
  try {
    return await solveTurnstile(pageUrl, sitekey);
  } catch (e) {
    console.log("Peak 首次失败, 重试一次: " + e.message);
    return await solveTurnstile(pageUrl, sitekey);
  }
}

// ---------- 站点接口 ----------
async function getSitekey() {
  try {
    const res = await http({ method: "GET", url: BASE + "/api/settings/verification/public", headers: siteHeaders(), timeout: 30 });
    if (res.body && res.body.checkin && res.body.checkin.siteKey) return res.body.checkin.siteKey;
    if (res.body && res.body.login && res.body.login.siteKey) return res.body.login.siteKey;
  } catch (e) {
    console.log("读取验证配置失败, 用内置 sitekey: " + e.message);
  }
  return FALLBACK_SITEKEY;
}

async function login(sitekey) {
  const token = await solveWithRetry(BASE + "/", sitekey);
  const res = await http({
    method: "POST",
    url: BASE + "/api/auth/login",
    headers: siteHeaders(),
    body: JSON.stringify({ userName: CFG.username, password: CFG.password, verificationToken: token }),
    timeout: 30,
  });
  if (res.body && res.body.token) {
    const store = loadStore();
    store.jwt = res.body.token;
    store.lastLogin = Date.now();
    saveStore(store);
    return res.body.token;
  }
  throw new Error("登录失败: " + (res.body && res.body.message ? res.body.message : "HTTP " + res.status));
}

async function getStatus(jwt) {
  const res = await http({
    method: "GET",
    url: BASE + "/api/checkin/status",
    headers: siteHeaders({ Authorization: "Bearer " + jwt }),
    timeout: 30,
  });
  if (res.status === 401) return { unauthorized: true };
  if (res.body && res.body.success) return res.body;
  throw new Error("查签到状态失败: HTTP " + res.status);
}

async function doCheckin(jwt, sitekey) {
  const token = await solveWithRetry(BASE + "/dashboard", sitekey);
  const res = await http({
    method: "POST",
    url: BASE + "/api/checkin",
    headers: siteHeaders({ Authorization: "Bearer " + jwt }),
    body: JSON.stringify({ verificationToken: token }),
    timeout: 30,
  });
  if (res.status === 401) return { unauthorized: true };
  if (res.body && res.body.success) return res.body;
  throw new Error("签到失败: " + (res.body && res.body.message ? res.body.message : "HTTP " + res.status));
}

// ---------- 通知 ----------
function notify(title, body, force) {
  if (CFG.notifyMode === "fail" && !force) {
    console.log(title + " - " + body);
    return;
  }
  $notification.post(title, "", body);
}

// ---------- 主流程 ----------
(async function main() {
  try {
    if (!CFG.username || !CFG.password) throw new Error("面板里还没填账号或密码");
    if (!CFG.peakKey) throw new Error("面板里还没填 Peak API Key");

    const sitekey = await getSitekey();
    let store = loadStore();
    let jwt = jwtValid(store.jwt) ? store.jwt : null;

    if (!jwt) {
      jwt = await login(sitekey);
      console.log("重新登录成功");
    }

    let status = await getStatus(jwt);
    if (status.unauthorized) {
      jwt = await login(sitekey);
      status = await getStatus(jwt);
      if (status.unauthorized) throw new Error("重新登录后仍无权限, 请检查账号密码");
    }
    if (status.hasCheckedInToday) {
      store = loadStore(); store.lastResult = "already"; store.lastRun = Date.now(); saveStore(store);
      notify("Mambo 签到", "今天已经签到过了", false);
      return;
    }

    let result = await doCheckin(jwt, sitekey);
    if (result.unauthorized) {
      jwt = await login(sitekey);
      result = await doCheckin(jwt, sitekey);
      if (result.unauthorized) throw new Error("签到时登录态失效且重登失败");
    }

    store = loadStore();
    store.lastResult = "success";
    store.lastRun = Date.now();
    store.lastAmount = result.amount;
    store.lastBalance = result.balance;
    saveStore(store);
    notify("Mambo 签到成功", "+" + result.amount + " " + (result.currencyUnit || "") + ", 余额 " + result.balance, false);
  } catch (e) {
    console.log("签到出错: " + e.message);
    const store = loadStore(); store.lastResult = "fail: " + e.message; store.lastRun = Date.now(); saveStore(store);
    notify("Mambo 签到失败", e.message, true);
  } finally {
    $done();
  }
})();
