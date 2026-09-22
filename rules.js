// 擒纵润滑停油与油膜复核台 —— 纯业务规则，不碰 HTTP 与文件

const MIN_OIL_MICROLITERS = 0.02;
const MAX_OIL_MICROLITERS = 0.05;
const REST_HOURS = 24; // 停油静置满 24 小时方可首次复检
const RECHECK_INTERVAL_HOURS = 6; // 两次复检间隔 6 小时
const REQUIRED_PASS_RECHECKS = 2; // 油膜连续两次不越界才准调校

const STATUS = {
  PENDING_REPLENISH: "pending_replenish", // 待补油：油量越界
  RESTING: "resting", // 静置中：油量合规但未满 24 小时
  AWAITING_FIRST: "awaiting_first", // 已满 24 小时，等待他人首次复检
  AWAITING_NEXT: "awaiting_next", // 已有一次通过，等待 6 小时后第二次复检
  BLOCKED: "blocked", // 油膜越界，继续占位
  PASSED: "passed" // 两次复检均不越界，准调校
};

const STATUS_TEXT = {
  [STATUS.PENDING_REPLENISH]: "待补油",
  [STATUS.RESTING]: "静置中",
  [STATUS.AWAITING_FIRST]: "待首次复检",
  [STATUS.AWAITING_NEXT]: "待第二次复检",
  [STATUS.BLOCKED]: "油膜越界占位中",
  [STATUS.PASSED]: "复核通过，准调校"
};

const OPEN_STATUSES = Object.values(STATUS).filter((value) => value !== STATUS.PASSED);
// “未结束”包含通过但尚未收单的停油单；收单后才允许该表开新单
const FINISHED_REASON = "closed";

function httpError(status, message, extra) {
  const error = new Error(message);
  error.status = status;
  Object.assign(error, extra);
  return error;
}

function requireFields(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) throw httpError(400, `缺少字段：${missing.join(", ")}`);
}

function getClock(db, clockId) {
  const clock = db.clocks.find((item) => item.id === clockId);
  if (!clock) throw httpError(404, "钟表不存在");
  return clock;
}

function getOilStop(db, orderId) {
  const order = db.oilStops.find((item) => item.id === orderId);
  if (!order) throw httpError(404, "停油单不存在");
  return order;
}

function findOpenOilStop(db, clockId) {
  return db.oilStops.find((item) => item.clockId === clockId && !item.closedAt) || null;
}

function amountInRange(amountMicroliters) {
  return amountMicroliters >= MIN_OIL_MICROLITERS - 1e-9
    && amountMicroliters <= MAX_OIL_MICROLITERS + 1e-9;
}

function sortedRechecks(order) {
  return [...order.rechecks].sort((a, b) => new Date(a.testedAt) - new Date(b.testedAt));
}

// 取末尾连续“油膜不越界”的复检数：中途越界一次，链即断，继续占位
function passStreak(order) {
  let streak = 0;
  for (const recheck of sortedRechecks(order).reverse()) {
    if (recheck.oilFilmWithinBounds) streak += 1;
    else break;
  }
  return streak;
}

function evaluate(order, nowIso = new Date().toISOString()) {
  const now = new Date(nowIso);
  const restStart = new Date(order.restStartedAt);
  const restedHours = (now - restStart) / 36e5;
  const streak = passStreak(order);
  const total = order.rechecks.length;

  let status;
  if (!amountInRange(order.amountMicroliters)) {
    status = STATUS.PENDING_REPLENISH;
  } else if (streak >= REQUIRED_PASS_RECHECKS) {
    status = STATUS.PASSED;
  } else if (total === 0) {
    status = restedHours < REST_HOURS ? STATUS.RESTING : STATUS.AWAITING_FIRST;
  } else if (streak === 0) {
    status = STATUS.BLOCKED;
  } else {
    const latest = sortedRechecks(order)[total - 1];
    const nextAt = new Date(new Date(latest.testedAt).getTime() + RECHECK_INTERVAL_HOURS * 36e5);
    status = now < nextAt ? STATUS.RESTING : STATUS.AWAITING_NEXT;
  }

  let nextRecheckAt = null;
  if (amountInRange(order) && status !== STATUS.PASSED) {
    if (total === 0) {
      nextRecheckAt = new Date(restStart.getTime() + REST_HOURS * 36e5).toISOString();
    } else if (streak > 0) {
      const latest = sortedRechecks(order)[total - 1];
      nextRecheckAt = new Date(new Date(latest.testedAt).getTime() + RECHECK_INTERVAL_HOURS * 36e5).toISOString();
    }
  }

  return {
    status,
    statusText: STATUS_TEXT[status],
    restedHours: Math.round(restedHours * 10) / 10,
    passStreak: streak,
    remainingPassRechecks: Math.max(0, REQUIRED_PASS_RECHECKS - streak),
    nextRecheckAt,
    tunable: status === STATUS.PASSED
  };
}

function orderView(order, nowIso = new Date().toISOString()) {
  return { ...order, ...evaluate(order, nowIso) };
}

// 登记停油：每表仅一张未结束（未收单）停油单，重复沿用首次
function registerOilStop(db, clockId, body, ctx) {
  const clock = getClock(db, clockId);
  const existing = findOpenOilStop(db, clock.id);
  if (existing) {
    return { order: orderView(existing, ctx.now), duplicated: true };
  }
  requireFields(body, ["oilType", "amountMicroliters", "operator"]);
  const amountMicroliters = Number(body.amountMicroliters);
  if (!Number.isFinite(amountMicroliters) || amountMicroliters <= 0) {
    throw httpError(400, "注油量必须是大于0的数字（微升）");
  }
  const oiledAt = body.oiledAt || ctx.now;
  const order = {
    id: ctx.makeId("oilstop"),
    clockId: clock.id,
    version: 1,
    oilType: String(body.oilType),
    amountMicroliters,
    operator: String(body.operator),
    oiledAt,
    restStartedAt: oiledAt,
    rechecks: [],
    revisions: [],
    replacedPart: null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    closedAt: null,
    closeNote: null
  };
  db.oilStops.push(order);
  return { order: orderView(order, ctx.now), duplicated: false };
}

function archiveCurrent(order, ctx, reason, patch) {
  order.revisions.push({
    version: order.version,
    reason,
    oilType: order.oilType,
    amountMicroliters: order.amountMicroliters,
    operator: order.operator,
    oiledAt: order.oiledAt,
    restStartedAt: order.restStartedAt,
    replacedPart: order.replacedPart,
    rechecks: order.rechecks,
    supersededAt: ctx.now,
    ...patch
  });
}

// 更正油量（油种/操作员也可一并更正）：旧版留档，复核全部作废，24 小时重新起算
function correctOilStop(db, orderId, body, ctx) {
  const order = getOilStop(db, orderId);
  if (order.closedAt) throw httpError(409, "停油单已结束，不能更正");
  requireFields(body, ["amountMicroliters", "operator"]);
  const amountMicroliters = Number(body.amountMicroliters);
  if (!Number.isFinite(amountMicroliters) || amountMicroliters <= 0) {
    throw httpError(400, "注油量必须是大于0的数字（微升）");
  }

  archiveCurrent(order, ctx, "amount_corrected", {
    correctedTo: amountMicroliters,
    invalidatedRecheckCount: order.rechecks.length
  });

  if (body.oilType !== undefined) order.oilType = String(body.oilType);
  order.amountMicroliters = amountMicroliters;
  order.operator = String(body.operator);
  order.version += 1;
  order.oiledAt = ctx.now;
  order.restStartedAt = ctx.now;
  order.rechecks = [];
  order.replacedPart = null;
  order.updatedAt = ctx.now;
  return { order: orderView(order, ctx.now), invalidated: true };
}

// 换件：旧版留档，复核作废重算（油量登记仍以最新版为准）
function replacePart(db, orderId, body, ctx) {
  const order = getOilStop(db, orderId);
  if (order.closedAt) throw httpError(409, "停油单已结束，不能登记换件");
  requireFields(body, ["partName", "operator"]);

  archiveCurrent(order, ctx, "part_replaced", {
    partName: String(body.partName),
    invalidatedRecheckCount: order.rechecks.length
  });

  order.replacedPart = { name: String(body.partName), operator: String(body.operator), at: ctx.now };
  order.version += 1;
  order.restStartedAt = ctx.now;
  order.rechecks = [];
  order.updatedAt = ctx.now;
  return { order: orderView(order, ctx.now), invalidated: true };
}

// 复检：停油满 24h、他人执行、两次间隔 6h、油膜均不越界
function submitRecheck(db, orderId, body, ctx) {
  const order = getOilStop(db, orderId);
  if (order.closedAt) throw httpError(409, "停油单已结束，不能复检");
  requireFields(body, ["inspector", "oilFilmWithinBounds"]);
  if (!amountInRange(order.amountMicroliters)) {
    throw httpError(409, "油量不在0.02至0.05微升，需先更正补油，不能复检");
  }

  const inspector = String(body.inspector);
  const testedAt = body.testedAt || ctx.now;
  const tested = new Date(testedAt);
  const oilFilmWithinBounds = body.oilFilmWithinBounds === true || body.oilFilmWithinBounds === "true";

  // 同一复检人、同一时刻、同一结论的重复提交沿用首次（先于时效校验，保证重复请求幂等）
  const duplicate = order.rechecks.find(
    (item) => item.inspector === inspector
      && item.testedAt === testedAt
      && item.oilFilmWithinBounds === oilFilmWithinBounds
  );
  if (duplicate) {
    return { order: orderView(order, testedAt), recheck: duplicate, duplicated: true };
  }

  if (inspector === order.operator) {
    throw httpError(409, "复检必须由注油操作员之外的他人执行");
  }

  const restHours = (tested - new Date(order.restStartedAt)) / 36e5;
  if (restHours < REST_HOURS - 1e-9) {
    throw httpError(409, `停油未满${REST_HOURS}小时（当前约${Math.round(restHours * 10) / 10}小时），不能复检`, {
      earliestRecheckAt: new Date(new Date(order.restStartedAt).getTime() + REST_HOURS * 36e5).toISOString()
    });
  }

  const ordered = sortedRechecks(order);
  if (ordered.length > 0) {
    const last = ordered[ordered.length - 1];
    const gapHours = (tested - new Date(last.testedAt)) / 36e5;
    if (gapHours < RECHECK_INTERVAL_HOURS - 1e-9) {
      throw httpError(409, `距上次复检不足${RECHECK_INTERVAL_HOURS}小时（当前约${Math.round(gapHours * 10) / 10}小时）`, {
        earliestRecheckAt: new Date(new Date(last.testedAt).getTime() + RECHECK_INTERVAL_HOURS * 36e5).toISOString()
      });
    }
  }

  const beforeStreak = passStreak(order);
  const recheck = {
    id: ctx.makeId("oilrecheck"),
    version: order.version,
    inspector,
    testedAt,
    oilFilmWithinBounds,
    note: body.note || "",
    createdAt: ctx.now
  };
  order.rechecks.push(recheck);
  order.updatedAt = ctx.now;

  // 越界则连续通过链断裂，复核从头计数，停油单继续占位
  if (!oilFilmWithinBounds) {
    return { order: orderView(order, testedAt), recheck, duplicated: false, chainReset: beforeStreak > 0 };
  }
  const streak = passStreak(order);
  return {
    order: orderView(order, testedAt),
    recheck,
    duplicated: false,
    passed: streak >= REQUIRED_PASS_RECHECKS
  };
}

// 收单：结束本张停油单，之后该表才可登记新单
function closeOilStop(db, orderId, body, ctx) {
  const order = getOilStop(db, orderId);
  if (order.closedAt) return { order: orderView(order, ctx.now), duplicated: true };
  order.closedAt = ctx.now;
  order.closeNote = (body && body.note) || "";
  order.updatedAt = ctx.now;
  return { order: orderView(order, ctx.now), duplicated: false };
}

// 调校闸门：只有油膜两次不越界（通过）且未收单的表才准调校
function assertTunable(db, clockId, ctx) {
  getClock(db, clockId);
  const order = findOpenOilStop(db, clockId);
  if (!order) {
    throw httpError(409, "该表尚无进行中的停油单，须先完成停油与油膜复核才能调校");
  }
  const view = evaluate(order, ctx.now);
  if (view.status !== STATUS.PASSED) {
    throw httpError(409, `油膜复核未通过（${view.statusText}），暂不准调校`, { oilStop: orderView(order, ctx.now) });
  }
  return order;
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = {
  MIN_OIL_MICROLITERS,
  MAX_OIL_MICROLITERS,
  REST_HOURS,
  RECHECK_INTERVAL_HOURS,
  REQUIRED_PASS_RECHECKS,
  STATUS,
  STATUS_TEXT,
  OPEN_STATUSES,
  FINISHED_REASON,
  httpError,
  requireFields,
  getClock,
  getOilStop,
  findOpenOilStop,
  amountInRange,
  evaluate,
  orderView,
  registerOilStop,
  correctOilStop,
  replacePart,
  submitRecheck,
  closeOilStop,
  assertTunable,
  makeId
};
