# 机械钟表擒纵调校 API —— 停油与油膜复核台

零依赖 Node 服务，代码按职责拆成三个业务文件：

| 文件 | 职责 |
| --- | --- |
| `server.js` | 启动入口，仅引导 HTTP 服务 |
| `entry.js` | 入口层：路由、请求/响应解析、HTTP 适配 |
| `rules.js` | 规则层：停油单状态机、时效与他人复检、作废重算、调校闸门（纯逻辑） |
| `store.js` | 存储层：`data/db.json` 持久化、原子写、写操作串行队列 |

## 启动

```bash
PORT=3021 node server.js
```

## 业务规则

1. **每表仅一张未结束（未收单）停油单**：重复登记或并发登记沿用首次返回，不产生第二张。
2. 登记内容：油种 `oilType`、注油量 `amountMicroliters`（微升）、操作员 `operator`。
   - 注油量 **0.02–0.05 μL**（含边界）为合规；越界自动转 `pending_replenish`（待补油），不能复检、不能调校。
3. 停油（以 `restStartedAt` 起）**满 24 小时**后才能首次复检；复检必须由**注油操作员之外的他人**执行。
4. 两次复检**间隔 6 小时**；需**油膜连续两次均不越界**才 `passed`（准调校）。
   - 中途任何一次油膜越界，连续通过链立即清零，停油单 `blocked` 继续占位，需重新累计两次。
5. **更正油量**或**换件**：旧版完整留档（`revisions`，含当时复检），当前复检全部作废、版本号 +1、24 小时重新起算。
6. 调校接口带闸门：只有 `passed` 的表才能 `POST /clocks/:id/adjustments`，否则 409。
7. 收单 `POST /oil-stops/:id/close` 后该表才允许登记新停油单。
8. 列表、履历、服务刷新（重启）读同一份 JSON；写操作排队 + 临时文件原子替换，保证并发一致。

停油单状态：`pending_replenish`（待补油）、`resting`（静置/间隔等待中）、`awaiting_first`（待首次复检）、`awaiting_next`（待第二次复检）、`blocked`（油膜越界占位中）、`passed`（准调校）。

## 接口

原有：

- `GET /health`
- `GET /clocks` / `POST /clocks`
- `GET /clocks/not-qualified`
- `GET /clocks/:id/history`（含 `oilStops` 履历与 `activeOilStop`）
- `POST /clocks/:id/adjustments`（**新增复核闸门**）
- `POST /clocks/:id/retests` / `GET /clocks/:id/latest-retest`
- `GET /adjustments?clockId=` / `GET /retests?clockId=&qualified=`

停油复核台：

- `POST /clocks/:id/oil-stops` 登记停油（重复/并发沿用首次，200 返回并带 `duplicated:true`）
- `GET /clocks/:id/oil-stops` 某表停油单履历
- `GET /oil-stops?clockId=&status=&active=true` 停油单列表
- `GET /oil-stops/:id` 停油单详情（状态、复检、版本留档）
- `POST /oil-stops/:id/correct` 更正油量/油种/操作员（作废重算，旧版留档）
- `POST /oil-stops/:id/parts` 登记换件（作废重算，旧版留档）
- `POST /oil-stops/:id/rechecks` 提交油膜复检（24h 后、他人、间隔 6h、两次不越界）
- `POST /oil-stops/:id/close` 收单

> 为便于演练时间规则，登记与复检可显式传 `oiledAt` / `testedAt`（ISO 时间）；服务端也支持在请求体里传 `now` 作为当前时刻。

## 闭环示例

```bash
BASE=http://127.0.0.1:3021

# 1. 登记停油（0.03μL 合规）
curl -s -X POST $BASE/clocks/clock_demo/oil-stops -H 'Content-Type: application/json' \
  -d '{"oilType":"9010表油","amountMicroliters":0.03,"operator":"张师傅","oiledAt":"2026-09-20T00:00:00Z"}'

# 2. 24h 后他人首次复检，油膜不越界
curl -s -X POST $BASE/oil-stops/<id>/rechecks -H 'Content-Type: application/json' \
  -d '{"inspector":"李师傅","oilFilmWithinBounds":true,"testedAt":"2026-09-21T01:00:00Z"}'

# 3. 再过 6h 第二次复检仍不越界 -> passed，准调校
curl -s -X POST $BASE/oil-stops/<id>/rechecks -H 'Content-Type: application/json' \
  -d '{"inspector":"李师傅","oilFilmWithinBounds":true,"testedAt":"2026-09-21T07:00:00Z"}'

# 4. 通过后才能调校
curl -s -X POST $BASE/clocks/clock_demo/adjustments -H 'Content-Type: application/json' \
  -d '{"currentDailyRateSeconds":18,"direction":"慢针方向","amount":"微调0.2格"}'
```

油量越界示例（0.06μL → 待补油，需 `/correct` 更正到合规区间后重新静置）：

```bash
curl -s -X POST $BASE/clocks/clock_demo/oil-stops -H 'Content-Type: application/json' \
  -d '{"oilType":"9010表油","amountMicroliters":0.06,"operator":"张师傅"}'
```
