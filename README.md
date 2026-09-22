# 机械钟表擒纵调校API · 擒纵润滑停油与油膜复核台

纯后端零依赖Node服务，使用 `data/db.json` 持久化钟表档案、调校记录、复测记录、停油单与停油单留档版本。

代码按职责拆为三个业务文件：

- `server.js` —— 入口：HTTP 路由、请求解析、错误映射
- `rules.js` —— 规则：停油单状态机、油量区间、复核时限、失效重算、调校闸门
- `store.js` —— 存储：JSON 持久化、写事务串行锁（并发/重复请求沿用首次结果）

## 启动

```bash
PORT=3021 node server.js
```

## 停油复核规则

- 每表仅一张未结束停油单；重复或并发登记沿用首次（支持 `requestKey` 幂等键）。
- 登记油种、注油量（微升）、操作员；油量不在 **0.02~0.05µL** 时状态为「待补油」。
- 停油满 **24小时** 后方可复检；须由 **他人**（非登记操作员）复检 **两次**，两次间隔 **≥6小时**。
- 两次油膜读数均在 `[filmLowerBound, filmUpperBound]`（默认 0.5~1.5）内才放行调校；任一越界则停油单继续占位，须更正油量或换件后重算。
- 更正油量或换件：当前版本（含复核记录）归档留档，版本号+1，静置计时与复核记录清零重算。
- 存在未结束停油单时，`POST /clocks/:id/adjustments` 返回 409，禁止调校。
- 列表、履历、详情均读自同一持久化存储，刷新/重启后一致。

## 主要接口

### 钟表与调校

- `GET /health`
- `GET /clocks` / `POST /clocks`
- `GET /clocks/not-qualified`
- `GET /clocks/:id/history`
- `POST /clocks/:id/adjustments`（有未结束停油单时 409）
- `POST /clocks/:id/retests`
- `GET /clocks/:id/latest-retest`
- `GET /adjustments?clockId=`
- `GET /retests?clockId=&qualified=`

### 停油与油膜复核

- `POST /clocks/:id/stop-oil-orders` —— 登记停油单（`oilType`、`oilAmountMicroliters`、`operator`，可选 `requestKey`/`settledAt`/油膜上下界）
- `GET /clocks/:id/stop-oil-orders` —— 该表停油履历
- `GET /stop-oil-orders?clockId=&status=&open=` —— 停油单列表
- `GET /stop-oil-orders/:id` —— 详情（含留档版本 `archivedVersions`）
- `POST /stop-oil-orders/:id/reviews` —— 油膜复检（`reviewer`、`filmReading`，可选 `reviewedAt`）
- `POST /stop-oil-orders/:id/corrections` —— 更正油量（复核失效重算，旧版留档）
- `POST /stop-oil-orders/:id/part-replacements` —— 换件（复核失效重算，旧版留档）

## 闭环示例

```bash
# 登记停油单（油量合规 → 停油静置中）
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/stop-oil-orders \
  -H 'Content-Type: application/json' \
  -d '{"oilType":"9415擒纵油","oilAmountMicroliters":0.03,"operator":"张师傅"}'

# 满24小时后由他人复检两次，间隔≥6小时
curl -X POST http://127.0.0.1:3021/stop-oil-orders/<orderId>/reviews \
  -H 'Content-Type: application/json' \
  -d '{"reviewer":"李师傅","filmReading":1.1}'

# 两次均不越界 → 放行，之后方可调校
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/adjustments \
  -H 'Content-Type: application/json' \
  -d '{"currentDailyRateSeconds":31,"direction":"慢针方向","amount":"快慢针微调0.2格"}'
```
