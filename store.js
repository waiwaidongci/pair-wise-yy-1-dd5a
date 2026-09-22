const { readFile, writeFile, mkdir, rename } = require("fs/promises");
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
      createdAt: "2026-06-16T00:00:00.000Z"
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
      createdAt: "2026-06-16T00:00:00.000Z"
    }
  ],
  retests: [
    {
      id: "retest_demo",
      clockId: "clock_demo",
      adjustmentId: "adjustment_demo",
      testedAt: "2026-06-16T00:00:00.000Z",
      dailyRateSeconds: 31,
      amplitude: 248,
      qualified: false,
      note: "仍偏快，振幅尚可"
    }
  ],
  oilStops: []
};

let cache = null;

// 写操作串行队列：并发的重复登记/更正只会有一个生效，其余沿用首次结果
let chain = Promise.resolve();

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    const parsed = JSON.parse(await readFile(DB_FILE, "utf8"));
    for (const key of Object.keys(initialData)) {
      if (!Array.isArray(parsed[key])) parsed[key] = initialData[key];
    }
    return parsed;
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
    return JSON.parse(JSON.stringify(initialData));
  }
}

async function load() {
  if (!cache) cache = await ensureDb();
  return cache;
}

// 读：始终来自同一内存快照，刷新（重启）后仍由同一文件还原，列表与履历口径一致
async function readAll() {
  return load();
}

// 写：排队执行 + 临时文件原子替换，保证“重复或并发沿用首次”
function mutate(fn) {
  const run = chain.then(async () => {
    const db = await load();
    const result = await fn(db);
    const tmp = `${DB_FILE}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
    await writeFile(tmp, JSON.stringify(db, null, 2));
    await rename(tmp, DB_FILE);
    return result;
  });
  chain = run.catch(() => {});
  return run;
}

module.exports = { readAll, mutate };
