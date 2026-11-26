# 抖音小程序发布助手（个人主体）

个人抖音号无法创建网站应用，因此拿不到 `client_key` / `client_secret`，不能走 OAuth `video.create`，也不能走需要 `client_key` + `signature` 的 H5 投稿。

这个原生小程序走抖音官方的 **短视频自主挂载** + **发布抖音视频 JSAPI**：在小程序里选择（或从平台下载）成片，拉起抖音发布页，由你确认后发布到自己的抖音号。

> 这是小程序端源码，不是网页端的静默自动发布。平台侧“一键跳转小程序”还需要你的小程序 `appid`、挂载能力审核通过、以及成片的公网 https 地址；这些就绪后再接。

## 前置条件

1. **个人主体小程序**：在[抖音开放平台](https://developer.open-douyin.com/)控制台创建一个小程序，主体选个人；拿到 `appid`。
2. **短视频自主挂载能力**：控制台 → 你的小程序 → 能力 → 挂载 → 短视频挂载 → 短视频自主挂载 → 申请开通。平台审核约 2~3 个工作日，要求小程序功能/内容/体验达标，页面必须是原生页面（不能是 webview），且避免“单一功能/功能简单”。
3. **绑定普通抖音号**：个人主体小程序绑定你本人的普通抖音号（或另一个普通抖音号）。要求：已实名认证的成年人、近 90 天无违规；短视频挂载权益要求账号有效粉丝数 **> 500**（图文 > 1000）。
4. **真机**：`发布抖音视频` JSAPI 在 IDE 和非抖音宿主里不支持，必须在抖音 App 内用真机调试。

## 目录

```
miniapp/
├── app.json                  # 页面与窗口配置
├── app.js
├── app.ttss
├── project.config.json       # 把 appid 换成你自己的
├── pages/publish/
│   ├── publish.json
│   ├── publish.ttml          # 发布页
│   ├── publish.ttss
│   └── publish.js            # onUploadDouyinVideo 钩子
└── README.md
```

## 配置与运行

1. 把 `project.config.json` 里的 `"appid": "testAppId"` 换成你的小程序 `appid`。
2. 用[抖音开发者工具](https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/developer-instrument/development-assistance/developer-tool)打开 `miniapp/` 目录。
3. 在“开发设置 → 服务器域名 → downloadFile 合法域名”里加入**成片所在的 https 域名**（只有用 `videoUrl` 参数下载时才需要；从相册选择不需要）。
4. 真机预览：用抖音扫码打开开发版/体验版；`发布抖音视频` 按钮只会在抖音 App 内生效。

## 使用

### 方式 A：从手机相册选择（最简单，先跑通）

1. 在本平台生成成片，在手机浏览器打开任务页点“下载”把 MP4 保存到手机（或在电脑下载后传到手机）。
2. 打开这个小程序，输入标题/话题，点“从相册选择”，选中刚下载的视频。
3. 点“发布到抖音”，在抖音发布页确认后发布。

### 方式 B：带 `videoUrl` 打开（平台侧对接后用）

小程序页面支持查询参数：

```
pages/publish/publish?videoUrl=<公网 https mp4>&title=<标题>&hashtags=<空格分隔的话题>
```

参数值需要 URL 编码（尤其是 `&`、空格和中文）。

打开后小程序会先 `tt.downloadFile` 把成片下载为本地临时文件，再让你确认发布。`videoUrl` 必须是公网可访问的 https 地址，且域名已加入 downloadFile 合法域名。

## 已知限制

- `发布抖音视频` JSAPI **已标记为逐步废弃**（基础库 2.65.0），官方建议后续参考“转发和挂载”；目前仍可用，但需要关注平台变更。
- `videoPath` 只支持本地 `ttfile` 文件，**不支持直接传网络视频地址**；所以方式 B 要先下载。
- 下载得到的临时文件能否被 JSAPI 接受取决于抖音版本；失败时请改用相册选择。
- 发布必须由用户在抖音发布页手动确认，**没有服务端静默代发**。
- 自主挂载能力审核不保证通过；一个“只做发布”的单一功能小程序可能被驳回，可能需要在里面补充真实内容/功能。
- 本目录只包含小程序端；平台侧的“发送到小程序”二维码/链接、签名公网视频地址、任务页入口还没接，需要等 `appid` 和挂载审核就绪。

## 参考

- 短视频自主挂载：https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/open-capacity/flow-entrance/douyin/video/self-mount
- 发布抖音视频 JSAPI：https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/develop/api/open-interface/video-capacity/upload-douyin-video/
- 自主挂载开通规范：https://developer.open-douyin.com/docs/resource/zh-CN/mini-app/operation/platform-capabilities/video/self-mount-activate-spec