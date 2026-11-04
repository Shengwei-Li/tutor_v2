# 怎么测试 v2

## 1. 自动测试（1 分钟）

```bash
cd v2
pnpm install
pnpm test
```

本机没有 TeX 时，编译 PDF 的几项会跳过。想全部跑，先让它用 v1 下载好的 Tectonic：

```bash
export TUTORDESK_TECTONIC="D:/home_tutor/apps/desktop/resources/tectonic"
```

## 2. 当一次真老师（20 分钟）

**准备一个工作区。** 下面两条命令都在 `v2` 文件夹里运行，`TUTORDESK_TECTONIC` 要保持设置好：

```bash
pnpm tutordesk init D:/tutor-test --studio "我的工作室" --tutor "我"
```

```bash
pnpm tutordesk open D:/tutor-test
```

第一条命令会把 TutorDesk 接到 Claude Code、OpenCode 和 Codex 上。Codex 只认用户级配置，所以这一步会改 `~/.codex/config.toml` 里的 `[mcp_servers.tutordesk]` 一节，其余内容不动。第二条命令会在浏览器里打开备课台，让它一直开着。

**在 `D:/tutor-test` 里打开 agent**（Codex 应用、`codex` 或 `opencode`），然后照着做：

| 你说 / 你做 | 应该看到 |
|---|---|
| 「新学生王一然，高二，雅思 6.5 目标 7，12 月 29 日考试，每周二四晚 7 点上 90 分钟。写作 Task 2 不写立场，喜欢篮球。」 | 备课台自动刷新：学生列表出现她；「待你处理」里出现「规划」 |
| 点「复制给 agent」，粘贴给 agent | 学生页出现课程规划，进度 0/N |
| 「帮她备下周二的课」 | 本周课表里出现这节课，状态「计划待确认」，「待你处理」里出现「确认」 |
| 在备课台打开这节课，看计划，点「确认计划」 | 四段进度条走到「确认」；「待你处理」变成「写材料」 |
| 点「复制给 agent」，粘贴 | agent 写讲义和练习卷并导出；课次页右侧能翻看学生版和教师版 PDF |
| 课上完以后，告诉 agent「她这节课……」 | 课次变成「已上课」，规划里勾掉一行 |
| 学生页点「生成家长页」 | 打开手机样式的家长页；`share/` 里有 `index.html` 和 `lessons.ics` |

**值得故意试一下的：**

- 让 agent 跳过确认直接出 PDF：`export_pdf` 应该拒绝。
- 在 `plan.md` 里写错一项（比如 `status: soon`）：备课台和 `check_workspace` 都应指出是哪个文件、哪一项。
- 把 `share/index.html` 用微信发到手机上打开；把 `lessons.ics` 导入手机日历。
- 在 `notes.md` 写一句私人备注，再生成家长页：家长页里不应该出现这句话。

## 3. Codex 的一个坑

如果 Codex 报 `model is not supported when using Codex with a ChatGPT account`，是你的 `~/.codex/config.toml` 里默认模型在 CLI 上不可用。在 agent 里换一个模型，或用 `codex -m gpt-6-luna`。
