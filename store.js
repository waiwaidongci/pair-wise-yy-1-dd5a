const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const DB_FILE = path.join(__dirname, "data", "db.json");

const initialData = {
  clocks: [
    {
      id: "clock_demo",
      code: "CLK-1890-07",
      escapementType: "瑞士杠杆式",
      balanceFrequency: "18000vph",
      targetDailyRateSeconds: 20,
      note: "怀表机芯，走时偏快",
      createdAt: new Date().toISOString()
    }
  ],
  adjustments: [
    {
      id: "adjustment_demo",
      clockId: "clock_demo",
      currentDailyRateSeconds: 68,
      direction: "慢针方向",
      amount: "游丝快慢针向慢侧微调0.4格",
      note: "初次调校，先保守处理",
      createdAt: new Date().toISOString()
    }
  ],
  retests: [
    {
      id: "retest_demo",
      clockId: "clock_demo",
      adjustmentId: "adjustment_demo",
      testedAt: new Date().toISOString(),
      dailyRateSeconds: 31,
      amplitude: 248,
      qualified: false,
      note: "仍偏快，振幅尚可"
    }
  ],
  stopOilOrders: [],
  stopOilOrderVersions: []
};

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeDb(initialData);
  }
}

function normalize(data) {
  data.clocks = Array.isArray(data.clocks) ? data.clocks : [];
  data.adjustments = Array.isArray(data.adjustments) ? data.adjustments : [];
  data.retests = Array.isArray(data.retests) ? data.retests : [];
  data.stopOilOrders = Array.isArray(data.stopOilOrders) ? data.stopOilOrders : [];
  data.stopOilOrderVersions = Array.isArray(data.stopOilOrderVersions) ? data.stopOilOrderVersions : [];
  return data;
}

async function readDb() {
  await ensureDb();
  return normalize(JSON.parse(await readFile(DB_FILE, "utf8")));
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(normalize(data), null, 2));
}

// 串行化所有写事务：重复或并发请求在锁内重读库，始终沿用首次结果
let queue = Promise.resolve();

function transact(mutator) {
  const run = queue.then(async () => {
    const db = await readDb();
    const result = await mutator(db);
    await writeDb(db);
    return result;
  });
  queue = run.catch(() => {});
  return run;
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = { readDb, writeDb, transact, makeId };
