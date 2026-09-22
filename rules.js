const { makeId } = require("./store");

// 停油与油膜复核规则常量
const OIL_MIN_MICROLITERS = 0.02;
const OIL_MAX_MICROLITERS = 0.05;
const SETTLE_HOURS = 24; // 停油满二十四小时后才可复核
const REVIEW_GAP_HOURS = 6; // 两次复检至少隔六小时
const REQUIRED_REVIEWS = 2; // 复检两次，油膜均不越界才准调校
const DEFAULT_FILM_LOWER = 0.5;
const DEFAULT_FILM_UPPER = 1.5;

const STATUS = {
  PENDING_REFILL: "pending_refill", // 待补油：注油量越界
  SETTLING: "settling", // 停油静置中
  REVIEWING: "reviewing", // 复核中
  OIL_FILM_OUT: "oil_film_out", // 油膜越界，继续占位
  RELEASED: "released" // 已放行，准调校
};

const STATUS_LABELS = {
  [STATUS.PENDING_REFILL]: "待补油",
  [STATUS.SETTLING]: "停油静置中",
  [STATUS.REVIEWING]: "复核中",
  [STATUS.OIL_FILM_OUT]: "油膜越界待处理",
  [STATUS.RELEASED]: "已放行"
};

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function requireFields(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) fail(400, `缺少字段：${missing.join(", ")}`);
}

function toAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) fail(400, "注油量必须是数字（微升）");
  return amount;
}

function oilAmountInRange(amount) {
  return amount >= OIL_MIN_MICROLITERS && amount <= OIL_MAX_MICROLITERS;
}

function hoursBetween(from, to) {
  return (new Date(to) - new Date(from)) / 36e5;
}

function isOpen(order) {
  return order.status !== STATUS.RELEASED;
}

function findOpenOrder(db, clockId) {
  return db.stopOilOrders.find((order) => order.clockId === clockId && isOpen(order)) || null;
}

function findOrder(db, orderId) {
  const order = db.stopOilOrders.find((item) => item.id === orderId);
  if (!order) fail(404, "停油单不存在");
  return order;
}

function summarizeOrder(order) {
  return {
    ...order,
    open: isOpen(order),
    statusLabel: STATUS_LABELS[order.status] || order.status,
    oilAmountInRange: oilAmountInRange(order.oilAmountMicroliters),
    reviewCount: order.reviews.length,
    reviewsRequired: REQUIRED_REVIEWS
  };
}

// 登记停油单：每表仅一张未结束停油单，重复或并发沿用首次
function createStopOilOrder(db, clock, body) {
  requireFields(body, ["oilType", "oilAmountMicroliters", "operator"]);
  const amount = toAmount(body.oilAmountMicroliters);

  if (body.requestKey) {
    const sameKey = db.stopOilOrders.find(
      (order) => order.clockId === clock.id && order.requestKey === body.requestKey
    );
    if (sameKey) return { order: sameKey, reused: true };
  }

  const open = findOpenOrder(db, clock.id);
  if (open) return { order: open, reused: true };

  const now = new Date().toISOString();
  const order = {
    id: makeId("stopoil"),
    clockId: clock.id,
    oilType: body.oilType,
    oilAmountMicroliters: amount,
    operator: body.operator,
    filmLowerBound: Number(body.filmLowerBound ?? DEFAULT_FILM_LOWER),
    filmUpperBound: Number(body.filmUpperBound ?? DEFAULT_FILM_UPPER),
    status: oilAmountInRange(amount) ? STATUS.SETTLING : STATUS.PENDING_REFILL,
    version: 1,
    reviews: [],
    requestKey: body.requestKey || null,
    note: body.note || "",
    settledAt: body.settledAt || now,
    createdAt: now,
    updatedAt: now,
    releasedAt: null
  };
  db.stopOilOrders.push(order);
  return { order, reused: false };
}

// 旧版留档：换件或更正油量前把当前版本（含复核记录）归档
function archiveCurrentVersion(db, order, reason, detail) {
  db.stopOilOrderVersions.push({
    id: makeId("stopoilver"),
    orderId: order.id,
    clockId: order.clockId,
    version: order.version,
    oilType: order.oilType,
    oilAmountMicroliters: order.oilAmountMicroliters,
    operator: order.operator,
    filmLowerBound: order.filmLowerBound,
    filmUpperBound: order.filmUpperBound,
    status: order.status,
    settledAt: order.settledAt,
    reviews: order.reviews,
    reason,
    detail: detail || "",
    archivedAt: new Date().toISOString()
  });
}

// 复核失效重算：归档旧版、版本号加一、静置计时与复核记录清零
function restartOrder(db, order, reason, detail, settledAt) {
  archiveCurrentVersion(db, order, reason, detail);
  order.version += 1;
  order.reviews = [];
  order.settledAt = settledAt || new Date().toISOString();
  order.status = oilAmountInRange(order.oilAmountMicroliters) ? STATUS.SETTLING : STATUS.PENDING_REFILL;
  order.updatedAt = new Date().toISOString();
}

// 更正油量：复核失效重算，旧版留档
function correctOilAmount(db, order, body) {
  requireFields(body, ["oilAmountMicroliters"]);
  if (!isOpen(order)) fail(409, "停油单已结束，不能更正油量");
  const amount = toAmount(body.oilAmountMicroliters);
  restartOrder(db, order, "correction", body.reason || "更正油量", body.settledAt);
  order.oilAmountMicroliters = amount;
  if (body.oilType) order.oilType = body.oilType;
  if (body.operator) order.operator = body.operator;
  order.status = oilAmountInRange(amount) ? STATUS.SETTLING : STATUS.PENDING_REFILL;
  return order;
}

// 换件：复核失效重算，旧版留档
function replacePart(db, order, body) {
  requireFields(body, ["part"]);
  if (!isOpen(order)) fail(409, "停油单已结束，不能登记换件");
  restartOrder(db, order, "part_replacement", `换件：${body.part}`, body.settledAt);
  order.partReplacements = order.partReplacements || [];
  order.partReplacements.push({
    part: body.part,
    note: body.note || "",
    operator: body.operator || order.operator,
    replacedAt: new Date().toISOString()
  });
  return order;
}

// 油膜复检：停油满24小时后由他人隔6小时复检两次，均不越界才放行
function addReview(db, order, body) {
  requireFields(body, ["reviewer", "filmReading"]);
  if (!isOpen(order)) fail(409, "停油单已结束，无需再复核");
  if (order.status === STATUS.PENDING_REFILL) {
    fail(409, "注油量不在0.02~0.05微升，待补油，暂不能复核");
  }
  if (order.status === STATUS.OIL_FILM_OUT) {
    fail(409, "上一轮换核油膜越界，停油单继续占位，须更正油量或换件后重算");
  }

  const filmReading = Number(body.filmReading);
  if (!Number.isFinite(filmReading)) fail(400, "油膜读数必须是数字");

  const reviewedAt = body.reviewedAt || new Date().toISOString();

  // 重复提交同一次复检（同复核人同时间）沿用首次
  const duplicated = order.reviews.find(
    (review) => review.reviewer === body.reviewer && review.reviewedAt === reviewedAt
  );
  if (duplicated) return { review: duplicated, order, reused: true };

  const settledHours = hoursBetween(order.settledAt, reviewedAt);
  if (settledHours < SETTLE_HOURS) {
    fail(409, `停油未满${SETTLE_HOURS}小时（已静置${settledHours.toFixed(1)}小时），暂不能复核`);
  }
  if (body.reviewer === order.operator) fail(409, "复检须由他人进行，不能是登记操作员本人");
  if (order.reviews.length >= REQUIRED_REVIEWS) fail(409, "本轮复检已完成两次");

  const previous = order.reviews[order.reviews.length - 1];
  if (previous) {
    const gap = hoursBetween(previous.reviewedAt, reviewedAt);
    if (gap < REVIEW_GAP_HOURS) {
      fail(409, `两次复检须间隔${REVIEW_GAP_HOURS}小时以上（当前间隔${gap.toFixed(1)}小时）`);
    }
  }

  const withinBounds = filmReading >= order.filmLowerBound && filmReading <= order.filmUpperBound;
  const review = {
    id: makeId("filmreview"),
    orderId: order.id,
    version: order.version,
    reviewer: body.reviewer,
    filmReading,
    withinBounds,
    reviewedAt,
    note: body.note || ""
  };
  order.reviews.push(review);

  if (!withinBounds) {
    order.status = STATUS.OIL_FILM_OUT; // 油膜越界，继续占位
  } else if (order.reviews.length >= REQUIRED_REVIEWS) {
    order.status = STATUS.RELEASED; // 两次均不越界，准调校
    order.releasedAt = reviewedAt;
  } else {
    order.status = STATUS.REVIEWING;
  }
  order.updatedAt = new Date().toISOString();
  return { review, order, reused: false };
}

// 调校闸门：存在未结束停油单（复核未通过）则禁止调校
function assertAdjustmentAllowed(db, clockId) {
  const open = findOpenOrder(db, clockId);
  if (open) {
    fail(409, `存在未结束停油单（${open.id}，${STATUS_LABELS[open.status]}），油膜复核未通过，禁止调校`);
  }
}

module.exports = {
  STATUS,
  STATUS_LABELS,
  OIL_MIN_MICROLITERS,
  OIL_MAX_MICROLITERS,
  SETTLE_HOURS,
  REVIEW_GAP_HOURS,
  REQUIRED_REVIEWS,
  findOpenOrder,
  findOrder,
  summarizeOrder,
  createStopOilOrder,
  correctOilAmount,
  replacePart,
  addReview,
  assertAdjustmentAllowed
};
