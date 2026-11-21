import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getClaimablePointRewards,
  getDailyTaskStates,
  loadDailyTaskConfig,
  validateDailyTaskConfig,
} from "../src/utils/dailyTaskState.js";

function officialConfig() {
  return {
    DailyTaskConf: {
      1: { id: 1, completeCondition: 6, completeValue: 3 },
      8: { id: 8, completeCondition: 13, completeValue: 1 },
      9: { id: 9, completeCondition: 12, completeValue: 1 },
    },
    DayLimitConf: { 1: { id: 1, limit: 20 }, 2: { id: 2, limit: 40 } },
    WeekLimitConf: { 1: { id: 1, limit: 100 }, 2: { id: 2, limit: 200 } },
  };
}
function role(complete = {}) {
  return { dailyTask: { dailyTime: 1700000000, complete } };
}

test("server counters distinguish unfinished, completed-unclaimed and claimed", () => {
  const config = validateDailyTaskConfig(officialConfig());
  const states = getDailyTaskStates(role({ 6: 2, 13: 1, 12: -1 }), config);
  assert.equal(states[0].status, "pending");
  assert.equal(states[0].remaining, 1);
  assert.equal(states[1].status, "claimable");
  assert.equal(states[1].id, 8);
  assert.equal(states[2].status, "claimed");
  assert.equal(states[2].id, 9);
});

test("progress above target requires claiming, not repeating the action", () => {
  const states = getDailyTaskStates(
    role({ 6: 20 }),
    validateDailyTaskConfig(officialConfig()),
  );
  assert.equal(states[0].status, "claimable");
  assert.equal(states[0].remaining, 0);
});

test("an absent counter in a valid server map means zero; null does not", () => {
  const config = validateDailyTaskConfig(officialConfig());
  assert.equal(getDailyTaskStates(role(), config)[0].remaining, 3);
  assert.throws(
    () => getDailyTaskStates(role({ 6: null }), config),
    /进度无效/,
  );
});

test("missing or malformed server task data cannot be treated as completed", () => {
  const config = validateDailyTaskConfig(officialConfig());
  for (const input of [
    {},
    { dailyTask: {} },
    { dailyTask: { dailyTime: 1, complete: [] } },
  ]) {
    assert.throws(() => getDailyTaskStates(input, config), /列表不完整/);
  }
  for (const count of [-2, "3", 1.5])
    assert.throws(
      () => getDailyTaskStates(role({ 6: count }), config),
      /进度无效/,
    );
});

test("official targets are used instead of client hardcoded thresholds", () => {
  const raw = officialConfig();
  raw.DailyTaskConf[1].completeValue = 5;
  assert.equal(
    getDailyTaskStates(role({ 6: 3 }), validateDailyTaskConfig(raw))[0]
      .remaining,
    2,
  );
});

test("invalid or duplicate configuration stops execution", () => {
  const raw = officialConfig();
  raw.DailyTaskConf[8].completeCondition = 6;
  assert.throws(() => validateDailyTaskConfig(raw), /配置无效/);
  assert.throws(() => validateDailyTaskConfig({}), /配置无效/);
});

test("point reward selection uses server points and claimed map for daily and weekly rewards", () => {
  const config = validateDailyTaskConfig(officialConfig());
  const daily = {
    dailyPoint: 40,
    dailyReward: { 1: true },
    weekPoint: 150,
    weekReward: {},
  };
  assert.deepEqual(getClaimablePointRewards(daily, config.dailyRewards), [2]);
  assert.deepEqual(
    getClaimablePointRewards(daily, config.weeklyRewards, true),
    [1],
  );
  assert.throws(
    () => getClaimablePointRewards({ dailyPoint: 40 }, config.dailyRewards),
    /不完整/,
  );
  assert.throws(
    () =>
      getClaimablePointRewards(
        { dailyPoint: 40, dailyReward: { 1: "true" } },
        config.dailyRewards,
      ),
    /不完整/,
  );
});

test("config version is verified each run while immutable configuration requests are merged", async () => {
  let reads = 0;
  let versions = 0;
  const store = {
    async sendMessageWithPromise() {
      versions++;
      return { dataBundleVer: "test-config-merge" };
    },
  };
  const fetchConfig = async () => {
    reads++;
    return { ok: true, json: async () => officialConfig() };
  };
  const [a, b] = await Promise.all([
    loadDailyTaskConfig(store, "a", fetchConfig),
    loadDailyTaskConfig(store, "b", fetchConfig),
  ]);
  assert.equal(a, b);
  assert.equal(reads, 1);
  assert.equal(versions, 2);
});

test("failed config reads can be retried and unsafe versions are rejected", async () => {
  let attempt = 0;
  const store = {
    async sendMessageWithPromise() {
      return { dataBundleVer: "test-config-retry" };
    },
  };
  const fetchConfig = async () => ({
    ok: ++attempt > 1,
    json: async () => officialConfig(),
  });
  await assert.rejects(
    loadDailyTaskConfig(store, "a", fetchConfig),
    /读取失败/,
  );
  await loadDailyTaskConfig(store, "a", fetchConfig);
  assert.equal(attempt, 2);
  await assert.rejects(
    loadDailyTaskConfig(
      {
        async sendMessageWithPromise() {
          return { dataBundleVer: "../invalid" };
        },
      },
      "a",
      fetchConfig,
    ),
    /有效/,
  );
});

test("duplicate point-reward IDs are rejected before duplicate claims can be scheduled", () => {
  for (const name of ["DayLimitConf", "WeekLimitConf"]) {
    const config = officialConfig();
    config[name][2].id = config[name][1].id;
    assert.throws(() => validateDailyTaskConfig(config), /无效/);
  }
});

test("an evicted failed config request cannot remove a newer cached request for the same version", async () => {
  let rejectFirst;
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let readsA = 0;
  const store = {
    sendMessageWithPromise: async (id) => ({ dataBundleVer: id }),
  };
  const fetchConfig = async (url) => {
    if (url.includes("cache-race-a") && ++readsA === 1) {
      entered();
      return new Promise((resolve, reject) => {
        rejectFirst = reject;
      });
    }
    return { ok: true, json: async () => officialConfig() };
  };
  const first = loadDailyTaskConfig(store, "cache-race-a", fetchConfig);
  const rejected = assert.rejects(first, /first request failed/);
  await started;
  await loadDailyTaskConfig(store, "cache-race-b", fetchConfig);
  await loadDailyTaskConfig(store, "cache-race-a", fetchConfig);
  rejectFirst(new Error("first request failed"));
  await rejected;
  await loadDailyTaskConfig(store, "cache-race-a", fetchConfig);
  assert.equal(readsA, 2);
});

test("browser retries the same-origin CDN proxy when direct config fetch fails", async () => {
  const store = {
    async sendMessageWithPromise() {
      return { dataBundleVer: "proxy-fallback-version" };
    },
  };
  const originalFetch = globalThis.fetch;
  const hadWindow = Object.hasOwn(globalThis, "window");
  const originalWindow = globalThis.window;
  const urls = [];
  globalThis.window = {};
  globalThis.fetch = async (url) => {
    urls.push(url);
    if (
      typeof url === "string" &&
      url.startsWith("https://xxz-xyzw-res.hortorgames.com")
    )
      return { ok: false, status: 403, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => officialConfig() };
  };
  try {
    const config = await loadDailyTaskConfig(store, "proxy-fallback");
    assert.equal(config.tasks.length, 3);
    assert.deepEqual(urls, [
      "https://xxz-xyzw-res.hortorgames.com/data/proxy-fallback-version/config.json",
      "/api/res/data/proxy-fallback-version/config.json",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (hadWindow) globalThis.window = originalWindow;
    else delete globalThis.window;
  }
});

test("browser reports a clear error when both CDN paths are unreachable", async () => {
  const store = {
    async sendMessageWithPromise() {
      return { dataBundleVer: "unreachable-version" };
    },
  };
  const originalFetch = globalThis.fetch;
  const hadWindow = Object.hasOwn(globalThis, "window");
  const originalWindow = globalThis.window;
  globalThis.window = {};
  globalThis.fetch = async () => {
    throw new Error("Failed to fetch");
  };
  try {
    await assert.rejects(
      loadDailyTaskConfig(store, "unreachable"),
      /直连与同源代理 .* 均不可用/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (hadWindow) globalThis.window = originalWindow;
    else delete globalThis.window;
  }
});

test("config read failure reports the version and HTTP status for diagnosis", async () => {
  const store = {
    async sendMessageWithPromise() {
      return { dataBundleVer: "http-status-version" };
    },
  };
  await assert.rejects(
    loadDailyTaskConfig(store, "http-status", async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    })),
    /官方任务配置读取失败 \(版本 http-status-version HTTP 500\)/,
  );
});

test("a server version missing from the CDN falls back to the official manifest", async () => {
  const store = {
    async sendMessageWithPromise() {
      return { dataBundleVer: "stale-server-version" };
    },
  };
  const urls = [];
  const fetchConfig = async (url) => {
    urls.push(url);
    if (url.endsWith("/data/stale-server-version/config.json"))
      return { ok: false, status: 404, json: async () => ({}) };
    if (url.endsWith("/data/version.json"))
      return {
        ok: true,
        status: 200,
        json: async () => ({ version: "manifest-version" }),
      };
    if (url.endsWith("/data/manifest-version/config.json"))
      return { ok: true, status: 200, json: async () => officialConfig() };
    throw new Error(`unexpected URL ${url}`);
  };
  const config = await loadDailyTaskConfig(store, "stale-server", fetchConfig);
  assert.equal(config.tasks.length, 3);
  assert.deepEqual(urls, [
    "https://xxz-xyzw-res.hortorgames.com/data/stale-server-version/config.json",
    "https://xxz-xyzw-res.hortorgames.com/data/version.json",
    "https://xxz-xyzw-res.hortorgames.com/data/manifest-version/config.json",
  ]);
  // The fallback result is cached under the game-reported version, so the
  // failing lookup is not repeated on the next run.
  urls.length = 0;
  assert.equal(await loadDailyTaskConfig(store, "stale-server", fetchConfig), config);
  assert.deepEqual(urls, []);
});

test("a failed fallback reports both versions and the HTTP status", async () => {
  const store = {
    async sendMessageWithPromise() {
      return { dataBundleVer: "broken-server-version" };
    },
  };
  const fetchConfig = async (url) => {
    if (url.endsWith("/data/version.json"))
      return {
        ok: true,
        status: 200,
        json: async () => ({ version: "broken-manifest-version" }),
      };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  await assert.rejects(
    loadDailyTaskConfig(store, "broken-server", fetchConfig),
    /版本 broken-server-version → broken-manifest-version HTTP 404/,
  );
});

test("an invalid official manifest cannot silently become the config version", async () => {
  const store = {
    async sendMessageWithPromise() {
      return { dataBundleVer: "unsafe-server-version" };
    },
  };
  const fetchConfig = async (url) => {
    if (url.endsWith("/data/version.json"))
      return {
        ok: true,
        status: 200,
        json: async () => ({ version: "../invalid" }),
      };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  await assert.rejects(
    loadDailyTaskConfig(store, "unsafe-server", fetchConfig),
    /官方版本清单未提供可用替代版本/,
  );
});
