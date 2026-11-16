/*!
 * Portfolio analytics — shared aggregation.
 *
 * One implementation is used by the Cloudflare Worker (production), the local
 * collector (development) and the sample-data generator, so the dashboard and
 * the docs always describe exactly the same numbers.
 *
 * Input: raw events `{ id, ts, sid, vid, pid, screen, name, props }`.
 * Output: the JSON contract consumed by analytics/dashboard.html
 * (see analytics/README.md § 数据契约).
 */

export const PROJECTS = [
  { key: "douyin/douyin-platform", id: "douyin-platform", name: "抖音创作服务平台", experience: "douyin", company: "抖音", content: 24, total: 25 },
  { key: "douyin/douyin-ai-cover", id: "douyin-ai-cover", name: "抖音AI封面", experience: "douyin", company: "抖音", content: 9, total: 10 },
  { key: "douyin/douyin-other", id: "douyin-other", name: "抖音其他项目", experience: "douyin", company: "抖音", content: 5, total: 6 },
  { key: "douyin/douyin-ai-practice", id: "douyin-ai-practice", name: "个人AI转型实践", experience: "douyin", company: "抖音", content: 6, total: 7 },
  { key: "jd/jd-shufang", id: "jd-shufang", name: "京东数坊平台 · 营销数据", experience: "jd", company: "京东零售", content: 37, total: 38 },
  { key: "kingsoft/kingsoft-powerword", id: "kingsoft-powerword", name: "金山词霸", experience: "kingsoft", company: "金山办公", content: 10, total: 11 }
];

export const TZ_OFFSET_MINUTES = 480; // dashboard days follow Asia/Shanghai

const DAY_MS = 86400000;
const HEARTBEAT_CAP_MS = 30 * 60 * 1000;

const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);
const round = (value, digits = 0) => {
  if (!isFinite(value)) return 0;
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
};
const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);

export function percentile(values, ratio) {
  const clean = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!clean.length) return 0;
  const index = Math.min(clean.length - 1, Math.max(0, Math.ceil(ratio * clean.length) - 1));
  return clean[index];
}

function propsOf(event) {
  const raw = event.props;
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    return {};
  }
}

function normalize(event) {
  return {
    id: String(event.id || ""),
    ts: Number(event.ts) || 0,
    sid: String(event.sid || ""),
    vid: String(event.vid || ""),
    pid: String(event.pid || ""),
    screen: String(event.screen || ""),
    name: String(event.name || ""),
    props: propsOf(event),
    country: String(event.country || ""),
    region: String(event.region || ""),
    city: String(event.city || ""),
    continent: String(event.continent || "")
  };
}

function dayKey(ts, offsetMinutes) {
  return new Date(ts + offsetMinutes * 60000).toISOString().slice(0, 10);
}

function hostOf(ref) {
  if (!ref) return "";
  return String(ref).split("/")[0].split("?")[0].slice(0, 80);
}

function bound(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function trackBootEventFactory(boots) {
  return function trackBootEvent(event) {
    const props = event.props || {};
    const pid = event.pid || event.id;
    let boot = boots.get(pid);
    if (!boot) {
      boot = { pid, startTs: event.ts, lastTs: event.ts, ready: null, fail: null, mode: String(props.mode || ""), path: String(props.path || "") };
      boots.set(pid, boot);
    }
    boot.lastTs = Math.max(boot.lastTs || 0, event.ts);
    if (event.name === "boot_start") {
      boot.startTs = Math.min(boot.startTs || event.ts, event.ts);
      boot.mode = String(props.mode || boot.mode || "");
      boot.path = String(props.path || boot.path || "");
    } else if (event.name === "boot_ready") {
      boot.ready = props;
      if (!boot.mode) boot.mode = String(props.mode || "");
    } else if (event.name === "boot_fail") {
      boot.fail = props;
      if (!boot.mode) boot.mode = String(props.mode || "");
    }
  };
}

export function buildSummary(rawRows, options = {}) {
  const from = Number(options.from) || 0;
  const to = Number(options.to) || Number.MAX_SAFE_INTEGER;
  const offset = Number.isFinite(options.tzOffsetMinutes) ? options.tzOffsetMinutes : TZ_OFFSET_MINUTES;

  const seen = new Set();
  const events = [];
  (rawRows || []).forEach((row) => {
    if (!row) return;
    const event = normalize(row);
    if (!event.ts || !event.sid || !event.name) return;
    if (seen.has(event.id)) return;
    seen.add(event.id);
    if (event.ts < from || event.ts >= to) return;
    events.push(event);
  });
  events.sort((a, b) => a.ts - b.ts);

  const sessions = new Map();
  const geoBySession = new Map();
  const viewerOpens = new Map();
  const aboutOpens = new Map();
  const latestAboutBySession = new Map();
  const visitors = new Set();
  const daily = new Map();
  const errorGroups = new Map();
  const vitalSamples = new Map();
  const pageLoads = new Map();
  const boots = new Map();
  const trackBootEvent = trackBootEventFactory(boots);
  const artworkLoads = [];
  const homeExitDurations = [];
  const homeExitImpressions = [];
  const homeExitDrags = [];
  const homeExitHovers = [];
  const scrollBucketSessions = new Map();
  const impressSessionsByProject = new Map();
  const clickSessionsByProject = new Map();
  const clickEventsByProject = new Map();
  const impressionEventsByProject = new Map();
  const viewerSessionsByProject = new Map();
  const contactClicks = { tel: 0, email: 0 };
  const contactSources = new Map();
  const foldStats = new Map();
  let fullscreenEnters = 0;
  let videoPlays = 0;
  let otherProjectClicks = 0;
  let pageviews = 0;
  let homeViews = 0;
  let impressionEvents = 0;
  let cardClicks = 0;
  let resumeDownloads = 0;

  const sessionOf = (event) => {
    let session = sessions.get(event.sid);
    if (!session) {
      session = {
        id: event.sid,
        vid: event.vid,
        firstTs: event.ts,
        lastTs: event.ts,
        events: 0,
        pageviews: 0,
        screens: new Set(),
        device: "",
        refType: "",
        ref: "",
        landing: "",
        visitorNew: false,
        homeViews: 0,
        homeExits: 0,
        impressions: new Set(),
        clicks: new Set(),
        viewerIds: new Set(),
        aboutOpens: 0,
        downloads: 0,
        scrollBuckets: new Set(),
        activeMs: 0,
        exitReasons: []
      };
      sessions.set(event.sid, session);
    }
    session.lastTs = Math.max(session.lastTs, event.ts);
    session.events += 1;
    if (!session.vid) session.vid = event.vid;
    return session;
  };

  events.forEach((event) => {
    const props = event.props;
    if (event.name === "boot_start" || event.name === "boot_ready" || event.name === "boot_fail") {
      trackBootEvent(event);
      return;
    }
    const session = sessionOf(event);
    if (event.country || event.region || event.city) {
      const previousGeo = geoBySession.get(event.sid);
      if (!previousGeo || event.name === "page_view") {
        geoBySession.set(event.sid, {
          country: event.country,
          region: event.region,
          city: event.city,
          continent: event.continent
        });
      }
    }
    if (session.vid) visitors.add(session.vid);

    const day = dayKey(event.ts, offset);
    let bucket = daily.get(day);
    if (!bucket) {
      bucket = {
        date: day,
        visitors: new Set(),
        sessions: new Set(),
        pageviews: 0,
        home_views: 0,
        impressions: 0,
        card_clicks: 0,
        viewer_opens: 0,
        about_opens: 0,
        resume_downloads: 0
      };
      daily.set(day, bucket);
    }
    bucket.sessions.add(event.sid);
    if (session.vid) bucket.visitors.add(session.vid);

    switch (event.name) {
      case "page_view": {
        pageviews += 1;
        session.pageviews += 1;
        if (props.mode && !session.device) session.device = String(props.mode);
        if (props.ref_type && !session.refType) session.refType = String(props.ref_type);
        if (props.ref && !session.ref) session.ref = String(props.ref);
        if (props.screen && !session.landing) session.landing = String(props.screen);
        session.visitorNew = Boolean(props.visitor_new);
        bucket.pageviews += 1;
        break;
      }
      case "screen_view": {
        if (props.screen) session.screens.add(String(props.screen));
        break;
      }
      case "home_view": {
        homeViews += 1;
        session.homeViews += 1;
        bucket.home_views += 1;
        break;
      }
      case "home_exit": {
        session.homeExits += 1;
        homeExitDurations.push(Number(props.duration_ms) || 0);
        homeExitImpressions.push(Number(props.impressions) || 0);
        homeExitDrags.push(Number(props.drags) || 0);
        homeExitHovers.push(Number(props.hovers) || 0);
        break;
      }
      case "card_impression": {
        const key = String(props.project_key || "");
        if (!key) break;
        impressionEvents += 1;
        impressionEventsByProject.set(key, (impressionEventsByProject.get(key) || 0) + 1);
        session.impressions.add(key);
        if (!impressSessionsByProject.has(key)) impressSessionsByProject.set(key, new Set());
        impressSessionsByProject.get(key).add(event.sid);
        bucket.impressions += 1;
        break;
      }
      case "card_click": {
        const key = String(props.project_key || "");
        cardClicks += 1;
        if (key) {
          clickEventsByProject.set(key, (clickEventsByProject.get(key) || 0) + 1);
          session.clicks.add(key);
          if (!clickSessionsByProject.has(key)) clickSessionsByProject.set(key, new Set());
          clickSessionsByProject.get(key).add(event.sid);
        }
        bucket.card_clicks += 1;
        break;
      }
      case "other_project_click": {
        otherProjectClicks += 1;
        const key = `${props.to_experience || ""}/${props.to_project || ""}`;
        if (key !== "/") {
          clickEventsByProject.set(key, (clickEventsByProject.get(key) || 0) + 1);
          if (!clickSessionsByProject.has(key)) clickSessionsByProject.set(key, new Set());
          clickSessionsByProject.get(key).add(event.sid);
          session.clicks.add(key);
        }
        break;
      }
      case "stream_scroll": {
        const value = Number(props.bucket);
        if (!value) break;
        session.scrollBuckets.add(value);
        if (!scrollBucketSessions.has(value)) scrollBucketSessions.set(value, new Set());
        scrollBucketSessions.get(value).add(event.sid);
        break;
      }
      case "viewer_open": {
        const viewerId = String(props.viewer_id || event.id);
        if (!viewerOpens.has(viewerId)) {
          viewerOpens.set(viewerId, {
            id: viewerId,
            sid: event.sid,
            vid: event.vid,
            projectKey: String(props.project_key || ""),
            project: String(props.project || ""),
            name: String(props.name || ""),
            experience: String(props.experience || ""),
            company: String(props.company || ""),
            total: Number(props.pages) || 0,
            contentPages: Number(props.content_pages) || 0,
            origin: String(props.origin || "direct"),
            openTs: event.ts,
            lastTs: event.ts,
            pages: new Set(),
            firstViews: new Set(),
            maxPage: 0,
            exit: null,
            slideDwell: new Map(),
            fullscreen: false
          });
        }
        const viewer = viewerOpens.get(viewerId);
        session.viewerIds.add(viewerId);
        if (viewer.projectKey) {
          if (!viewerSessionsByProject.has(viewer.projectKey)) viewerSessionsByProject.set(viewer.projectKey, new Set());
          viewerSessionsByProject.get(viewer.projectKey).add(event.sid);
        }
        bucket.viewer_opens += 1;
        break;
      }
      case "viewer_slide": {
        const viewer = viewerOpens.get(String(props.viewer_id || ""));
        if (!viewer) break;
        viewer.lastTs = event.ts;
        const page = Number(props.page) || 0;
        if (page > 0) {
          viewer.pages.add(page);
          if (props.first_view) viewer.firstViews.add(page);
          viewer.maxPage = Math.max(viewer.maxPage, page);
        }
        const prevPage = Number(props.prev_page) || 0;
        const dwell = Number(props.prev_dwell_ms) || 0;
        if (prevPage > 0 && dwell > 0) {
          const entry = viewer.slideDwell.get(prevPage) || { sum: 0, count: 0 };
          entry.sum += dwell;
          entry.count += 1;
          viewer.slideDwell.set(prevPage, entry);
        }
        break;
      }
      case "viewer_exit": {
        const viewer = viewerOpens.get(String(props.viewer_id || ""));
        if (!viewer) break;
        viewer.lastTs = event.ts;
        viewer.exit = props;
        viewer.maxPage = Math.max(viewer.maxPage, Number(props.max_index) || 0);
        if (props.fullscreen) viewer.fullscreen = true;
        const lastPage = Number(props.exit_index) || 0;
        const lastDwell = Number(props.last_dwell_ms) || 0;
        if (lastPage > 0 && lastDwell > 0) {
          const entry = viewer.slideDwell.get(lastPage) || { sum: 0, count: 0 };
          entry.sum += lastDwell;
          entry.count += 1;
          viewer.slideDwell.set(lastPage, entry);
        }
        break;
      }
      case "about_open": {
        const aboutId = String(props.about_id || event.id);
        aboutOpens.set(aboutId, {
          id: aboutId,
          sid: event.sid,
          source: String(props.source || "header"),
          screen: String(props.screen || ""),
          project: String(props.project || ""),
          openTs: event.ts,
          close: null,
          downloads: 0
        });
        latestAboutBySession.set(event.sid, aboutId);
        session.aboutOpens += 1;
        bucket.about_opens += 1;
        break;
      }
      case "about_close": {
        const about = aboutOpens.get(String(props.about_id || ""));
        if (!about) break;
        about.close = props;
        break;
      }
      case "resume_download": {
        resumeDownloads += 1;
        session.downloads += 1;
        bucket.resume_downloads += 1;
        const aboutId = String(props.about_id || latestAboutBySession.get(event.sid) || "");
        const about = aboutOpens.get(aboutId);
        if (about) about.downloads += 1;
        break;
      }
      case "contact_click": {
        const channel = String(props.channel || "");
        if (channel === "tel" || channel === "email") contactClicks[channel] += 1;
        const source = String(props.source || "other");
        contactSources.set(source, (contactSources.get(source) || 0) + 1);
        break;
      }
      case "about_fold": {
        const fold = String(props.fold || "unknown");
        const open = props.open ? "open" : "close";
        const key = `${fold}:${open}`;
        foldStats.set(key, (foldStats.get(key) || 0) + 1);
        break;
      }
      case "fullscreen_toggle": {
        if (props.entering) fullscreenEnters += 1;
        break;
      }
      case "video_play": {
        videoPlays += 1;
        break;
      }
      case "session_end": {
        const active = Number(props.active_ms) || 0;
        if (active > 0) session.activeMs = Math.max(session.activeMs, active);
        if (props.viewer_project && !session.landing) session.landing = String(props.viewer_project);
        break;
      }
      case "web_vitals": {
        const pid = event.pid || String(Math.random());
        const existing = vitalSamples.get(pid);
        if (!existing || props.stage === "final") {
          vitalSamples.set(pid, {
            lcp: Number(props.lcp_ms) || 0,
            fcp: Number(props.fcp_ms) || 0,
            load: Number(props.load_ms) || 0,
            cls: Number(props.cls) || 0,
            inp: Number(props.inp_ms) || 0,
            ttfb: Number(props.ttfb_ms) || 0,
            mode: String(props.mode || "")
          });
        }
        break;
      }
      case "page_load": {
        pageLoads.set(event.pid || event.id, {
          load: Number(props.load_ms) || 0,
          dom: Number(props.dom_ms) || 0,
          transfer: Number(props.transfer_kb) || 0,
          image: Number(props.image_kb) || 0,
          resources: Number(props.resources) || 0
        });
        break;
      }
      case "artwork_load": {
        artworkLoads.push({
          project: String(props.project || ""),
          projectKey: String(props.project_key || ""),
          page: Number(props.page) || 0,
          type: String(props.type || "image"),
          phase: String(props.phase || "initial"),
          duration: Number(props.duration_ms) || 0,
          success: props.success !== false,
          variant: Number(props.variant_w) || 0,
          mode: String(props.mode || "")
        });
        break;
      }
      case "error": {
        const key = `${props.type || "js"}|${props.message || ""}|${props.url || ""}`;
        const entry = errorGroups.get(key) || {
          type: String(props.type || "js"),
          message: String(props.message || "").slice(0, 120),
          url: String(props.url || "").slice(0, 120),
          count: 0,
          lastTs: 0
        };
        entry.count += 1;
        entry.lastTs = Math.max(entry.lastTs, event.ts);
        errorGroups.set(key, entry);
        break;
      }
      default:
        break;
    }
  });

  /* ------------------------------------------------------ boot & load stats */

  const bootList = [...boots.values()];
  const bootSuccesses = bootList.filter((boot) => Boolean(boot.ready)).length;
  const bootFailures = bootList.filter((boot) => !boot.ready && boot.fail).length;
  const bootDurations = bootList
    .filter((boot) => boot.ready)
    .map((boot) => Number(boot.ready.duration_ms) || 0)
    .filter((value) => value > 0);
  const bootFailReasons = new Map();
  bootList.forEach((boot) => {
    if (boot.ready) return;
    const reason = boot.fail ? String(boot.fail.reason || "unknown") : "incomplete";
    bootFailReasons.set(reason, (bootFailReasons.get(reason) || 0) + 1);
  });
  const bootModes = new Map();
  bootList.forEach((boot) => {
    const mode = boot.mode || "unknown";
    const group = bootModes.get(mode) || { attempts: 0, successes: 0, durations: [] };
    group.attempts += 1;
    if (boot.ready) {
      group.successes += 1;
      const duration = Number(boot.ready.duration_ms) || 0;
      if (duration > 0) group.durations.push(duration);
    }
    bootModes.set(mode, group);
  });
  const boot = {
    attempts: bootList.length,
    successes: bootSuccesses,
    failures: bootFailures,
    incomplete: bootList.length - bootSuccesses - bootFailures,
    success_rate: pct(bootSuccesses, bootList.length),
    p50_ms: Math.round(percentile(bootDurations, 0.5)),
    p75_ms: Math.round(percentile(bootDurations, 0.75)),
    avg_ms: Math.round(mean(bootDurations)),
    slow_open_rate: pct(bootDurations.filter((duration) => duration > 3000).length, bootDurations.length),
    fail_reasons: [...bootFailReasons.entries()]
      .map(([name, count]) => ({ name, count, pct: pct(count, bootList.length) }))
      .sort((a, b) => b.count - a.count),
    by_mode: [...bootModes.entries()]
      .map(([name, group]) => ({
        name,
        attempts: group.attempts,
        successes: group.successes,
        success_rate: pct(group.successes, group.attempts),
        p75_ms: Math.round(percentile(group.durations, 0.75))
      }))
      .sort((a, b) => b.attempts - a.attempts)
  };

  bootList.forEach((bootEntry) => {
    const day = dayKey(bootEntry.startTs || bootEntry.lastTs || Date.now(), offset);
    let bucket = daily.get(day);
    if (!bucket) {
      bucket = {
        date: day, visitors: new Set(), sessions: new Set(), pageviews: 0,
        home_views: 0, impressions: 0, card_clicks: 0, viewer_opens: 0,
        about_opens: 0, resume_downloads: 0, boot_attempts: 0, boot_success: 0
      };
      daily.set(day, bucket);
    }
    bucket.boot_attempts = (bucket.boot_attempts || 0) + 1;
    if (bootEntry.ready) bucket.boot_success = (bucket.boot_success || 0) + 1;
  });

  const artwork = {
    count: artworkLoads.length,
    failures: artworkLoads.filter((entry) => !entry.success).length,
    p50_ms: Math.round(percentile(artworkLoads.map((entry) => entry.duration), 0.5)),
    p75_ms: Math.round(percentile(artworkLoads.map((entry) => entry.duration), 0.75)),
    avg_ms: Math.round(mean(artworkLoads.map((entry) => entry.duration))),
    slow_rate: pct(artworkLoads.filter((entry) => entry.duration > 1500).length, artworkLoads.length),
    by_phase: ["initial", "turn"].map((phase) => {
      const rows = artworkLoads.filter((entry) => entry.phase === phase);
      return {
        name: phase,
        count: rows.length,
        p75_ms: Math.round(percentile(rows.map((entry) => entry.duration), 0.75)),
        slow_rate: pct(rows.filter((entry) => entry.duration > 1500).length, rows.length)
      };
    }),
    by_project: [...new Set(artworkLoads.map((entry) => entry.projectKey))].map((key) => {
      const rows = artworkLoads.filter((entry) => entry.projectKey === key);
      return {
        key,
        project: rows[0]?.project || "",
        count: rows.length,
        p50_ms: Math.round(percentile(rows.map((entry) => entry.duration), 0.5)),
        p75_ms: Math.round(percentile(rows.map((entry) => entry.duration), 0.75)),
        slow_rate: pct(rows.filter((entry) => entry.duration > 1500).length, rows.length)
      };
    }).sort((a, b) => b.count - a.count).slice(0, 8)
  };

  const resourceErrorEvents = events.filter((event) => event.name === "error" && event.props.type === "resource");
  const resourcePages = new Set(resourceErrorEvents.map((event) => event.pid)).size;
  const resourceGroups = new Map();
  resourceErrorEvents.forEach((event) => {
    const key = `${event.props.tag || "resource"}|${event.props.url || ""}`;
    const group = resourceGroups.get(key) || { tag: event.props.tag || "resource", url: event.props.url || "", count: 0, lastTs: 0 };
    group.count += 1;
    group.lastTs = Math.max(group.lastTs, event.ts);
    resourceGroups.set(key, group);
  });
  const resourceErrors = {
    count: resourceErrorEvents.length,
    pages: resourcePages,
    rate: pct(resourcePages, bootList.length || pageLoads.size || 0),
    top: [...resourceGroups.values()].sort((a, b) => b.count - a.count).slice(0, 10)
  };

  /* --------------------------------------------------------------- sessions */

  const sessionList = [...sessions.values()];
  const sessionCount = sessionList.length;
  const activeDurations = sessionList.map((session) => {
    if (session.activeMs > 0) return session.activeMs;
    return bound(session.lastTs - session.firstTs, 0, HEARTBEAT_CAP_MS);
  });
  const impressionSessionCount = sessionList.filter((session) => session.impressions.size > 0).length;
  const clickSessionCount = sessionList.filter((session) => session.clicks.size > 0).length;
  const viewerSessionCount = sessionList.filter((session) => session.viewerIds.size > 0).length;
  const aboutOpenSessionCount = sessionList.filter((session) => session.aboutOpens > 0).length;
  const downloadSessionCount = sessionList.filter((session) => session.downloads > 0).length;
  const homeSessionCount = sessionList.filter((session) => session.homeViews > 0).length;
  const noInteraction = sessionList.filter((session) =>
    session.pageviews <= 1 &&
    session.impressions.size === 0 &&
    session.clicks.size === 0 &&
    session.viewerIds.size === 0 &&
    session.aboutOpens === 0 &&
    session.downloads === 0 &&
    session.scrollBuckets.size === 0
  ).length;

  const geoCountries = new Map();
  const geoRegions = new Map();
  const geoCities = new Map();
  let geoKnown = 0;
  geoBySession.forEach((geo) => {
    if (!geo.country && !geo.region && !geo.city) return;
    geoKnown += 1;
    const countryCode = String(geo.country || "").toUpperCase();
    if (countryCode) geoCountries.set(countryCode, (geoCountries.get(countryCode) || 0) + 1);
    const regionKey = `${countryCode}|${geo.region || ""}`;
    if (geo.region || countryCode) geoRegions.set(regionKey, (geoRegions.get(regionKey) || 0) + 1);
    const cityKey = `${countryCode}|${geo.region || ""}|${geo.city || ""}`;
    if (geo.city || geo.region || countryCode) geoCities.set(cityKey, (geoCities.get(cityKey) || 0) + 1);
  });
  const geo = {
    samples: geoKnown,
    unknown: Math.max(0, sessionCount - geoKnown),
    countries: [...geoCountries.entries()]
      .map(([code, sessions]) => ({ code, sessions, pct: pct(sessions, sessionCount) }))
      .sort((a, b) => b.sessions - a.sessions),
    regions: [...geoRegions.entries()]
      .map(([key, sessions]) => {
        const [country, region] = key.split("|");
        return { country, region, sessions, pct: pct(sessions, sessionCount) };
      })
      .sort((a, b) => b.sessions - a.sessions),
    cities: [...geoCities.entries()]
      .map(([key, sessions]) => {
        const [country, region, city] = key.split("|");
        return { country, region, city, sessions, pct: pct(sessions, sessionCount) };
      })
      .sort((a, b) => b.sessions - a.sessions)
  };

  const deviceStats = new Map();
  const referrerStats = new Map();
  sessionList.forEach((session) => {
    const mode = session.device || "unknown";
    deviceStats.set(mode, (deviceStats.get(mode) || 0) + 1);
    const label = session.refType === "external" ? (hostOf(session.ref) || "外部链接")
      : session.refType === "internal" ? "站内跳转"
        : "直接访问";
    referrerStats.set(label, (referrerStats.get(label) || 0) + 1);
  });

  const sortCounts = (map, total = sessionCount) => [...map.entries()]
    .map(([name, count]) => ({ name, sessions: count, pct: pct(count, total) }))
    .sort((a, b) => b.sessions - a.sessions);

  /* ----------------------------------------------------------------- viewers */

  const viewerList = [...viewerOpens.values()];
  const viewerExitList = viewerList.filter((viewer) => viewer.exit);
  const viewerDurations = viewerList.map((viewer) => {
    if (viewer.exit && Number(viewer.exit.duration_ms) > 0) return Number(viewer.exit.duration_ms);
    return bound(viewer.lastTs - viewer.openTs, 0, HEARTBEAT_CAP_MS);
  });
  const maxPercentOf = (viewer) => {
    if (viewer.exit && Number.isFinite(Number(viewer.exit.max_percent))) {
      return bound(Number(viewer.exit.max_percent), 0, 100);
    }
    const total = viewer.total || viewer.maxPage || 1;
    return bound(Math.round((viewer.maxPage / total) * 100), 0, 100);
  };
  const bounceOf = (viewer) => {
    if (viewer.exit && typeof viewer.exit.bounce === "boolean") return viewer.exit.bounce;
    return viewer.firstViews.size <= 1;
  };
  const completionOf = (viewer) => {
    if (viewer.exit && typeof viewer.exit.reached_last_content === "boolean") return viewer.exit.reached_last_content;
    return viewer.contentPages > 0 && viewer.maxPage >= viewer.contentPages;
  };
  const reachedThankOf = (viewer) => {
    if (viewer.exit && typeof viewer.exit.reached_thank === "boolean") return viewer.exit.reached_thank;
    return viewer.total > 0 && viewer.maxPage >= viewer.total;
  };

  const viewerExitReasons = new Map();
  viewerExitList.forEach((viewer) => {
    const reason = String(viewer.exit.exit_reason || "navigate");
    viewerExitReasons.set(reason, (viewerExitReasons.get(reason) || 0) + 1);
  });

  const viewerSourceStats = new Map();
  viewerList.forEach((viewer) => {
    viewerSourceStats.set(viewer.origin, (viewerSourceStats.get(viewer.origin) || 0) + 1);
  });

  const reachBuckets = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const reachByPercent = reachBuckets.map((bucket) => {
    const count = viewerList.filter((viewer) => maxPercentOf(viewer) >= bucket).length;
    return { bucket, sessions: count, pct: pct(count, viewerList.length) };
  });

  /* ----------------------------------------------------------------- projects */

  const projects = PROJECTS.map((project) => {
    const opens = viewerList.filter((viewer) => viewer.projectKey === project.key);
    const impressions = impressionEventsByProject.get(project.key) || 0;
    const impressionSessions = impressSessionsByProject.get(project.key)?.size || 0;
    const clicks = clickEventsByProject.get(project.key) || 0;
    const clickSessions = clickSessionsByProject.get(project.key)?.size || 0;
    const viewerSessionSet = viewerSessionsByProject.get(project.key) || new Set();
    const total = project.total || (opens[0]?.total || 0);
    const content = project.content || (opens[0]?.contentPages || 0);
    const depthValues = opens.map((viewer) => maxPercentOf(viewer));
    const durations = opens.map((viewer) => (
      viewer.exit && Number(viewer.exit.duration_ms) > 0
        ? Number(viewer.exit.duration_ms)
        : bound(viewer.lastTs - viewer.openTs, 0, HEARTBEAT_CAP_MS)
    ));
    const bounceCount = opens.filter((viewer) => bounceOf(viewer)).length;
    const completionCount = opens.filter((viewer) => completionOf(viewer)).length;
    const thankCount = opens.filter((viewer) => reachedThankOf(viewer)).length;

    const slideReach = [];
    for (let page = 1; page <= total; page += 1) {
      let reached = 0;
      let dwellSum = 0;
      let dwellCount = 0;
      opens.forEach((viewer) => {
        const seen = viewer.firstViews.has(page) || viewer.maxPage >= page;
        if (seen) reached += 1;
        const dwell = viewer.slideDwell.get(page);
        if (dwell) {
          dwellSum += dwell.sum;
          dwellCount += dwell.count;
        }
      });
      slideReach.push({
        page,
        reached,
        pct: pct(reached, opens.length),
        dwell_ms: dwellCount ? Math.round(dwellSum / dwellCount) : 0
      });
      if (opens.length === 0) break;
    }
    let topDropoff = null;
    for (let index = 1; index < slideReach.length; index += 1) {
      const lost = slideReach[index - 1].reached - slideReach[index].reached;
      if (!topDropoff || lost > topDropoff.lost) {
        topDropoff = { page: slideReach[index].page, lost, pct_lost: pct(lost, Math.max(1, slideReach[index - 1].reached)) };
      }
    }
    return {
      key: project.key,
      id: project.id,
      name: project.name,
      experience: project.experience,
      company: project.company,
      total,
      content,
      impressions,
      impression_sessions: impressionSessions,
      clicks,
      click_sessions: clickSessions,
      ctr: pct(clicks, impressions),
      click_session_rate: pct(clickSessions, impressionSessions),
      viewer_opens: opens.length,
      viewer_sessions: viewerSessionSet.size,
      avg_depth_pct: round(mean(depthValues), 1),
      avg_ms: Math.round(mean(durations)),
      bounce_rate: pct(bounceCount, opens.length),
      completion_rate: pct(completionCount, opens.length),
      thank_rate: pct(thankCount, opens.length),
      top_dropoff: topDropoff,
      slide_reach: slideReach
    };
  });

  /* -------------------------------------------------------------------- about */

  const aboutList = [...aboutOpens.values()];
  const aboutWithClose = aboutList.filter((about) => about.close);
  const aboutDownloads = aboutList.reduce((sum, about) => sum + about.downloads, 0);
  const aboutSourceStats = new Map();
  const aboutScreenStats = new Map();
  aboutList.forEach((about) => {
    aboutSourceStats.set(about.source, (aboutSourceStats.get(about.source) || 0) + 1);
    aboutScreenStats.set(about.screen || "unknown", (aboutScreenStats.get(about.screen || "unknown") || 0) + 1);
  });
  const aboutScrollSide = aboutWithClose.map((about) => Number(about.close.side_scroll) || 0);
  const aboutScrollMain = aboutWithClose.map((about) => Number(about.close.main_scroll) || 0);
  const folds = {};
  [...foldStats.entries()].forEach(([key, count]) => {
    folds[key] = count;
  });

  /* --------------------------------------------------------------------- home */

  const scrollBuckets = [25, 50, 75, 100].map((bucket) => {
    const count = scrollBucketSessions.get(bucket)?.size || 0;
    return { bucket, sessions: count, pct: pct(count, homeSessionCount) };
  });
  const home = {
    sessions: homeSessionCount,
    views: homeViews,
    avg_ms: Math.round(mean(homeExitDurations)),
    avg_impressions: round(mean(homeExitImpressions), 1),
    avg_drags: round(mean(homeExitDrags), 2),
    avg_hovers: round(mean(homeExitHovers), 2),
    scroll_buckets: scrollBuckets
  };

  /* ------------------------------------------------------------------ funnel */

  const depthAtLeast3 = new Set(
    viewerList.filter((viewer) => viewer.pages.size >= 3).map((viewer) => viewer.sid)
  ).size;
  const reachedEndSessions = new Set(
    viewerList.filter((viewer) => completionOf(viewer)).map((viewer) => viewer.sid)
  ).size;

  const funnel = {
    browse: [
      { key: "sessions", label: "访问网站", sessions: sessionCount, pct: 100 },
      { key: "impression", label: "看到作品封面", sessions: impressionSessionCount, pct: pct(impressionSessionCount, sessionCount) },
      { key: "viewer", label: "打开任意作品", sessions: viewerSessionCount, pct: pct(viewerSessionCount, sessionCount) },
      { key: "depth3", label: "浏览 ≥ 3 页", sessions: depthAtLeast3, pct: pct(depthAtLeast3, sessionCount) },
      { key: "complete", label: "看到作品末页", sessions: reachedEndSessions, pct: pct(reachedEndSessions, sessionCount) }
    ],
    convert: [
      { key: "sessions", label: "访问网站", sessions: sessionCount, pct: 100 },
      { key: "about", label: "打开「关于我」", sessions: aboutOpenSessionCount, pct: pct(aboutOpenSessionCount, sessionCount) },
      { key: "download", label: "下载简历", sessions: downloadSessionCount, pct: pct(downloadSessionCount, sessionCount) }
    ]
  };

  /* ------------------------------------------------------------------ vitals */

  const vitalValues = [...vitalSamples.values()];
  const vitals = {
    samples: vitalValues.length,
    lcp_p75: Math.round(percentile(vitalValues.map((value) => value.lcp), 0.75)),
    fcp_p75: Math.round(percentile(vitalValues.map((value) => value.fcp), 0.75)),
    load_p75: Math.round(percentile(vitalValues.map((value) => value.load), 0.75)),
    cls_p75: Math.round(percentile(vitalValues.map((value) => value.cls), 0.75) * 1000) / 1000,
    inp_p75: Math.round(percentile(vitalValues.map((value) => value.inp), 0.75)),
    ttfb_p75: Math.round(percentile(vitalValues.map((value) => value.ttfb), 0.75))
  };
  const loads = [...pageLoads.values()];
  const loadStats = {
    samples: loads.length,
    avg_transfer_kb: Math.round(mean(loads.map((value) => value.transfer))),
    avg_image_kb: Math.round(mean(loads.map((value) => value.image))),
    avg_load_ms: Math.round(mean(loads.map((value) => value.load))),
    avg_resources: Math.round(mean(loads.map((value) => value.resources))),
    load_p75_ms: Math.round(percentile(loads.map((value) => value.load), 0.75)),
    dom_p75_ms: Math.round(percentile(loads.map((value) => value.dom), 0.75)),
    transfer_kb_p75: Math.round(percentile(loads.map((value) => value.transfer), 0.75)),
    image_kb_p75: Math.round(percentile(loads.map((value) => value.image), 0.75)),
    resources_p75: Math.round(percentile(loads.map((value) => value.resources), 0.75))
  };

  /* ------------------------------------------------------------------ output */

  const days = new Map();
  daily.forEach((bucket, date) => {
    days.set(date, {
      date,
      visitors: bucket.visitors.size,
      sessions: bucket.sessions.size,
      pageviews: bucket.pageviews,
      home_views: bucket.home_views,
      impressions: bucket.impressions,
      card_clicks: bucket.card_clicks,
      viewer_opens: bucket.viewer_opens,
      about_opens: bucket.about_opens,
      resume_downloads: bucket.resume_downloads,
      boot_attempts: bucket.boot_attempts || 0,
      boot_success: bucket.boot_success || 0
    });
  });

  const overview = {
    visitors: visitors.size,
    sessions: sessionCount,
    pageviews,
    avg_session_ms: Math.round(mean(activeDurations)),
    no_interaction_rate: pct(noInteraction, sessionCount),
    home_sessions: homeSessionCount,
    home_views: homeViews,
    impressions: impressionEvents,
    impression_sessions: impressionSessionCount,
    card_clicks: cardClicks,
    ctr: pct(cardClicks, impressionEvents),
    click_session_rate: pct(clickSessionCount, impressionSessionCount),
    viewer_opens: viewerList.length,
    viewer_sessions: viewerSessionCount,
    viewer_exits: viewerExitList.length,
    viewer_avg_depth_pct: round(mean(viewerList.map((viewer) => maxPercentOf(viewer))), 1),
    viewer_avg_ms: Math.round(mean(viewerDurations)),
    viewer_bounce_rate: pct(viewerList.filter((viewer) => bounceOf(viewer)).length, viewerList.length),
    viewer_completion_rate: pct(viewerList.filter((viewer) => completionOf(viewer)).length, viewerList.length),
    about_opens: aboutList.length,
    about_open_sessions: aboutOpenSessionCount,
    about_open_rate: pct(aboutOpenSessionCount, sessionCount),
    resume_downloads: resumeDownloads,
    resume_download_sessions: downloadSessionCount,
    resume_download_rate: pct(downloadSessionCount, sessionCount),
    resume_per_open: pct(aboutDownloads, aboutList.length),
    contact_clicks: contactClicks.tel + contactClicks.email,
    fullscreen_enters: fullscreenEnters,
    video_plays: videoPlays,
    other_project_clicks: otherProjectClicks,
    open_success_rate: boot.success_rate,
    boot_attempts: boot.attempts,
    slow_open_rate: boot.slow_open_rate,
    artwork_load_p75_ms: artwork.p75_ms,
    resource_error_pages: resourceErrors.pages,
    errors: [...errorGroups.values()].reduce((sum, entry) => sum + entry.count, 0)
  };

  const about = {
    opens: aboutList.length,
    open_sessions: aboutOpenSessionCount,
    open_rate: pct(aboutOpenSessionCount, sessionCount),
    avg_ms: Math.round(mean(aboutWithClose.map((entry) => Number(entry.close.duration_ms) || 0))),
    downloads: aboutDownloads,
    download_sessions: downloadSessionCount,
    download_rate: pct(downloadSessionCount, aboutList.length),
    per_open: pct(aboutDownloads, aboutList.length),
    by_source: sortByCount(aboutSourceStats, aboutList.length),
    by_screen: sortByCount(aboutScreenStats, aboutList.length),
    avg_side_scroll: Math.round(mean(aboutScrollSide)),
    avg_main_scroll: Math.round(mean(aboutScrollMain)),
    folds,
    contact: {
      tel: contactClicks.tel,
      email: contactClicks.email,
      by_source: sortByCount(contactSources, contactClicks.tel + contactClicks.email)
    }
  };

  const deviceAgg = new Map();
  viewerList.forEach((entry) => {
    const mode = sessions.get(entry.sid)?.device || "unknown";
    const group = deviceAgg.get(mode) || { opens: 0, bounce: 0, complete: 0, depth: [] };
    group.opens += 1;
    if (bounceOf(entry)) group.bounce += 1;
    if (completionOf(entry)) group.complete += 1;
    group.depth.push(maxPercentOf(entry));
    deviceAgg.set(mode, group);
  });
  const devices = sortCounts(deviceStats).map((entry) => {
    const group = deviceAgg.get(entry.name) || { opens: 0, bounce: 0, complete: 0, depth: [] };
    return Object.assign(entry, {
      viewer_opens: group.opens,
      bounce_rate: pct(group.bounce, group.opens),
      completion_rate: pct(group.complete, group.opens),
      avg_depth_pct: round(mean(group.depth), 1)
    });
  });

  const viewer = {
    opens: viewerList.length,
    exits: viewerExitList.length,
    avg_depth_pct: round(mean(viewerList.map((entry) => maxPercentOf(entry))), 1),
    avg_ms: Math.round(mean(viewerDurations)),
    bounce_rate: pct(viewerList.filter((entry) => bounceOf(entry)).length, viewerList.length),
    completion_rate: pct(viewerList.filter((entry) => completionOf(entry)).length, viewerList.length),
    thank_rate: pct(viewerList.filter((entry) => reachedThankOf(entry)).length, viewerList.length),
    reach_by_percent: reachByPercent,
    exit_reasons: sortCounts(viewerExitReasons, viewerExitList.length),
    sources: sortByCount(viewerSourceStats, viewerList.length),
    projects: projects
  };

  return {
    meta: {
      generated_at: Date.now(),
      from: from || (events[0]?.ts || 0),
      to: to === Number.MAX_SAFE_INTEGER ? (events[events.length - 1]?.ts || 0) : to,
      tz_offset_minutes: offset,
      event_count: events.length,
      session_count: sessionCount,
      project_count: projects.length
    },
    overview,
    daily: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
    projects,
    about,
    home,
    viewer,
    funnel,
    devices: devices,
    referrers: sortCounts(referrerStats),
    geo,
    vitals,
    load: loadStats,
    boot,
    artwork,
    resource_errors: resourceErrors,
    errors: [...errorGroups.values()].sort((a, b) => b.count - a.count).slice(0, 20),
    actions: {
      resume_downloads: resumeDownloads,
      contact_clicks: contactClicks.tel + contactClicks.email,
      fullscreen_enters: fullscreenEnters,
      video_plays: videoPlays,
      other_project_clicks: otherProjectClicks
    }
  };
}

function sortByCount(map, total) {
  return [...map.entries()]
    .map(([name, count]) => ({ name, count, pct: pct(count, total) }))
    .sort((a, b) => b.count - a.count);
}

export function buildComparison(rows, options = {}) {
  const to = Number(options.to) || Date.now();
  const days = Math.max(1, Number(options.days) || 30);
  const span = days * DAY_MS;
  const currentFrom = to - span;
  const current = buildSummary(rows, Object.assign({}, options, { from: currentFrom, to }));
  const previous = buildSummary(rows, Object.assign({}, options, { from: currentFrom - span, to: currentFrom }));
  return { current, previous, range: { from: currentFrom, to, days } };
}
