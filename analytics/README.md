# 作品集埋点与数据看板

这套东西回答四个问题：**首页曝光够不够、各作品被点开多少、作品内从哪里流失、关于我和简历有没有被看/下载**。它由三层组成，站点本身保持纯静态、零依赖：

```
浏览器 (analytics.js + script.js)
        │  POST /collect（批量、sendBeacon、失败重试）
        ▼
Cloudflare Worker + D1（analytics/worker）
        │  GET /api/summary?days=30（Bearer Token）
        ▼
数据看板（analytics/dashboard.html，零依赖、可离线打开）
```

- 前端埋点：`analytics.js`（无 cookie、无第三方脚本、DNT/GPC 生效；未配置地址时只写本地调试环，不发请求）。
- 站点接线：`script.js` 里对卡片曝光/点击、查看器、关于我、简历下载等关键路径调用 `track()`；所有调用都有空值保护，analytics.js 被拦截也不影响作品集。
- 数据端：`analytics/summary.js` 是唯一聚合实现，Worker 与本地 collector 共用，保证「本地验证」和「线上」数字一致。
- 看板：KPI、漏斗、逐页到达/流失、关于我/简历转化、设备来源、Web Vitals、自动体验诊断。

---

## 1. 本地 5 分钟体验

```bash
# 在仓库根目录
node analytics/local/server.mjs --seed
```

打开：

- 作品集（走本地 collector）：<http://127.0.0.1:8788/>
- 看板（实时数据）：<http://127.0.0.1:8788/dashboard>
- 看板（内置示例数据）：<http://127.0.0.1:8788/dashboard?demo=1>

`--seed` 会生成 45 天合成事件，方便先看效果；数据落在 `analytics/local/.data/events.jsonl`（已 gitignore），删掉该目录即可清空。

本地站点的埋点地址通过 URL 参数临时指定（无需改代码）：

```
http://127.0.0.1:8788/?analytics_endpoint=http%3A%2F%2F127.0.0.1%3A8788%2Fcollect&analytics_debug=1&analytics_force=1
```

`analytics_debug=1` 会在控制台打印事件，并写入 `localStorage.pf_a1_ring`（最多 200 条）；`analytics_force=1` 用于跳过 DNT 以便本地测试。

直接双击 `analytics/dashboard.html` 也能打开（使用内置示例数据，不发请求）。

---

## 2. 指标口径（看板与文档统一使用）

| 指标 | 定义 | 说明 |
|---|---|---|
| 访问会话 | 30 分钟无操作即新会话；`sessionStorage` 保存会话 ID | 页面刷新不新开会话 |
| 独立访客 | 匿名 `visitor_id`（localStorage 随机串）去重 | 无 cookie，不能跨设备 |
| 首页曝光会话 | 看到首页（`home_view`）的会话数 | 深链直达作品页不计入 |
| 封面曝光 | 卡片至少 **50% 面积可见、持续 500ms** 的去重计次 | 同一页面加载内每张卡只记一次 |
| 作品点击 | 首页/项目页点击封面的次数 | 含 `other_project_click`（末页面板） |
| 点击会话率 | 有作品点击的会话 / 有封面曝光的会话 | 比纯点击/曝光更抗刷 |
| 作品打开 | 进入作品查看器的次数（可来自点击、深链、末页面板） | 因此「打开/点击」可能 >100% |
| 首屏跳出 | 只看第 1 页就退出 / 全部作品打开 | 衡量第一页与操作引导 |
| 平均浏览深度 | 最远页码 / 总页数 | 包含 THANK 页分母 |
| 看到末页（完成率） | 到达最后一个内容页（不含 THANK） | 与「看到 THANK」分开统计 |
| 关于我打开率 | 打开过弹窗的会话 / 全部会话 | 两个入口合并 |
| 简历下载 | 点击 `.about-download` 的次数 / 会话 | 是「下载意图」；浏览器是否落盘无法判断 |
| 下载 / 关于我 | 下载次数 / 关于我打开次数 | 衡量弹窗内转化 |
| 网页打开成功率 | `boot_ready` / `boot_start` | 内联启动探针统计，独立于 analytics.js；超时/关键脚本失败计失败 |
| 应用就绪耗时 | `boot_ready.duration_ms` | 导航开始 → 首页/查看器渲染完成；p75、慢打开率（>3s） |
| 打开失败原因 | `boot_fail.reason` | timeout / js_error / script_error / incomplete |
| 作品图片加载 | `artwork_load.duration_ms` | 选图到解码完成，**不含** 640ms 翻页动画；分首屏页/翻页 |
| 平均会话时长 | `session_end.active_ms`（隐藏标签页时间不计） | 30 分钟会话上限 |
| Web Vitals | LCP / CLS / INP / TTFB 的 p75 | 按页面实例取最终值 |
| 无交互会话 | 只看首页、无滚动/点击/打开/关于我/下载 | 首页第一眼是否讲清价值 |

> 看板里的「示例数据」是合成数据，不能当真实业务结论；它的作用是演示看板与验证口径。

---

## 3. 事件字典

所有事件字段：`id, ts, sid, vid, pid, screen, name, props`（`props` 只允许字符串/数字/布尔，单值 ≤200 字符）。

| 事件 | 触发时机 | 关键 props |
|---|---|---|
| `boot_start` | `index.html` 内联探针，页面脚本开始执行 | `path, ref, mode, vw, vh, dpr, lang, tz, reduced_motion` |
| `boot_ready` | 应用真正渲染完成（不再 `is-booting`、首页有卡片/查看器已激活） | `duration_ms, slow, ready_state, cards, mode, ttfb_ms, dom_ms, load_ms` |
| `boot_fail` | 超时/关键脚本失败/JS 错误 | `reason, elapsed_ms, message, ready_state, mode` |
| `page_view` | 页面加载（每页一次） | `screen, path, boot_id, ref, ref_type, visitor_new, session_new, visits, vw, vh, dpr, lang, tz, conn, mode, reduced_motion, utm_*` |
| `screen_view` | 屏幕切换（home/projects/viewer） | `screen, from, dwell_ms, path` |
| `home_view` | 每次进入首页 | `cards, experiences, visitor_new, session_new, returning, mode, vw, vh` |
| `home_exit` | 离开首页 | `duration_ms, impressions, drags, hovers, max_progress, scroll_buckets, mode` |
| `card_impression` | 卡片 ≥50% 可见 500ms | `project, project_key, experience, name, position, ratio, time_on_home_ms` |
| `card_click` | 点击首页/项目页封面 | `project, project_key, experience, company, mode, position, exposed, time_on_home_ms` |
| `stream_scroll` | 横向流拖到 25/50/75/100% | `bucket, progress` |
| `experience_open` | 进入经历项目页（兜底路径） | `experience, company, from, mode` |
| `viewer_open` | 打开作品查看器 | `viewer_id, project, project_key, name, experience, company, pages, content_pages, origin, visitor_new, mode` |
| `viewer_slide` | 每次切换页面（含叠层页） | `viewer_id, project, page, total, content_pages, type(image/composite/stack/thank), source(initial/thumbnail/wheel/keyboard/swipe/click), first_view, prev_page, prev_dwell_ms` |
| `stack_step` | 叠层页切层 | `project, page, from_layer, to_layer, total_layers, direction, source` |
| `artwork_load` | 作品页图片加载/解码完成（每次选图） | `project, project_key, page, type, phase(initial/turn), duration_ms, success, variant_w, mode` |
| `viewer_exit` | 离开查看器 / 关闭页面 | `viewer_id, project, total, content_pages, max_index, exit_index, slides_viewed, duration_ms, bounce, quick_exit, reached_last_content, reached_thank, max_percent, fullscreen, last_dwell_ms, exit_reason` |
| `fullscreen_toggle` | 进入/退出全屏 | `entering, project, page` |
| `video_play` | 复合页视频播放 | `project, page, video_id, label, muted` |
| `other_project_click` | 末页「其他项目」面板 | `from_project, from_experience, from_page, to_project, to_experience` |
| `about_open` | 打开「关于我」 | `about_id, source(header/profile), screen, project, page` |
| `about_close` | 关闭「关于我」 | `about_id, source, screen, duration_ms, reason, side_scroll, main_scroll` |
| `about_fold` | 展开/收起弹窗内折叠块 | `about_id, fold(about-highlights/jd-duties/douyin-duties), open` |
| `resume_download` | 点击下载简历 | `file, source, about_id, screen, since_about_open_ms` |
| `contact_click` | 点击 tel:/mailto: | `channel(tel/email), source(header/about/thank/viewer), screen, project, page` |
| `link_click` | 点击作品页热区链接 | `project, page, label, host` |
| `heartbeat` | 可见时每 20s | `active_ms, since_start_ms, viewer_project, viewer_page` |
| `session_end` | 隐藏/关闭页面 | `reason, duration_ms, active_ms, screens, event_count, last_screen, viewer_project, viewer_page` |
| `web_vitals` | 加载 20s 与关闭页面 | `stage(early/final), lcp_ms, fcp_ms, cls, inp_ms, ttfb_ms, load_ms, mode` |
| `page_load` | load 后 0.8s | `load_ms, dom_ms, resources, transfer_kb, image_kb, mode` |
| `error` | JS / Promise / 资源错误 | `type(js/promise/resource), message, url, tag, line` |

事件是**追加**关系：删除字段前先升级看板与聚合；新增事件时在 `summary.js` 里消费它即可。

---

## 4. 部署到 Cloudflare（免费额度足够个人作品集）

前置：Cloudflare 账号、`npx`（Node 18+）。仓库**不新增** `package.json`，所有命令用 `npx wrangler@4`。

```bash
cd analytics/worker

# 1) 登录（浏览器授权）
npx wrangler@4 login

# 2) 建 D1 数据库，把输出的 database_id 填进 wrangler.toml
npx wrangler@4 d1 create tangyubao-analytics

# 3) 建表
npx wrangler@4 d1 migrations apply tangyubao-analytics --remote

# 4) 设置看板令牌（自己生成一个长随机串，别用弱口令）
npx wrangler@4 secret put DASHBOARD_TOKEN

# 5) 部署
npx wrangler@4 deploy
```

部署成功会得到 `https://<worker>.<account>.workers.dev`。验收：

```bash
curl -s https://<worker>/health
# {"ok":true,"version":"1.0.0","token_configured":true,...}

curl -s -X POST https://<worker>/collect \
  -H 'Content-Type: text/plain' \
  -d '{"site":"tangyubao-portfolio","events":[{"id":"e_test_1","name":"page_view","ts":'"$(date +%s000)"',"sid":"s_test","vid":"v_test","pid":"p_test","props":{"screen":"home"}}]}'
# {"ok":true,"accepted":1,...}

curl -s 'https://<worker>/api/summary?days=7&token=<DASHBOARD_TOKEN>' | head -c 200
```

### 4.1 让作品集开始上报

二选一（改一处即可）：

1. 在 `index.html` 里取消注释并填地址：
   ```html
   <meta name="portfolio-analytics-endpoint" content="https://<worker>/collect">
   ```
2. 在 `analytics.js` 顶部把 `ANALYTICS_ENDPOINT` 改成同一个地址。

然后部署 GitHub Pages。刷新线上页面，看板出现数据即成功。

### 4.2 看板怎么连线上数据

看板默认已指向本项目部署的 Worker（`dashboard.html` 内的 `DEFAULT_API`），所以**直接打开就是实时数据**：

```
https://tangyubao33.github.io/tangyubao/analytics/dashboard.html
```

首次会提示输入 `DASHBOARD_TOKEN`，存在 `sessionStorage`，同一标签页刷新无需再输。手机/新浏览器可以收藏带令牌的一次性链接：

```
https://tangyubao33.github.io/tangyubao/analytics/dashboard.html#token=<DASHBOARD_TOKEN>
```

`#` 后面的内容不会出现在 Referer 里，但会留在地址栏/浏览器历史，**只当作个人书签使用，不要公开分享**。`?api=https://<worker>` 仍可覆盖默认地址（用于其他 Worker 实例），`?demo=1` 查看内置示例数据。

看板支持：7/14/30/90 天切换、刷新、导出 CSV、点击项目查看逐页到达率、点击图例切换趋势指标、自动体验诊断；「打开成功率 & 加载性能」板块包含启动探针成功率、失败原因、应用就绪耗时、LCP/FCP/TTFB/DOM/load/CLS/INP、首屏体积、作品页图片加载 p75 和资源失败。

> 看板本身是静态文件；**不部署也没关系**，本地打开即可。仓库里带的是示例数据，不含真实访问记录。

### 4.3 国内访问建议

- `*.workers.dev` 在中国大陆部分网络下不可达。**强烈建议给 Worker 绑定自定义域名**（Cloudflare DNS 即可，如 `stats.yourdomain.com`），上报地址用自定义域名。
- GitHub Pages 本身在国内也可能慢/间歇不可达；作品集若主要给国内 HR 看，建议同时绑定自定义域名接 CDN。
- 看板是纯静态 HTML，可以放本机、内网或任意静态托管，不依赖 Worker 的页面服务。

### 4.4 成本与限额（2026 年免费额度参考）

- Workers：10 万请求/天；每次上报是一个请求（批量最多 30 条事件）。
- D1：5 GB 存储、500 万行读/天、10 万行写/天。个人作品集每天几十个访客，远低于限额。
- 数据保留 180 天（`wrangler.toml` 的 cron 会每天清理）；需要长期保留就在清理前 `d1 export`。

---

## 5. 本地开发、回归与校验

```bash
# 静态站点 + 本地 collector（不写入任何线上数据）
node analytics/local/server.mjs --port 8788

# 重新生成看板示例数据（改事件模型/看板后执行）
node analytics/tools/make-sample.mjs

# 聚合不变量回归（无需浏览器、无需依赖）
node analytics/tools/verify-summary.mjs

# 只做静态检查
node --check analytics.js
node --check script.js
```

本地 collector 与 Worker 的 HTTP 契约一致：`POST /collect`、`GET /api/summary?days=`、`GET /api/raw?limit=`、`GET /api/health`。看板在 `http://127.0.0.1:8788/dashboard` 时直接读同源 API，无需令牌。

**新增/修改事件后**：`analytics.js`（采集）→ `script.js`（触发）→ `summary.js`（聚合）→ `dashboard.html`（呈现）→ `tools/generate.mjs`（示例）→ `make-sample.mjs` → `verify-summary.mjs`。顺序跑一遍即可。

### 新增作品时

`analytics/summary.js` 顶部的 `PROJECTS` 是看板作品表的注册表（名称、公司、内容页数、总页数）。新增作品后同步这一处；否则事件仍会记录，但作品表/逐页图不会显示该作品。改完重新生成示例数据。

---

## 6. 数据契约（`/api/summary` 返回结构）

看板只依赖以下字段；改结构时同步改 `dashboard.html` 与本文档。

```
{
  ok, source, range: { from, to, days },
  current: {
    meta: { generated_at, from, to, event_count, session_count, truncated, site },
    overview: { sessions, visitors, pageviews, home_sessions, home_views, impressions,
                impression_sessions, card_clicks, ctr, click_session_rate,
                viewer_opens, viewer_sessions, viewer_exits, viewer_avg_depth_pct,
                viewer_avg_ms, viewer_bounce_rate, viewer_completion_rate,
                about_opens, about_open_sessions, about_open_rate,
                resume_downloads, resume_download_sessions, resume_download_rate,
                resume_per_open, avg_session_ms, no_interaction_rate, errors, ... },
    daily: [{ date, visitors, sessions, pageviews, home_views, impressions,
              card_clicks, viewer_opens, about_opens, resume_downloads }],
    projects: [{ key, id, name, experience, company, total, content,
                 impressions, impression_sessions, clicks, click_sessions, ctr,
                 click_session_rate, viewer_opens, viewer_sessions, avg_depth_pct,
                 avg_ms, bounce_rate, completion_rate, thank_rate,
                 top_dropoff: { page, lost, pct_lost },
                 slide_reach: [{ page, reached, pct, dwell_ms }] }],
    about: { opens, open_sessions, open_rate, avg_ms, downloads, download_sessions,
             download_rate, per_open, by_source, by_screen, avg_side_scroll,
             avg_main_scroll, folds, contact },
    home: { sessions, views, avg_ms, avg_impressions, avg_drags, avg_hovers, scroll_buckets },
    viewer: { opens, exits, avg_depth_pct, avg_ms, bounce_rate, completion_rate,
              thank_rate, reach_by_percent, exit_reasons, sources, projects },
    funnel: { browse: [...], convert: [...] },
    devices: [{ name, sessions, pct, viewer_opens, bounce_rate, completion_rate, avg_depth_pct }],
    referrers: [{ name, sessions, pct }],
    vitals: { samples, lcp_p75, fcp_p75, load_p75, cls_p75, inp_p75, ttfb_p75 },
    load: { samples, avg_transfer_kb, avg_image_kb, avg_load_ms, avg_resources,
            load_p75_ms, dom_p75_ms, transfer_kb_p75, image_kb_p75, resources_p75 },
    boot: { attempts, successes, failures, incomplete, success_rate,
            p50_ms, p75_ms, avg_ms, slow_open_rate, fail_reasons, by_mode },
    artwork: { count, failures, p50_ms, p75_ms, avg_ms, slow_rate, by_phase, by_project },
    resource_errors: { count, pages, rate, top },
    errors: [{ type, message, url, count, lastTs }],
    actions: { resume_downloads, contact_clicks, fullscreen_enters, video_plays, other_project_clicks }
  },
  previous: { ...same shape... }
}
```

`current`/`previous` 让看板计算环比；`truncated=true` 表示单次查询达到 3 万行上限（个人站一般不会触发；触发后缩小时间范围或后续改成分页聚合）。

---

## 7. 运维

```bash
# 备份（SQL 文本）
npx wrangler@4 d1 export tangyubao-analytics --remote --output analytics-backup.sql

# 查看表结构/数据量
npx wrangler@4 d1 execute tangyubao-analytics --remote --command "SELECT COUNT(*) FROM events"

# 按访客 ID 删除（用于「删除我的数据」请求）
npx wrangler@4 d1 execute tangyubao-analytics --remote \
  --command "DELETE FROM events WHERE vid = 'v_xxx'"

# 清空全部
npx wrangler@4 d1 execute tangyubao-analytics --remote --command "DELETE FROM events"

# 轮换令牌
npx wrangler@4 secret put DASHBOARD_TOKEN

# 撤销某个上报地址：把 index.html 的 meta 去掉即可，Works 端可加 Cloudflare WAF 限流
```

- 数据保留：cron 每天 03:17 UTC 删除 180 天前事件（`worker/src/index.js` 的 scheduled）。
- 上报端限流：建议在 Cloudflare 控制台给 `/collect` 加 Rate limiting（如 60 次/分钟/IP）。Worker 内只做体积、字段与时间校验。
- 错误排查：`GET /api/raw?limit=50&token=...` 看最近原始事件；`/health` 看 D1 与令牌是否配置。
- 前端被广告拦截：自定义域名 + 同源路径（如 `/collect` 反代）可进一步降低被拦截概率；当前不依赖任何第三方脚本。

---

## 8. 隐私与合规

- **没有 Cookie**，不写指纹、不采集页面内容/输入、不存 IP、不存 User-Agent、不接第三方。
- 仅存：匿名 `visitor_id`（localStorage，随机）、会话 ID（sessionStorage）、页面事件与上文列出的 props；Worker 只额外记录 Cloudflare 边缘提供的国家代码。
- `Do Not Track` / `Global Privacy Control` 默认直接关闭采集（不上报、不写本地队列）。
- 页面加载前后完全可移除：删掉 `index.html` 里的 `analytics.js` 一行即可；历史数据用上面的 SQL 删除。
- 若面向欧盟用户，建议在「关于我」弹窗或页脚加一句说明：*本站使用匿名访问统计（无 Cookie，不收集个人信息）*；这属于「严格必要/匿名统计」范畴，通常无需同意横幅，但请按你所在法域自行确认。
- 看板令牌只在请求头/会话存储中出现；`dashboard.html` 带 `noindex`，但文件本身是公开的静态页面（只有示例数据与代码，没有真实事件）。

---

## 9. 常见问题

| 现象 | 排查 |
|---|---|
| 线上看板一直「示例数据」 | `?api=` 地址是否带协议；Worker 是否部署；控制台是否有 CORS/网络错误；换个网络试 `workers.dev` |
| 看板提示需要令牌 / 401 | 输入 `DASHBOARD_TOKEN`；或用 `#token=...` 打开；确认 `wrangler secret` 已生效（重新 deploy 不必，secret 立即生效） |
| 有访问但没有事件 | 打开站点控制台看 `[analytics]` 日志；确认 meta/`ANALYTICS_ENDPOINT` 已填；DNT 是否开启；`/health` 是否 200 |
| 事件有重复 | 客户端每个事件有唯一 `id`，服务端 `INSERT OR IGNORE` 去重；看聚合按 `id` 去重 |
| 点击/曝光数对不上 | 曝光有 50%+500ms 门槛；快速划过不计；深链打开作品不产生曝光 |
| 移动端榜单/图表溢出 | 看板最大宽度 1320px、表格横向可读；如仍异常，把浏览器宽度和截图发我 |
| 想只统计某些页面 | 在 `script.js` 的 `track()` 调用处加条件，或看板按 screen 扩展筛选 |

---

## 10. 文件地图

```
analytics.js                    采集器（无依赖，站点唯一新增运行时文件）
analytics/
├── summary.js                  共享聚合（Worker / 本地 / 示例生成共用）
├── dashboard.html              数据看板（自包含，支持实时/示例/离线）
├── sample-summary.js           看板内置示例数据（合成，make-sample 生成）
├── README.md                   本文
├── 体验分析报告.md              走查结论 + 上线后怎么读数据 + 优化优先级
├── local/server.mjs            本地站点 + collector（同构 API，--seed 可造数）
├── worker/
│   ├── wrangler.toml           Worker/D1 配置
│   ├── migrations/0001_init.sql
│   └── src/index.js            /collect、/api/summary、/api/raw、/health、保留策略
└── tools/
    ├── generate.mjs            确定性合成事件生成器
    ├── make-sample.mjs         生成 sample-summary.js
    └── verify-summary.mjs      聚合不变量回归
```

端点相关改动只碰 `analytics/`，站点仍然保持「index.html + styles.css + script.js + 素材」的纯静态结构。
