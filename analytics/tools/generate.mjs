/*!
 * Deterministic synthetic event generator.
 *
 * Used by tools/make-sample.mjs (dashboard demo data) and by the local
 * collector's --seed flag (end-to-end pipeline testing). The shape and numbers
 * are realistic for a personal design portfolio: one dominant project, a long
 * platform case that loses readers gradually, a low-traffic "about" funnel.
 * This file is tooling only — it is never shipped to the static site.
 */

const PROJECTS = [
  { key: "douyin/douyin-platform", id: "douyin-platform", name: "抖音创作服务平台", experience: "douyin", company: "抖音", total: 25, content: 24, weight: 0.42, click: 0.11, firstExit: 0.2, drop: 0.13, dwell: 9 },
  { key: "douyin/douyin-ai-cover", id: "douyin-ai-cover", name: "抖音AI封面", experience: "douyin", company: "抖音", total: 10, content: 9, weight: 0.2, click: 0.14, firstExit: 0.24, drop: 0.16, dwell: 8 },
  { key: "douyin/douyin-other", id: "douyin-other", name: "抖音其他项目", experience: "douyin", company: "抖音", total: 6, content: 5, weight: 0.1, click: 0.1, firstExit: 0.26, drop: 0.2, dwell: 7 },
  { key: "douyin/douyin-ai-practice", id: "douyin-ai-practice", name: "个人AI转型实践", experience: "douyin", company: "抖音", total: 7, content: 6, weight: 0.11, click: 0.13, firstExit: 0.2, drop: 0.18, dwell: 9 },
  { key: "jd/jd-shufang", id: "jd-shufang", name: "京东数坊平台 · 营销数据", experience: "jd", company: "京东零售", total: 38, content: 37, weight: 0.1, click: 0.16, firstExit: 0.18, drop: 0.11, dwell: 11 },
  { key: "kingsoft/kingsoft-powerword", id: "kingsoft-powerword", name: "金山词霸", experience: "kingsoft", company: "金山办公", total: 11, content: 10, weight: 0.07, click: 0.18, firstExit: 0.22, drop: 0.17, dwell: 8 }
];

const REFERRERS = [
  { label: "直接访问", type: "direct", weight: 0.52 },
  { label: "github.com", type: "external", weight: 0.14 },
  { label: "mp.weixin.qq.com", type: "external", weight: 0.12 },
  { label: "www.linkedin.com", type: "external", weight: 0.08 },
  { label: "www.zhihu.com", type: "external", weight: 0.06 },
  { label: "站内跳转", type: "internal", weight: 0.08 }
];

const GEOS = [
  { country: "CN", region: "Beijing", city: "Beijing", continent: "AS", asn: 4808, as_org: "China Unicom", weight: 0.2 },
  { country: "CN", region: "Shanghai", city: "Shanghai", continent: "AS", asn: 4812, as_org: "China Telecom", weight: 0.17 },
  { country: "CN", region: "Zhejiang", city: "Hangzhou", continent: "AS", asn: 56041, as_org: "China Mobile", weight: 0.11 },
  { country: "CN", region: "Guangdong", city: "Shenzhen", continent: "AS", asn: 4134, as_org: "Chinanet", weight: 0.1 },
  { country: "CN", region: "Jiangsu", city: "Nanjing", continent: "AS", asn: 4837, as_org: "China Unicom", weight: 0.06 },
  { country: "CN", region: "Sichuan", city: "Chengdu", continent: "AS", asn: 9808, as_org: "China Mobile", weight: 0.04 },
  { country: "SG", region: "Singapore", city: "Singapore", continent: "AS", asn: 13335, as_org: "Cloudflare, Inc.", weight: 0.06 },
  { country: "US", region: "California", city: "San Jose", continent: "NA", asn: 13335, as_org: "Cloudflare, Inc.", weight: 0.06 },
  { country: "US", region: "New York", city: "New York", continent: "NA", asn: 14618, as_org: "Amazon.com, Inc.", weight: 0.03 },
  { country: "JP", region: "Tokyo", city: "Tokyo", continent: "AS", asn: 13335, as_org: "Cloudflare, Inc.", weight: 0.03 },
  { country: "GB", region: "England", city: "London", continent: "EU", asn: 2856, as_org: "BT", weight: 0.03 },
  { country: "CA", region: "Ontario", city: "Toronto", continent: "NA", asn: 812, as_org: "Rogers Communications", weight: 0.02 },
  { country: "AU", region: "New South Wales", city: "Sydney", continent: "OC", asn: 1221, as_org: "Telstra", weight: 0.02 },
  { country: "DE", region: "Bavaria", city: "Munich", continent: "EU", asn: 3320, as_org: "Deutsche Telekom", weight: 0.02 },
  { country: "FR", region: "Ile-de-France", city: "Paris", continent: "EU", asn: 3215, as_org: "Orange", weight: 0.02 },
  { country: "HK", region: "Hong Kong", city: "Hong Kong", continent: "AS", asn: 4760, as_org: "HKT", weight: 0.03 }
];

const EXIT_REASONS = ["back", "esc", "brand_home", "route"];
const FOLDS = ["about-highlights", "jd-duties", "douyin-duties"];

function mulberry32(seed) {
  let value = seed >>> 0;
  return function () {
    value += 0x6d2b79f5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateSampleEvents(options = {}) {
  const days = Math.max(2, Number(options.days) || 60);
  const now = Number(options.now) || Date.now();
  const rand = mulberry32(Number(options.seed) || 20261116);
  const events = [];
  let counter = 0;
  let visitorCounter = 0;

  const rnd = (min, max) => min + rand() * (max - min);
  const rndInt = (min, max) => Math.floor(rnd(min, max + 1));
  const chance = (probability) => rand() < probability;
  const pickWeighted = (items, weightKey = "weight") => {
    const total = items.reduce((sum, item) => sum + item[weightKey], 0);
    let roll = rand() * total;
    for (const item of items) {
      roll -= item[weightKey];
      if (roll <= 0) return item;
    }
    return items[items.length - 1];
  };
  const pick = (items) => items[Math.floor(rand() * items.length)];
  const makeId = (prefix) => `${prefix}_${(counter += 1).toString(36)}${Math.floor(rand() * 1e6).toString(36)}`;

  const visitors = [];
  const takeVisitor = (isNewProbability) => {
    if (!visitors.length || chance(isNewProbability)) {
      visitorCounter += 1;
      const visitor = {
        id: `v_sample${visitorCounter.toString(36)}`,
        firstDay: -1,
        returning: visitors.length > 0 && chance(0.32)
      };
      visitors.push(visitor);
      return visitor;
    }
    const visitor = visitors[Math.floor(rand() * visitors.length)];
    visitor.returning = true;
    return visitor;
  };

  const push = (session, name, ts, props) => {
    events.push({
      id: makeId("e"),
      ts: Math.round(ts),
      sid: session.sid,
      vid: session.vid,
      pid: session.pid,
      screen: session.screen || "home",
      name,
      country: session.geo ? session.geo.country : "",
      region: session.geo ? session.geo.region : "",
      city: session.geo ? session.geo.city : "",
      continent: session.geo ? session.geo.continent : "",
      asn: session.geo ? session.geo.asn || 0 : 0,
      as_org: session.geo ? session.geo.as_org || "" : "",
      props: Object.assign({}, props || {})
    });
  };

  // Boot probe events are page-scoped (sid/vid are placeholders) and must not
  // turn into sessions in the aggregation.
  const pushBoot = (bootId, name, ts, props) => {
    events.push({
      id: makeId("e"),
      ts: Math.round(ts),
      sid: "boot",
      vid: "boot",
      pid: bootId,
      screen: "boot",
      name,
      props: Object.assign({}, props || {})
    });
  };

  const dayStart = (date) => {
    const [year, month, day] = date.split("-").map(Number);
    return Date.UTC(year, month - 1, day, 0, 0, 0) - 8 * 3600 * 1000;
  };

  for (let dayOffset = days - 1; dayOffset >= 0; dayOffset -= 1) {
    const date = new Date(now - dayOffset * 86400000 + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const start = dayStart(date);
    const isCurrent = dayOffset < 30;
    const weekday = new Date(start + 8 * 3600 * 1000).getUTCDay();
    const weekendFactor = weekday === 0 || weekday === 6 ? 0.72 : 1;
    const growth = isCurrent ? 1 : 0.78;
    const sessionCount = Math.max(4, Math.round(rnd(34, 46) * weekendFactor * growth));

    for (let index = 0; index < sessionCount; index += 1) {
      // 09:00–23:00 local with morning / afternoon / evening peaks
      const hourRoll = rand();
      let hour;
      if (hourRoll < 0.2) hour = rndInt(9, 11);
      else if (hourRoll < 0.62) hour = rndInt(12, 17);
      else if (hourRoll < 0.92) hour = rndInt(18, 22);
      else hour = rndInt(23, 23);
      let ts = start + (hour * 3600 + rndInt(0, 3599)) * 1000;
      if (ts > now) ts = now - rndInt(1, 24) * 60000;

      const visitor = takeVisitor(0.5);
      const deviceRoll = rand();
      const mode = deviceRoll < 0.58 ? "mobile" : deviceRoll < 0.94 ? "desktop" : deviceRoll < 0.98 ? "tablet" : "short-landscape";
      const viewport = mode === "mobile" ? { w: 390, h: 844 } : mode === "tablet" ? { w: 1024, h: 768 } : mode === "short-landscape" ? { w: 844, h: 390 } : { w: 1440, h: 900 };
      const referrer = pickWeighted(REFERRERS);
      const session = {
        sid: makeId("s"),
        vid: visitor.id,
        pid: makeId("p"),
        screen: "home",
        geo: pickWeighted(GEOS),
        startedAt: ts,
        active: 0
      };
      const sessionNew = chance(0.6);
      const bootId = makeId("boot");
      const bootDuration = mode === "mobile" ? rndInt(1600, 4800) : rndInt(900, 3200);
      const bootStart = ts - bootDuration - rndInt(60, 220);
      pushBoot(bootId, "boot_start", bootStart, {
        path: "/tangyubao/",
        mode,
        vw: viewport.w,
        vh: viewport.h,
        dpr: mode === "mobile" ? 3 : 2,
        lang: "zh-CN",
        tz: "Asia/Shanghai",
        reduced_motion: false
      });
      if (chance(0.015)) {
        pushBoot(bootId, "boot_fail", bootStart + rndInt(5000, 10000), {
          reason: chance(0.6) ? "timeout" : "script_error",
          elapsed_ms: rndInt(5000, 10000),
          message: "script.js load failed",
          ready_state: "interactive",
          mode,
          vw: viewport.w,
          vh: viewport.h,
          dpr: mode === "mobile" ? 3 : 2
        });
        continue;
      }
      pushBoot(bootId, "boot_ready", ts - rndInt(80, 240), {
        duration_ms: bootDuration,
        slow: bootDuration > 3000,
        ready_state: "complete",
        cards: 6,
        mode,
        vw: viewport.w,
        vh: viewport.h,
        dpr: mode === "mobile" ? 3 : 2,
        ttfb: rndInt(250, 900),
        dom_ms: Math.round(bootDuration * 0.6),
        load_ms: Math.round(bootDuration * 0.95)
      });
      push(session, "page_view", ts, {
        screen: "home",
        path: "/tangyubao/",
        entry: "navigate",
        ref: referrer.type === "direct" ? "" : `${referrer.label}/`,
        ref_type: referrer.type,
        visitor_new: !visitor.returning,
        session_new: sessionNew,
        visits: visitor.returning ? rndInt(2, 9) : 1,
        vw: viewport.w,
        vh: viewport.h,
        dpr: mode === "mobile" ? 3 : 2,
        lang: "zh-CN",
        tz: "Asia/Shanghai",
        conn: mode === "mobile" ? "4g" : "wifi",
        mode,
        reduced_motion: false
      });

      const deepLink = chance(0.03);
      let duration = 0;
      let impressions = 0;
      let drags = 0;
      let hovers = 0;
      let maxProgress = 0;

      if (deepLink) {
        const project = pickWeighted(PROJECTS);
        session.screen = "viewer";
        duration += playViewer(session, project, ts + 800, { origin: "direct" });
      } else {
        const homeStart = ts + rndInt(300, 1600);
        push(session, "home_view", homeStart, {
          cards: 6,
          experiences: 3,
          visitor_new: !visitor.returning,
          session_new: sessionNew,
          returning: Boolean(visitor.returning),
          mode,
          vw: viewport.w,
          vh: viewport.h
        });

        // Which covers were actually on screen (horizontal stream).
        const visibleBase = mode === "mobile"
          ? [0.97, 0.34, 0.18, 0.11, 0.24, 0.16]
          : [0.98, 0.66, 0.4, 0.28, 0.52, 0.36];
        drags = chance(0.28) ? rndInt(1, 3) : 0;
        hovers = mode === "desktop" ? rndInt(0, 4) : 0;
        maxProgress = drags ? rnd(0.12, 1) : rnd(0, 0.08);
        const scrolledFactor = Math.min(1, maxProgress * 1.6);
        PROJECTS.forEach((project, projectIndex) => {
          const probability = Math.min(0.99, visibleBase[projectIndex] + scrolledFactor * (1 - visibleBase[projectIndex]));
          if (!chance(probability)) return;
          impressions += 1;
          push(session, "card_impression", homeStart + rndInt(700, 2200), {
            project: project.id,
            project_key: project.key,
            experience: project.experience,
            name: project.name,
            position: projectIndex + 1,
            ratio: rnd(0.55, 1),
            time_on_home_ms: rndInt(700, 2600)
          });
        });

        const scrollBuckets = [25, 50, 75, 100].filter((bucket) => maxProgress * 100 >= bucket);
        scrollBuckets.forEach((bucket) => {
          push(session, "stream_scroll", homeStart + rndInt(2000, 6000), { bucket, progress: Math.round(maxProgress * 100) });
        });

        const clickCount = chance(0.52) ? (chance(0.26) ? 2 : 1) : 0;
        const clicked = new Set();
        let cursor = homeStart + rndInt(2500, 9000);
        for (let click = 0; click < clickCount; click += 1) {
          const candidates = PROJECTS.filter((project) => !clicked.has(project.key) && PROJECTS.indexOf(project) < 6);
          if (!candidates.length) break;
          const weights = candidates.map((project) => ({ project, weight: project.weight * project.click * 10 }));
          const chosen = pickWeighted(weights, "weight").project;
          clicked.add(chosen.key);
          cursor += rndInt(800, 2600);
          push(session, "card_click", cursor, {
            project: chosen.id,
            project_key: chosen.key,
            name: chosen.name,
            experience: chosen.experience,
            company: chosen.company,
            mode: "home",
            position: PROJECTS.indexOf(chosen) + 1,
            exposed: true,
            time_on_home_ms: cursor - homeStart
          });
          duration = cursor - ts;
          session.screen = "viewer";
          cursor += playViewer(session, chosen, cursor + 300, { origin: "home", mode });
          session.screen = "home";
        }

        // About dialog: mostly from the header, sometimes from the profile card
        const aboutStart = cursor + rndInt(600, 4000);
        if (chance(isCurrent ? 0.22 : 0.16)) {
          const aboutId = makeId("ab");
          push(session, "about_open", aboutStart, {
            about_id: aboutId,
            source: chance(0.78) ? "header" : "profile",
            screen: "home",
            project: null
          });
          const fold = pick(FOLDS);
          if (chance(0.55)) push(session, "about_fold", aboutStart + rndInt(500, 2400), { about_id: aboutId, fold, open: true });
          const aboutDwell = rndInt(6000, 64000);
          if (chance(0.34)) {
            push(session, "resume_download", aboutStart + rndInt(3000, aboutDwell - 1000), {
              file: "tangyubao-resume-2026.pdf",
              source: "about",
              about_id: aboutId,
              screen: "home",
              since_about_open_ms: rndInt(2200, aboutDwell - 1200)
            });
          }
          if (chance(0.14)) {
            push(session, "contact_click", aboutStart + Math.max(1200, aboutDwell - 1800), {
              channel: chance(0.5) ? "tel" : "email",
              source: "about",
              screen: "home",
              project: null,
              page: null
            });
          }
          push(session, "about_close", aboutStart + aboutDwell, {
            about_id: aboutId,
            source: "header",
            screen: "home",
            duration_ms: aboutDwell,
            reason: "backdrop",
            side_scroll: rndInt(30, 100),
            main_scroll: rndInt(5, 80)
          });
          cursor = aboutStart + aboutDwell;
        }

        const homeEnd = cursor + rndInt(400, 3500);
        duration = homeEnd - ts;
        push(session, "home_exit", homeEnd, {
          duration_ms: homeEnd - homeStart,
          impressions,
          drags,
          hovers,
          max_progress: Math.round(maxProgress * 100),
          scroll_buckets: scrollBuckets.join(","),
          mode
        });
      }

      const end = ts + Math.max(6000, duration + rndInt(800, 5000));
      session.active = end - ts;
      push(session, "session_end", end, {
        reason: "hidden",
        duration_ms: end - ts,
        active_ms: end - ts,
        screens: deepLink ? "viewer" : "home>viewer>home",
        event_count: rndInt(8, 32),
        last_screen: "home",
        viewer_project: null,
        viewer_page: null
      });

      const vitals = {
        lcp_ms: mode === "mobile" ? rndInt(2100, 4800) : rndInt(1300, 3200),
        fcp_ms: mode === "mobile" ? rndInt(1200, 2600) : rndInt(700, 1600),
        cls: Math.round(rand() * 90) / 1000,
        inp_ms: rndInt(90, 380),
        ttfb_ms: rndInt(280, 900)
      };
      push(session, "web_vitals", end - 100, Object.assign({ stage: "final", load_ms: rndInt(1600, 5200), vw: viewport.w, vh: viewport.h, mode }, vitals));
      push(session, "page_load", ts + 900, {
        load_ms: rndInt(1500, 5200),
        dom_ms: rndInt(700, 2200),
        resources: rndInt(20, 60),
        transfer_kb: mode === "mobile" ? rndInt(900, 2400) : rndInt(1600, 4200),
        image_kb: mode === "mobile" ? rndInt(700, 2000) : rndInt(1300, 3600),
        mode
      });
      if (chance(0.025)) {
        push(session, "error", end - 300, {
          type: "resource",
          tag: "img",
          url: "/tangyubao/assets/works/bytedance/douyin-platform/08.png",
          page: "/tangyubao/#project/douyin/douyin-platform"
        });
      }
    }
  }

  return events.sort((a, b) => a.ts - b.ts);

  function playViewer(session, project, startTs, context) {
    const viewerId = makeId("vr");
    const mode = context.mode || "desktop";
    push(session, "viewer_open", startTs, {
      viewer_id: viewerId,
      project: project.id,
      project_key: project.key,
      name: project.name,
      experience: project.experience,
      company: project.company,
      pages: project.total,
      content_pages: project.content,
      origin: context.origin,
      visitor_new: false,
      mode
    });
    let page = 1;
    let cursor = startTs + rndInt(600, 1800);
    let totalDwell = 0;
    push(session, "artwork_load", cursor - 100, {
      project: project.id,
      project_key: project.key,
      page: 1,
      type: "image",
      phase: "initial",
      duration_ms: mode === "mobile" ? rndInt(500, 2200) : rndInt(250, 1200),
      success: true,
      variant_w: mode === "mobile" ? 1280 : 2560,
      mode
    });
    push(session, "viewer_slide", cursor, {
      viewer_id: viewerId,
      project: project.id,
      project_key: project.key,
      page: 1,
      total: project.total,
      content_pages: project.content,
      type: "image",
      source: "initial",
      first_view: true,
      prev_page: 0,
      prev_dwell_ms: 0
    });
    const slideDwell = () => rndInt(2600, project.dwell * 1000);
    while (page < project.total) {
      const exitChance = page === 1 ? project.firstExit : project.drop;
      if (chance(exitChance)) break;
      const dwell = slideDwell();
      totalDwell += dwell;
      cursor += dwell;
      page += 1;
      push(session, "viewer_slide", cursor, {
        viewer_id: viewerId,
        project: project.id,
        project_key: project.key,
        page,
        total: project.total,
        content_pages: project.content,
        type: page === project.total ? "thank" : page > project.content ? "thank" : chance(0.12) ? "stack" : "image",
        source: chance(0.72) ? "wheel" : chance(0.5) ? "thumbnail" : "keyboard",
        first_view: true,
        prev_page: page - 1,
        prev_dwell_ms: dwell
      });
      push(session, "artwork_load", cursor - 80, {
        project: project.id,
        project_key: project.key,
        page,
        type: "image",
        phase: "turn",
        duration_ms: mode === "mobile" ? rndInt(220, 1800) : rndInt(120, 1100),
        success: true,
        variant_w: mode === "mobile" ? 1280 : 2560,
        mode
      });
    }
    const lastDwell = rndInt(1800, 9000);
    totalDwell += lastDwell;
    cursor += lastDwell;
    push(session, "viewer_exit", cursor, {
      viewer_id: viewerId,
      project: project.id,
      project_key: project.key,
      experience: project.experience,
      total: project.total,
      content_pages: project.content,
      max_index: page,
      exit_index: page,
      slides_viewed: page,
      duration_ms: cursor - startTs,
      bounce: page <= 1,
      quick_exit: cursor - startTs < 5000,
      reached_last_content: page >= project.content,
      reached_thank: page >= project.total,
      max_percent: Math.round((page / project.total) * 100),
      fullscreen: chance(0.12),
      last_dwell_ms: lastDwell,
      exit_reason: pick(EXIT_REASONS)
    });
    return cursor - startTs;
  }
}
