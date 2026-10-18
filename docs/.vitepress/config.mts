import { defineConfig } from "vitepress";

export default defineConfig({
  base: "/pyruns/",
  title: "Pyruns",
  description: "Python 调参、批量实验、Shell 任务、GPU wait、GPU scheduler、显存与 GPU 空闲率阈值、多 GPU 排队、CLI 与 Web UI 运行管理",
  useWebFonts: false,
  themeConfig: {
    sidebar: [
      {
        text: "快速开始",
        items: [
          { text: "安装与快速开始", link: "/getting-started" },
          { text: "页面展示", link: "/showcase" },
        ],
      },
      {
        text: "核心指南",
        items: [
          { text: "配置架构详解", link: "/configuration" },
          { text: "批量生成语法", link: "/batch-syntax" },
          { text: "Web 界面操作", link: "/ui-guide" },
          { text: "命令行 CLI 控制", link: "/cli-guide" },
          { text: "GPU 空闲等待", link: "/cli-guide#gpu-wait" },
        ],
      },
      {
        text: "进阶参考",
        items: [
          { text: "开发者 API", link: "/api-reference" },
          { text: "架构及设计理念", link: "/architecture" },
          { text: "文件系统性能测量", link: "/performance" },
        ],
      },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/LthreeC/pyruns" },
    ],
  },
});
