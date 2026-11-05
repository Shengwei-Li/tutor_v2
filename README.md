# TutorDesk v2

雅思 / PTE 一对一老师的备课工具。老师在自己的 agent（OpenCode、Codex、Claude Code）里说话，agent 按 TutorDesk 的流程备课；老师在浏览器里的「备课台」看课表、确认计划、预览 PDF。

## 三个部分

| 部分 | 是什么 | 谁用 |
|---|---|---|
| 技能（skills） | 备课流程和教学标准，标准 `SKILL.md` | agent |
| `tutordesk` 程序 | MCP 服务器 + 备课台网页 + 排版和检查 | agent 和老师 |
| 模板 | LaTeX 版式、主题、字体 | 排版时 |

对话、模型、登录、权限都由 agent 负责，TutorDesk 不重做。

## 老师怎么用

1. **装一次:** 下载 TutorDesk，双击。它会自己完成：
   - 把程序装进 `~/.tutordesk`；
   - 下载排版引擎；
   - 接上本机已有的 Codex、Claude Code 和 OpenCode；
   - 在「文档」里建好 `TutorDesk` 文件夹，放学生资料；
   - 在桌面放一个快捷方式；
   - 打开备课台。
2. **之后:** 打开 agent，直接说话，比如「新学生王一然，高二，雅思 6.5 目标 7，每周二四晚上七点」。
   - agent 一开，备课台就跟着起来。想看的时候说「打开备课台」，或者双击桌面快捷方式。
   - 想把学生资料放在别的文件夹，跟 agent 说一声，它会用 `setup_workspace` 建好。

老师不用敲任何命令。

## 数据：一个学生一个文件夹

```
students/wang-yiran/
├── profile.md        画像：开头 YAML（考试、目标、考期、上课时间），下面自由写
├── roadmap.md        课程规划：分阶段，每节课一行
├── notes.md          老师私人笔记（永远不对外）
├── lessons/2026-11-06-task2-position/
│   ├── plan.md       本节计划，status: draft → approved → ready → taught
│   ├── handout.tex   worksheet.tex   deck.tex
│   ├── record.md     课后记录：完成了什么、卡在哪、作业
│   └── out/          PDF
└── share/            家长页 index.html、课表 lessons.ics
```

文件是唯一的数据，备课台、家长页、课表都从这里生成。

## 教学流程

诊断 → 课程规划 → 单节计划 → **老师确认** → 写材料 → **检查** → 上课 → 课后记录 → 下一节计划引用记录

代码强制的三条：

1. 计划没确认（`status: approved`），不能出材料 PDF。
2. 检查没过，不能出 PDF。
3. 家长页只读画像、规划、课次和分数，从不读 `notes.md` 和课后记录里的老师备注。

其余交给技能和模型：每份材料在给老师前，按教学评审清单自查一遍。

## 备课台

随 agent 启动，也能从桌面快捷方式打开；只在本机，文件一变自动刷新：

- **待你处理**：要确认的计划、要备的课、要写的材料、要记录的课。需要 agent 做的，给一句话，点「复制给 agent」粘贴过去。
- **本周课表**：每节课一条四段进度（计划、确认、材料、上课），没备的时段也列出来。
- **学生页**：画像、课程规划、课次；生成家长页。
- **课次页**：计划、确认按钮、学生版和教师版 PDF。

怎么测试见 [TESTING.md](TESTING.md)。

## 质量

`evals/` 放一组典型学生。改了技能或换了模型，就跑一遍完整流程，按评审清单打分，比较前后。

## 代码

```
v2/
├── skills/             给 agent 的技能（标准 SKILL.md）
├── src/                TypeScript；开发时 Node 24 直接运行
│   ├── workspace.ts    学生文件夹的读取和校验
│   ├── tex.ts          编译 PDF（Tectonic 或系统 XeLaTeX）
│   ├── tectonic.ts     下载 Tectonic（校验哈希）并缓存离线所需的包
│   ├── tools.ts        关卡：check_workspace、export_pdf、share_with_parents
│   ├── mcp.ts          MCP 服务器：找到工作区，随 agent 启动备课台，另有 setup_workspace、open_desk
│   ├── desk.ts         备课台
│   ├── share.ts        家长页和 .ics
│   ├── home.ts         ~/.tutordesk 和「用哪个工作区」
│   ├── init.ts         建工作区；把技能和服务器接到各 agent
│   ├── install.ts      双击安装 / 卸载
│   └── cli.ts
├── scripts/build.mjs   打包成单个程序（Node SEA）
├── templates/tex/      LaTeX 模板和字体
└── test/
```

开发：

```bash
pnpm install
pnpm test
pnpm build                  # dist/tutordesk(.exe)
pnpm tutordesk init <文件夹>  # 自带技能和配置的开发工作区
```

打推送 `v*` 标签时，GitHub Actions 会分别构建 Windows、macOS 和 Linux 版，并发布到 Releases。

## 还没做

- `evals/`：典型学生和评分。
- 每个学生的版本历史和撤销。
- macOS 的签名和公证：现在双击未签名程序会被系统拦下。
- 插件市场（Codex、Claude）上架。

v1（仓库根目录）冻结，只作参考。
