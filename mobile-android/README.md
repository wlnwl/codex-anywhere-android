# Codex Anywhere Android 0.6.3

面向自托管 Codex Anywhere 中继的非官方 Android 客户端。原生 Java 界面负责设备选择、会话列表、文字记录、草稿、请求状态和权限选择；本地打包的 JavaScript 模块负责设备认证、WebSocket 和端到端加密。不可见的 WebView 仅加载固定的本地协议资源，不加载远程聊天页面。

[下载 Android APK v0.6.3](https://github.com/wlnwl/codex-anywhere-android/releases/download/android-v0.6.3/CodexAnywhere-0.6.3.apk) · [发布说明](https://github.com/wlnwl/codex-anywhere-android/releases/tag/android-v0.6.3)

公开版 APK 使用独立的签名密钥。如果 Android 因签名不同拒绝覆盖更新，请卸载旧版后安装公开版，再重新配对。卸载会清除 App 的本地设置和配对状态。

## 日间与夜间模式

点顶部太阳／月亮开关切换主题。太阳在左侧代表日间，月亮在右侧代表夜间。切换配色会应用到会话、输入区和弹窗，重新打开 App 时会恢复上次的选择。

## 会话同步

- 打开会话或从后台返回时立即同步。App 在前台通常每秒检查当前会话；收到会话推送时会提前更新。读取失败时，常规重试间隔为 15 秒。
- 手机发送后先显示消息和当前发送状态；确认写入会话记录后合并为一条。未确认的消息不自动重发。
- 已选电脑重新上线时重建连接并恢复会话读取；读取失败时保留当前消息。
- App 在前台时会尝试恢复因临时断网或认证到期而断开的中继连接。中继断开期间清除旧设备状态，区分手机未连中继与电脑离线。

## 电脑上的 Codex 账号

选择在线电脑后，点 Android 顶部的「账号」打开面板。网页版也可从右上角独立的「账号」按钮打开同一功能。面板刷新所选电脑的 Codex 原生账号和工作区列表，同时读取当前工作区的订阅类型。选择已有工作区后确认切换。换用其他账号时，点「登录其他账号」，在 OpenAI 官方登录页面输入设备码。验证码暂存在内存中，登录凭据由电脑上的 Codex 管理。

同一登录下的个人订阅（例如 Pro）与 Business 团队工作区可在列表中直接选择，无需重新登录。每个工作区显示原生名称和个人／团队类型；当前所选工作区显示真实读取的订阅类型，未选中的工作区不推断套餐。

如果账号面板提示需要重启桌面端，点「重启 Codex」并确认。此操作会中断正在运行的桌面任务。自动重启支持当前用户安装的 Windows 打包版 OpenAI.Codex 应用，其他安装形式可手动退出并重新打开 Codex。手机会查询进度，在确认旧桌面进程退出、新进程启动后显示完成，失败或超时会给出提示。断线后可重新打开账号面板读取结果。

账号管理需要本仓库的连接器，以及支持 `accountSession/list`、`accountSession/switch` 和 `chatgptDeviceCode` 的 Codex 版本。

## 弹窗与配对

- 连接、电脑选择、会话权限与完全访问确认统一为深蓝渐变、浅紫强调的底部卡片；平板居中展示。
- 连接页提供带标签的地址与配对输入框、扫码入口、输入焦点、加载状态和行内错误。校验不通过时保留输入。
- 设备卡片区分在线、离线、当前设备和待选择状态，确认后才切换电脑。
- 权限卡片说明各模式，取消不保存；完全访问保留独立确认和连接器能力校验。
- 键盘弹出时内容可滚动，底部操作按钮保持可见。
- 配对成功清除已使用链接；取消连接使旧握手失效，旧连接回调不能影响新的连接尝试。

## 使用与限制

部署自己的 HTTPS 中继并生成配对二维码。在 App 顶部打开「连接 → 扫码」，扫描二维码，检查自动填入的中继地址后点「连接」。也可以手动填写中继地址并粘贴十分钟内有效的单次配对链接。已配对的 App 可以留空配对链接直接重连。连接后从顶部选择在线电脑，通过会话栏打开会话。[中继部署和配对](../docs/deployment.zh-CN.md)

支持 sessions.list、session.read、turn.start、turn.stop 及当前会话权限读取与修改。停止桌面所有者任务仍可能需要更完整的轮次参数。未确认的消息不自动重发。

当前不包含新建会话、原生附件传输、完整 Markdown、审批卡片、后台服务或通知。设备私钥保存在 App 私有设置中，Android 备份关闭。系统浏览器与 App 配对身份独立。

## 构建与验证

Windows 上运行 powershell -ExecutionPolicy Bypass -File build.ps1。依赖 JDK 21、Android SDK platform/build-tools 35、libs/zxing-core-3.5.3.jar。修改协议模块后须先通过 esbuild 打包 engine/protocol.ts 至 assets/protocol.js。

产物为 out/CodexAnywhere-0.6.3.apk。本地开发签名位于 out/development.jks，须保留以便覆盖更新，不要发布该密钥。

历史消息加载和前台自动同步已在 Android 16 上验证。消息发送状态、历史解析和连接恢复有独立测试。

## 来源

- 协议与加密：MIT 许可的 gaotong132/codex-anywhere，见 UPSTREAM-LICENSE。
- 扫码：ZXing core 3.5.3，Apache-2.0，见 assets/ZXING-LICENSE.txt。
- 业务组织参考 fabulouszcc/codex-lan-remote 的配对、会话目录与请求管理思想。其局域网 HTTP 协议未直接用于本客户端，未复制该项目代码。
