# AutoDL 文档快照

## 为什么存档

AutoDL 的文档会变。部署逻辑依赖这些端点与字段，必须能离线查到当时的口径。

## 文件

| 文件 | 来源 |
|---|---|
| `common_api.md` | https://www.autodl.com/docs/common_api/ |
| `instance_pro_api.md` | https://www.autodl.com/docs/instance_pro_api/ |
| `facts.md` | 逐条事实核对，含来源 URL |

`facts.md` 是人工整理的事实清单，不是官方原文。它的每条结论都附来源。

## 抓取日期

2026-11-24。

## 更新方式

```bash
node scripts/fetch-autodl-docs.mjs
```

脚本会重写 `common_api.md` 与 `instance_pro_api.md`，文件头写入新的抓取日期。

`facts.md` 是人工整理的，脚本不更新它。平台变更后要人工复核。

## 注意

第一，快照只用于查阅。运行时不得依赖快照文件的格式。

第二，官方页面改版会让抓取脚本失效。失效时按 `.md-content` 的新结构调整提取逻辑。

第三，本目录不含任何凭据。
