# 发布流程

1. 更新根目录与 `mobile/` 的包版本及 lockfile、Android `versionCode` / `versionName`。发行说明写入 GitHub Release，工作区不新增逐版本总结。
2. 先完成两端干净依赖安装：`npm ci`、`npm ci --prefix mobile`，再运行 `npm run check`。跨端执行检查会加载手机适配器，不能在安装手机依赖前运行。随后构建手机资源及两端安装包。
3. 在具备 `curl` 和 `zip` 的 Linux / WSL 环境运行 `node scripts/prepare-release.js`，输出 `dist/release/` 中的明确附件清单与 SHA-256。该脚本会读取本机已安装依赖的许可证，以及下载 Node 对应版本与 Android 组件的官方 LICENSE；需联网。临时许可证目录保留在系统临时目录供检查。
4. 初始化或更新 Git，检查 `git status --short`、`git diff --cached --stat`。确认 `.session.json`、`.data/`、`config.yaml`、签名密钥、截图和日志没有被跟踪。
5. 推送主分支，确认 CI。创建版本标签和 GitHub Release，首次未经真机验证的版本标记为 prerelease。只上传 `dist/release/` 内明确列出的附件，勿上传整个工作区或本地数据。
6. 核对远端标签、提交、附件大小和发行说明。

当前 `npm run apk --prefix mobile` 生成的是开发签名 APK；不能称为生产签名包。首次安装后想保留覆盖升级能力，必须保存同一份签名密钥。GitHub CI 不包含密钥，未来正式签名应通过私密凭据配置，不能提交到仓库。

Windows 包未使用 Authenticode 签名。正式发布签名、自动升级、商店分发与 iOS 不在本次实现范围。
