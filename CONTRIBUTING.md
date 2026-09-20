# 开发约定

从仓库根目录执行：

```sh
npm ci
npm run check
npm run web -- --no-open
```

Android 界面构建：

```sh
npm ci --prefix mobile
npm run build --prefix mobile
```

完整 APK 构建见 [Android 文档](mobile/README.md)，Windows 单文件构建见 [桌面文档](desktop/README.md)。

## 目录边界

- 桌面服务、文件存储和本次执行放 `desktop/src/`，桌面界面放 `desktop/web/`。
- 手机界面和生命周期放 `mobile/src/`，原生能力放 `mobile/android/`。
- 两端共用的协议与预约规则放 `shared/`；它不得依赖平台实现。
- 根目录 `src/` 只是旧启动入口兼容层，旧定时入口只停用和清理，不再自动预约，不新增业务代码。

测试使用模拟账号和响应，不访问学校、不提交预约。浏览器/安装包的人工验收与逻辑测试应分别说明，不能把构建成功当成真机验证。

提交前检查 `git diff --cached`。不要提交真实 Cookie、账号标识、登录导出、订单、任务、日志、截图、签名密钥或本机 SDK 配置。Git 忽略规则不是秘密扫描器。

发行包只附明确列出的构建产物，不打包整个工作区。更换 Android 签名会影响覆盖安装；签名密钥必须独立保管且不能进入 Git。
