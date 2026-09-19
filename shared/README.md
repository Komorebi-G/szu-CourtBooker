# 共用预约逻辑

桌面端和 Android 端共用此目录，禁止导入 Node 文件系统、桌面调度器或 Android 原生插件。

- `api.js`、`http-client-core.js`：学校协议与可注入传输层。
- `runner.js`、`planner.js`、`booking-quota.js`：放号等待、场地顺序、同场偏好及两时段上限。
- `session-format.js`：登录 JSON / Cookie / cURL 解析。
- `projects.js`、`constants.js`、`utils.js`、`errors.js`：项目目录及公共工具。

桌面端注入 Node HTTP 和持久化，Android 注入原生 HTTP 和本地文件存储。规则测试位于根目录 `test/`。
