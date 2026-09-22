const http = require("http");
const store = require("./store");
const rules = require("./rules");

const PORT = Number(process.env.PORT || 3021);

const routes = [
  "GET /health",
  "GET /clocks",
  "POST /clocks",
  "GET /clocks/not-qualified",
  "GET /clocks/:id/history",
  "POST /clocks/:id/adjustments",
  "POST /clocks/:id/retests",
  "GET /clocks/:id/latest-retest",
  "GET /adjustments",
  "GET /retests",
  "POST /clocks/:id/stop-oil-orders",
  "GET /clocks/:id/stop-oil-orders",
  "GET /stop-oil-orders",
  "GET /stop-oil-orders/:id",
  "POST /stop-oil-orders/:id/reviews",
  "POST /stop-oil-orders/:id/corrections",
  "POST /stop-oil-orders/:id/part-replacements"
];

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function findClock(db, clockId) {
  const clock = db.clocks.find((item) => item.id === clockId);
  if (!clock) {
    const error = new Error("钟表不存在");
    error.status = 404;
    throw error;
  }
  return clock;
}

function latestRetest(db, clockId) {
  return db.retests
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.testedAt) - new Date(a.testedAt))[0] || null;
}

function latestAdjustment(db, clockId) {
  return db.adjustments
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}

function clockSummary(db, clock) {
  const retest = latestRetest(db, clock.id);
  const adjustment = latestAdjustment(db, clock.id);
  const openStopOilOrder = rules.findOpenOrder(db, clock.id);
  return {
    ...clock,
    latestAdjustment: adjustment,
    latestRetest: retest,
    qualified: retest ? retest.qualified : false,
    openStopOilOrder: openStopOilOrder ? rules.summarizeOrder(openStopOilOrder) : null,
    adjustmentAllowed: !openStopOilOrder
  };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "clock-escapement-tuning-api", routes });
  }

  if (req.method === "GET" && pathname === "/clocks") {
    const db = await store.readDb();
    const qualified = url.searchParams.get("qualified");
    let data = db.clocks.map((clock) => clockSummary(db, clock));
    if (qualified !== null) {
      const expected = qualified === "true";
      data = data.filter((clock) => clock.qualified === expected);
    }
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/clocks") {
    const body = await parseBody(req);
    required(body, ["code", "escapementType", "balanceFrequency"]);
    const result = await store.transact(async (db) => {
      const clock = {
        id: store.makeId("clock"),
        code: body.code,
        escapementType: body.escapementType,
        balanceFrequency: body.balanceFrequency,
        targetDailyRateSeconds: Number(body.targetDailyRateSeconds ?? 30),
        note: body.note || "",
        createdAt: new Date().toISOString()
      };
      db.clocks.push(clock);
      return clockSummary(db, clock);
    });
    return send(res, 201, { data: result });
  }

  if (req.method === "GET" && pathname === "/clocks/not-qualified") {
    const db = await store.readDb();
    const data = db.clocks.map((clock) => clockSummary(db, clock)).filter((clock) => !clock.qualified);
    return send(res, 200, { data });
  }

  const historyMatch = pathname.match(/^\/clocks\/([^/]+)\/history$/);
  if (historyMatch && req.method === "GET") {
    const db = await store.readDb();
    const clock = findClock(db, historyMatch[1]);
    const adjustments = db.adjustments.filter((item) => item.clockId === clock.id);
    const retests = db.retests.filter((item) => item.clockId === clock.id);
    return send(res, 200, { data: { clock, adjustments, retests, latestRetest: latestRetest(db, clock.id) } });
  }

  const adjustmentMatch = pathname.match(/^\/clocks\/([^/]+)\/adjustments$/);
  if (adjustmentMatch && req.method === "POST") {
    const body = await parseBody(req);
    required(body, ["currentDailyRateSeconds", "direction", "amount"]);
    const result = await store.transact(async (db) => {
      const clock = findClock(db, adjustmentMatch[1]);
      rules.assertAdjustmentAllowed(db, clock.id);
      const adjustment = {
        id: store.makeId("adjustment"),
        clockId: clock.id,
        currentDailyRateSeconds: Number(body.currentDailyRateSeconds),
        direction: body.direction,
        amount: body.amount,
        note: body.note || "",
        createdAt: new Date().toISOString()
      };
      db.adjustments.push(adjustment);
      return { adjustment, clock: clockSummary(db, clock) };
    });
    return send(res, 201, { data: result.adjustment, clock: result.clock });
  }

  const retestMatch = pathname.match(/^\/clocks\/([^/]+)\/retests$/);
  if (retestMatch && req.method === "POST") {
    const body = await parseBody(req);
    required(body, ["dailyRateSeconds", "amplitude"]);
    const result = await store.transact(async (db) => {
      const clock = findClock(db, retestMatch[1]);
      const adjustmentId = body.adjustmentId || latestAdjustment(db, clock.id)?.id || null;
      const qualified = body.qualified !== undefined
        ? Boolean(body.qualified)
        : Math.abs(Number(body.dailyRateSeconds)) <= Number(clock.targetDailyRateSeconds);
      const retest = {
        id: store.makeId("retest"),
        clockId: clock.id,
        adjustmentId,
        testedAt: body.testedAt || new Date().toISOString(),
        dailyRateSeconds: Number(body.dailyRateSeconds),
        amplitude: Number(body.amplitude),
        qualified,
        note: body.note || ""
      };
      db.retests.push(retest);
      return { retest, clock: clockSummary(db, clock) };
    });
    return send(res, 201, { data: result.retest, clock: result.clock });
  }

  const latestMatch = pathname.match(/^\/clocks\/([^/]+)\/latest-retest$/);
  if (latestMatch && req.method === "GET") {
    const db = await store.readDb();
    findClock(db, latestMatch[1]);
    return send(res, 200, { data: latestRetest(db, latestMatch[1]) });
  }

  if (req.method === "GET" && pathname === "/adjustments") {
    const db = await store.readDb();
    const clockId = url.searchParams.get("clockId");
    return send(res, 200, { data: db.adjustments.filter((item) => !clockId || item.clockId === clockId) });
  }

  if (req.method === "GET" && pathname === "/retests") {
    const db = await store.readDb();
    const clockId = url.searchParams.get("clockId");
    const qualified = url.searchParams.get("qualified");
    const data = db.retests.filter((item) => {
      const matchClock = !clockId || item.clockId === clockId;
      const matchQualified = qualified === null || item.qualified === (qualified === "true");
      return matchClock && matchQualified;
    });
    return send(res, 200, { data });
  }

  // 登记停油单：每表仅一张未结束停油单，重复或并发沿用首次
  const stopOilCreateMatch = pathname.match(/^\/clocks\/([^/]+)\/stop-oil-orders$/);
  if (stopOilCreateMatch && req.method === "POST") {
    const body = await parseBody(req);
    const result = await store.transact(async (db) => {
      const clock = findClock(db, stopOilCreateMatch[1]);
      return rules.createStopOilOrder(db, clock, body);
    });
    return send(res, result.reused ? 200 : 201, {
      data: rules.summarizeOrder(result.order),
      reused: result.reused
    });
  }

  // 停油履历：某只表的全部停油单（含已放行）
  if (stopOilCreateMatch && req.method === "GET") {
    const db = await store.readDb();
    const clock = findClock(db, stopOilCreateMatch[1]);
    const data = db.stopOilOrders
      .filter((order) => order.clockId === clock.id)
      .map((order) => rules.summarizeOrder(order));
    return send(res, 200, { data });
  }

  // 停油单列表：刷新后与履历、详情一致
  if (req.method === "GET" && pathname === "/stop-oil-orders") {
    const db = await store.readDb();
    const clockId = url.searchParams.get("clockId");
    const status = url.searchParams.get("status");
    const open = url.searchParams.get("open");
    const data = db.stopOilOrders
      .filter((order) => !clockId || order.clockId === clockId)
      .filter((order) => !status || order.status === status)
      .filter((order) => open === null || (open === "true") === (order.status !== rules.STATUS.RELEASED))
      .map((order) => rules.summarizeOrder(order));
    return send(res, 200, { data });
  }

  const stopOilDetailMatch = pathname.match(/^\/stop-oil-orders\/([^/]+)$/);
  if (stopOilDetailMatch && req.method === "GET") {
    const db = await store.readDb();
    const order = rules.findOrder(db, stopOilDetailMatch[1]);
    const versions = db.stopOilOrderVersions.filter((item) => item.orderId === order.id);
    return send(res, 200, { data: { ...rules.summarizeOrder(order), archivedVersions: versions } });
  }

  const reviewMatch = pathname.match(/^\/stop-oil-orders\/([^/]+)\/reviews$/);
  if (reviewMatch && req.method === "POST") {
    const body = await parseBody(req);
    const result = await store.transact(async (db) => {
      const order = rules.findOrder(db, reviewMatch[1]);
      return rules.addReview(db, order, body);
    });
    return send(res, result.reused ? 200 : 201, {
      data: result.review,
      order: rules.summarizeOrder(result.order),
      reused: result.reused
    });
  }

  const correctionMatch = pathname.match(/^\/stop-oil-orders\/([^/]+)\/corrections$/);
  if (correctionMatch && req.method === "POST") {
    const body = await parseBody(req);
    const order = await store.transact(async (db) =>
      rules.correctOilAmount(db, rules.findOrder(db, correctionMatch[1]), body)
    );
    return send(res, 200, { data: rules.summarizeOrder(order) });
  }

  const partMatch = pathname.match(/^\/stop-oil-orders\/([^/]+)\/part-replacements$/);
  if (partMatch && req.method === "POST") {
    const body = await parseBody(req);
    const order = await store.transact(async (db) =>
      rules.replacePart(db, rules.findOrder(db, partMatch[1]), body)
    );
    return send(res, 200, { data: rules.summarizeOrder(order) });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

server.listen(PORT, () => {
  console.log(`Clock escapement tuning API running at http://127.0.0.1:${PORT}`);
});
