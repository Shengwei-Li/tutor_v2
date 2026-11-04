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

```bash
tutordesk init ~/我的学生    # 建工作区，并让 OpenCode / Codex / Claude Code 认识它
tutordesk open ~/我的学生    # 打开备课台
```

然后在这个文件夹里打开 agent，说：「新学生王一然，高二，雅思 6.5 目标 7，每周二四晚上七点」。

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

`tutordesk open` 在本机开一个网页：本周课表、学生列表、学生页（画像、规划进度、课次）、计划确认、PDF 预览、生成家长页。文件一变自动刷新。

## 质量

`evals/` 放一组典型学生。改了技能或换了模型，就跑一遍完整流程，按评审清单打分，比较前后。

## 代码

```
v2/
├── skills/            给 agent 的技能（标准 SKILL.md）
├── src/               TypeScript，Node 24 直接运行，没有构建步骤
│   ├── workspace.ts   学生文件夹的读取和校验
│   ├── tex.ts         编译 PDF（Tectonic 或系统 XeLaTeX）
│   ├── tools.ts       三个工具和关卡：check_workspace、export_pdf、share_with_parents
│   ├── mcp.ts         MCP 服务器
│   ├── desk.ts        备课台
│   ├── share.ts       家长页和 .ics
│   ├── init.ts        建工作区，接上 Claude Code / OpenCode / Codex
│   └── cli.ts
├── templates/tex/     LaTeX 模板和字体（来自 v1）
└── test/
```

开发：

```bash
pnpm install
pnpm test
pnpm tutordesk init <文件夹>
pnpm tutordesk open <文件夹>
```

编译用 `~/.tutordesk/tectonic`，或 `TUTORDESK_TECTONIC` 指向的目录，否则用系统的 XeLaTeX。

## 还没做

- `tutordesk setup`：下载 Tectonic（v1 的 `apps/desktop/scripts/fetch-tectonic.mjs` 搬过来）。
- `evals/`：典型学生和评分。
- 打包成一个可执行文件。

v1（仓库根目录）冻结，只作参考。
