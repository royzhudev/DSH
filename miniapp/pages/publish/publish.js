const MAX_TITLE = 60;
const MAX_HASHTAGS = 5;

function safeDecode(value) {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch (err) {
    return value;
  }
}

function parseHashtags(raw) {
  return String(raw || "")
    .split(/[\s,，]+/)
    .map((item) => item.replace(/^#+/, "").trim())
    .filter(Boolean)
    .slice(0, MAX_HASHTAGS);
}

Page({
  data: {
    title: "",
    hashtags: "",
    videoUrl: "",
    videoPath: "",
    videoState: "尚未选择视频",
    downloading: false
  },

  onLoad(options) {
    const videoUrl = safeDecode(options.videoUrl || "");
    const title = safeDecode(options.title || "");
    const hashtags = safeDecode(options.hashtags || "");
    this.setData({ videoUrl, title, hashtags });
    if (videoUrl) this.downloadVideo(videoUrl);
  },

  onTitleInput(event) {
    this.setData({ title: event.detail.value });
  },

  onHashtagsInput(event) {
    this.setData({ hashtags: event.detail.value });
  },

  onChooseVideo() {
    tt.chooseVideo({
      sourceType: ["album"],
      compressed: false,
      success: (res) => {
        this.setData({ videoPath: res.tempFilePath, videoState: "已选择相册视频" });
      },
      fail: (err) => {
        if (String(err.errMsg || "").indexOf("cancel") === -1) {
          tt.showToast({ title: "选择视频失败", icon: "none" });
        }
      }
    });
  },

  onClearVideo() {
    this.setData({ videoPath: "", videoState: "尚未选择视频" });
  },

  downloadVideo(url) {
    if (!/^https:\/\//i.test(url)) {
      this.setData({ videoState: "链接必须是 https 地址" });
      return;
    }
    this.setData({ downloading: true, videoState: "正在下载平台成片…" });
    tt.downloadFile({
      url,
      success: (res) => {
        if (res.statusCode === 200 && res.tempFilePath) {
          this.setData({
            videoPath: res.tempFilePath,
            videoState: "已下载平台成片",
            downloading: false
          });
        } else {
          this.setData({ videoState: "下载失败，请改用相册选择", downloading: false });
        }
      },
      fail: () => {
        this.setData({ videoState: "下载失败，请改用相册选择", downloading: false });
      }
    });
  },

  chooseVideoForUpload() {
    return new Promise((resolve) => {
      tt.chooseVideo({
        sourceType: ["album"],
        compressed: false,
        success: (res) => resolve(res.tempFilePath || ""),
        fail: () => resolve("")
      });
    });
  },

  buildTitle() {
    const base = String(this.data.title || "").trim();
    const tags = parseHashtags(this.data.hashtags);
    let title = base;
    for (const tag of tags) {
      const suffix = title ? ` #${tag}` : `#${tag}`;
      if ((title + suffix).length > MAX_TITLE) break;
      title += suffix;
    }
    return title.slice(0, MAX_TITLE);
  },

  async onUploadDouyinVideo() {
    let videoPath = this.data.videoPath;
    if (!videoPath) {
      videoPath = await this.chooseVideoForUpload();
      if (videoPath) this.setData({ videoPath, videoState: "已选择相册视频" });
    }
    if (!videoPath) {
      tt.showToast({ title: "请先选择视频", icon: "none" });
      return { videoPath: "" };
    }

    return {
      videoPath,
      titleConfig: { title: this.buildTitle() },
      extra: { anchor: { anchorType: "none" } },
      success: (res) => {
        tt.showModal({
          title: "发布成功",
          content: res && res.videoId ? `视频 ID：${res.videoId}` : "已发布到抖音",
          showCancel: false
        });
      },
      fail: (res) => {
        tt.showModal({
          title: "发布失败",
          content: (res && res.errMsg) || "请重试",
          showCancel: false
        });
      }
    };
  }
});