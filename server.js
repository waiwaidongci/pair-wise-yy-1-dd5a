// 启动入口：仅负责引导 HTTP 服务；路由在 entry.js，规则在 rules.js，存储在 store.js
const { server } = require("./entry");

const PORT = Number(process.env.PORT || 3021);

server.listen(PORT, () => {
  console.log(`Clock escapement oil-stop & oil-film review API running at http://127.0.0.1:${PORT}`);
});
