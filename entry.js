const http = require("http");
const store = require("./store");
const rules = require("./rules");

const routes = [
  "GET /health",
  "GET /clocks",
  "POST /clocks",
  "GET /clocks/not-qualified",
  "GET /clocks/:id/history",
  "POST /clocks/:id/adjustments（须油膜复核通过）",
  "POST /clocks/:id/retests",
  "GET /clocks/:id/latest-retest",
  "GET /clocks/:id/oil-stops",
  "POST /clocks/:id/oil-stops（登记停油；重复/并发沿用首次）",
  "GET /adjustments?clockId=",
  "GET /retests?clockId=&qualified=",
  "GET /oil-stops?clockId=&status=",
  "GET /oil-stops/:id（含历次版本留档与复检履历）",
  "POST /oil-stops/:id/correct（更正油量，复核作废重算）",
  "POST /oil-stops/:id/parts（换件，复核作废重算）",
  "POST /oil-stops/:id/rechecks（满24h由他人复检，间隔6h两次）",
  "POST /oil-stops/:id/close（收单，释放该表）"
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
    throw rules.httpError(400, "请求体必须是合法JSON");
  }
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
  const oilStop = rules.findOpenOilStop(db, clock.id);
  const review = oilStop ? rules.evaluate(oilStop) : null;
  return {
    ...clock,
    latestAdjustment: latestAdjustment(db, clock.id),
    latestRetest: retest,
    qualified: retest ? retest.qualified : false,
    oilStop: oilStop ? rules.orderView(oilStop) : null,
    tunable: review ? review.tunable : false
  };
}

function ctx(body) {
  return { now: (body && body.now) || new Date().toISOString(), makeId: rules.makeId };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = await store.readAll();
  const now = new Date().toISOString();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "clock-escapement-oil-stop-api", routes });
  }

  if (req.method === "GET" && pathname === "/clocks") {
    const qualified = url.searchParams.get("qualified");
    let data = db.clocks.map((clock) => clockSummary(db, clock));
    if (qualified !== null) data = data.filter((clock) => clock.qualified === (qualified === "true"));
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/clocks") {
    const body = await parseBody(req);
    rules.requireFields(body, ["code", "escapementType", "balanceFrequency"]);
    return store.mutate((draft) => {
      const clock = {
        id: rules.makeId("clock"),
        code: body.code,
        escapementType: body.escapementType,
        balanceFrequency: body.balanceFrequency,
        targetDailyRateSeconds: Number(body.targetDailyRateSeconds ?? 30),
        note: body.note || "",
        createdAt: new Date().toISOString()
      };
      draft.clocks.push(clock);
      return send(res, 201, { data: clockSummary(draft, clock) });
    });
  }

  if (req.method === "GET" && pathname === "/clocks/not-qualified") {
    const data = db.clocks.map((clock) => clockSummary(db, clock)).filter((clock) => !clock.qualified);
    return send(res, 200, { data });
  }

  const historyMatch = pathname.match(/^\/clocks\/([^/]+)\/history$/);
  if (historyMatch && req.method === "GET") {
    const clock = rules.getClock(db, historyMatch[1]);
    const oilStops = db.oilStops
      .filter((item) => item.clockId === clock.id)
      .map((order) => rules.orderView(order))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return send(res, 200, {
      data: {
        clock,
        adjustments: db.adjustments.filter((item) => item.clockId === clock.id),
        retests: db.retests.filter((item) => item.clockId === clock.id),
        oilStops,
        activeOilStop: oilStops.find((item) => !item.closedAt) || null,
        latestRetest: latestRetest(db, clock.id)
      }
    });
  }

  // 登记停油（每表仅一张未结束单；重复或并发沿用首次）
  const oilStopsMatch = pathname.match(/^\/clocks\/([^/]+)\/oil-stops$/);
  if (oilStopsMatch) {
    const clockId = oilStopsMatch[1];
    if (req.method === "GET") {
      rules.getClock(db, clockId);
      const data = db.oilStops
        .filter((item) => item.clockId === clockId)
        .map((order) => rules.orderView(order))
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      return send(res, 200, { data });
    }
    if (req.method === "POST") {
      const body = await parseBody(req);
      return store.mutate((draft) => {
        const result = rules.registerOilStop(draft, clockId, body, ctx(body));
        return send(res, result.duplicated ? 200 : 201, {
          data: result.order,
          duplicated: result.duplicated,
          message: result.duplicated ? "该表已有未结束停油单，沿用首次登记" : undefined
        });
      });
    }
  }

  const adjustmentMatch = pathname.match(/^\/clocks\/([^/]+)\/adjustments$/);
  if (adjustmentMatch && req.method === "POST") {
    const clockId = adjustmentMatch[1];
    const body = await parseBody(req);
    rules.requireFields(body, ["currentDailyRateSeconds", "direction", "amount"]);
    return store.mutate((draft) => {
      rules.assertTunable(draft, clockId, ctx(body)); // 闸门：油膜两次复检不越界才准调校
      const adjustment = {
        id: rules.makeId("adjustment"),
        clockId,
        currentDailyRateSeconds: Number(body.currentDailyRateSeconds),
        direction: body.direction,
        amount: body.amount,
        note: body.note || "",
        createdAt: new Date().toISOString()
      };
      draft.adjustments.push(adjustment);
      return send(res, 201, { data: adjustment });
    });
  }

  const retestMatch = pathname.match(/^\/clocks\/([^/]+)\/retests$/);
  if (retestMatch && req.method === "POST") {
    const clockId = retestMatch[1];
    const body = await parseBody(req);
    rules.requireFields(body, ["dailyRateSeconds", "amplitude"]);
    return store.mutate((draft) => {
      const clock = rules.getClock(draft, clockId);
      const adjustmentId = body.adjustmentId || latestAdjustment(draft, clock.id)?.id || null;
      const qualified = body.qualified !== undefined
        ? Boolean(body.qualified)
        : Math.abs(Number(body.dailyRateSeconds)) <= Number(clock.targetDailyRateSeconds);
      const retest = {
        id: rules.makeId("retest"),
        clockId: clock.id,
        adjustmentId,
        testedAt: body.testedAt || new Date().toISOString(),
        dailyRateSeconds: Number(body.dailyRateSeconds),
        amplitude: Number(body.amplitude),
        qualified,
        note: body.note || ""
      };
      draft.retests.push(retest);
      return send(res, 201, { data: retest, clock: clockSummary(draft, clock) });
    });
  }

  const latestMatch = pathname.match(/^\/clocks\/([^/]+)\/latest-retest$/);
  if (latestMatch && req.method === "GET") {
    rules.getClock(db, latestMatch[1]);
    return send(res, 200, { data: latestRetest(db, latestMatch[1]) });
  }

  if (req.method === "GET" && pathname === "/oil-stops") {
    const clockId = url.searchParams.get("clockId");
    const status = url.searchParams.get("status");
    const activeOnly = url.searchParams.get("active") === "true";
    let data = db.oilStops
      .filter((item) => !clockId || item.clockId === clockId)
      .map((order) => rules.orderView(order))
      .filter((order) => !activeOnly || !order.closedAt)
      .filter((order) => !status || order.status === status)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return send(res, 200, { data });
  }

  const oilStopMatch = pathname.match(/^\/oil-stops\/([^/]+)$/);
  if (oilStopMatch && req.method === "GET") {
    const order = rules.getOilStop(db, oilStopMatch[1]);
    return send(res, 200, { data: rules.orderView(order) });
  }

  const correctMatch = pathname.match(/^\/oil-stops\/([^/]+)\/correct$/);
  if (correctMatch && req.method === "POST") {
    const body = await parseBody(req);
    return store.mutate((draft) => {
      const result = rules.correctOilStop(draft, correctMatch[1], body, ctx(body));
      return send(res, 200, {
        data: result.order,
        invalidated: true,
        message: "油量已更正，旧版留档，原复检作废，24小时重新起算"
      });
    });
  }

  const partMatch = pathname.match(/^\/oil-stops\/([^/]+)\/parts$/);
  if (partMatch && req.method === "POST") {
    const body = await parseBody(req);
    return store.mutate((draft) => {
      const result = rules.replacePart(draft, partMatch[1], body, ctx(body));
      return send(res, 200, {
        data: result.order,
        invalidated: true,
        message: "已登记换件，旧版留档，原复检作废，24小时重新起算"
      });
    });
  }

  const recheckOilMatch = pathname.match(/^\/oil-stops\/([^/]+)\/rechecks$/);
  if (recheckOilMatch && req.method === "POST") {
    const body = await parseBody(req);
    return store.mutate((draft) => {
      const result = rules.submitRecheck(draft, recheckOilMatch[1], body, ctx(body));
      return send(res, result.duplicated ? 200 : 201, {
        data: result.order,
        recheck: result.recheck,
        duplicated: result.duplicated,
        passed: Boolean(result.passed),
        message: result.duplicated
          ? "重复复检，沿用首次记录"
          : result.passed
            ? "油膜连续两次不越界，复核通过，准调校"
            : result.order.status === rules.STATUS.BLOCKED
              ? "油膜越界，复核链清零，停油单继续占位"
              : undefined
      });
    });
  }

  const closeMatch = pathname.match(/^\/oil-stops\/([^/]+)\/close$/);
  if (closeMatch && req.method === "POST") {
    const body = await parseBody(req);
    return store.mutate((draft) => {
      const result = rules.closeOilStop(draft, closeMatch[1], body, ctx(body));
      return send(res, 200, {
        data: result.order,
        duplicated: result.duplicated,
        message: result.duplicated ? "停油单已结束，沿用首次收单" : "停油单已收单，该表可重新登记停油"
      });
    });
  }

  if (req.method === "GET" && pathname === "/adjustments") {
    const clockId = url.searchParams.get("clockId");
    return send(res, 200, { data: db.adjustments.filter((item) => !clockId || item.clockId === clockId) });
  }

  if (req.method === "GET" && pathname === "/retests") {
    const clockId = url.searchParams.get("clockId");
    const qualified = url.searchParams.get("qualified");
    const data = db.retests.filter((item) => {
      const matchClock = !clockId || item.clockId === clockId;
      const matchQualified = qualified === null || item.qualified === (qualified === "true");
      return matchClock && matchQualified;
    });
    return send(res, 200, { data });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    send(res, error.status || 500, { error: error.message || "服务器错误", ...(error.earliestRecheckAt ? { earliestRecheckAt: error.earliestRecheckAt } : {}), ...(error.oilStop ? { oilStop: error.oilStop } : {}) });
  });
});

module.exports = { server, routes };
