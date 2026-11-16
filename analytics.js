/*!
 * Portfolio analytics v1 — cookieless, first-party, dependency-free.
 *
 * Everything is opt-in: the site keeps working with analytics.js blocked or
 * missing, and with an empty `endpoint` the tracker only records into the
 * local debug ring (no network calls at all).
 *
 * Configuration (pick one):
 *   - edit ANALYTICS_ENDPOINT below after deploying the Cloudflare Worker
 *     (see analytics/README.md), or
 *   - set <meta name="portfolio-analytics-endpoint" content="https://…/collect">
 *     in index.html, or
 *   - set window.PORTFOLIO_ANALYTICS_ENDPOINT before this file loads.
 *
 * Privacy: no cookies, no IP / ASN / user-agent storage, no personal data.
 * Only a random visitor id (localStorage) and a 30-minute session id
 * (sessionStorage) are kept, plus the event properties listed in the docs.
 * Do Not Track / Global Privacy Control are honoured by default.
 */
(function (window, document) {
  "use strict";

  if (!window || !document || window.PortfolioAnalytics) return;

  var ANALYTICS_ENDPOINT = ""; // ← 部署 Worker 后填 https://<worker>/collect
  var SITE_ID = "tangyubao-portfolio";

  var defaults = {
    endpoint: ANALYTICS_ENDPOINT,
    siteId: SITE_ID,
    debug: "auto",           // "auto" = on for localhost / file://
    respectDNT: true,
    sampleRate: 1,
    heartbeatMs: 20000,
    sessionGapMs: 30 * 60 * 1000,
    flushDelayMs: 6000,
    maxBatch: 30,
    maxQueue: 120,
    maxRestored: 100,
    maxEventBytes: 32000,
    debugRingSize: 200,
    storagePrefix: "pf_a1_"
  };

  var params;
  try {
    params = new URLSearchParams(window.location.search || "");
  } catch (error) {
    params = null;
  }

  function param(name) {
    return params ? params.get(name) : null;
  }

  function resolveEndpoint() {
    var fromQuery = param("analytics_endpoint");
    var fromGlobal = window.PORTFOLIO_ANALYTICS_ENDPOINT;
    var meta = document.querySelector('meta[name="portfolio-analytics-endpoint"]');
    var endpoint = fromQuery || fromGlobal || (meta && meta.getAttribute("content")) || defaults.endpoint || "";
    endpoint = String(endpoint).trim();
    if (endpoint && endpoint.charAt(endpoint.length - 1) === "/") endpoint = endpoint.slice(0, -1);
    return endpoint;
  }

  var isLocalHost = /^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)$/.test(window.location.hostname) || window.location.protocol === "file:";
  var debugFlag = param("analytics_debug");
  var debug = debugFlag ? debugFlag === "1" : (defaults.debug === "auto" ? isLocalHost : Boolean(defaults.debug));
  var endpoint = resolveEndpoint();
  var siteId = param("analytics_site") || defaults.siteId;

  // DNT / GPC: opt out entirely unless explicitly forced (local QA only).
  var force = param("analytics_force") === "1";
  var dnt = navigator.doNotTrack === "1" || window.doNotTrack === "1" || navigator.msDoNotTrack === "1";
  var gpc = navigator.globalPrivacyControl === true;
  var enabled = force || (!(defaults.respectDNT && (dnt || gpc)));

  var sampleRate = Number(param("analytics_sample"));
  if (!isFinite(sampleRate) || sampleRate <= 0 || sampleRate > 1) sampleRate = defaults.sampleRate;
  var sampledIn = Math.random() <= sampleRate;

  var prefix = defaults.storagePrefix;
  var active = enabled && sampledIn;

  /* ---------------------------------------------------------------- storage */

  function safeStorage(kind) {
    try {
      var store = window[kind];
      var probe = prefix + "probe";
      store.setItem(probe, "1");
      store.removeItem(probe);
      return store;
    } catch (error) {
      return null;
    }
  }

  var local = safeStorage("localStorage");
  var sessionStore = safeStorage("sessionStorage");

  function readJSON(store, key, fallback) {
    if (!store) return fallback;
    try {
      var raw = store.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function writeJSON(store, key, value) {
    if (!store) return;
    try {
      store.setItem(key, JSON.stringify(value));
    } catch (error) {
      /* quota / private mode: analytics must never break the page */
    }
  }

  /* -------------------------------------------------------------------- ids */

  function randomText(length) {
    var alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    var text = "";
    var values;
    try {
      values = new Uint8Array(length);
      window.crypto.getRandomValues(values);
    } catch (error) {
      values = null;
    }
    for (var index = 0; index < length; index += 1) {
      var value = values ? values[index] : Math.floor(Math.random() * 256);
      text += alphabet.charAt(value % alphabet.length);
    }
    return text;
  }

  function makeId(prefixText) {
    return (prefixText || "id") + "_" + Date.now().toString(36) + "_" + randomText(6);
  }

  var visitor = loadVisitor();
  var session = loadSession();
  var pageId = makeId("p");
  var startedAt = Date.now();
  var screen = "home";
  var context = {};
  var screensVisited = [];

  function loadVisitor() {
    var stored = readJSON(local, prefix + "v", null);
    var isNew = !stored || !stored.id;
    if (isNew) stored = { id: makeId("v"), first: Date.now(), visits: 0 };
    stored.visits = (Number(stored.visits) || 0) + 1;
    stored.last = Date.now();
    writeJSON(local, prefix + "v", stored);
    return { id: stored.id, first: stored.first, visits: stored.visits, isNew: isNew };
  }

  function loadSession() {
    var now = Date.now();
    var stored = readJSON(sessionStore, prefix + "s", null);
    var isNew = !stored || !stored.id || now - Number(stored.last || 0) > defaults.sessionGapMs;
    if (isNew) stored = { id: makeId("s"), start: now, last: now };
    stored.last = now;
    writeJSON(sessionStore, prefix + "s", stored);
    return { id: stored.id, start: stored.start, isNew: isNew };
  }

  function touchSession() {
    var now = Date.now();
    var previousLast = session.last;
    if (now - previousLast > defaults.sessionGapMs) {
      session = { id: makeId("s"), start: now, last: now, isNew: true };
      writeJSON(sessionStore, prefix + "s", session);
      track("session_renew", { gap_ms: now - previousLast });
    }
    session.last = now;
    writeJSON(sessionStore, prefix + "s", { id: session.id, start: session.start, last: now });
  }

  /* ------------------------------------------------------------------- time */

  var activeMs = 0;
  var visibleSince = document.visibilityState === "hidden" ? null : nowHighRes();
  var screenEnteredAt = 0;

  function nowHighRes() {
    return (window.performance && window.performance.now) ? window.performance.now() : Date.now();
  }

  function activeTime() {
    var total = activeMs;
    if (visibleSince != null) total += Math.max(0, nowHighRes() - visibleSince);
    return Math.round(total);
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") {
      if (visibleSince != null) {
        activeMs += Math.max(0, nowHighRes() - visibleSince);
        visibleSince = null;
      }
    } else if (visibleSince == null) {
      visibleSince = nowHighRes();
    }
  });

  /* ---------------------------------------------------------------- helpers */

  function viewportClass() {
    var width = window.innerWidth || 0;
    var height = window.innerHeight || 0;
    if (height <= 520 && width > 760) return "short-landscape";
    if (width <= 760) return "mobile";
    if (width <= 1100) return "tablet";
    return "desktop";
  }

  function pathOf() {
    var path = String(window.location.pathname || "/");
    var hash = String(window.location.hash || "");
    return (path + hash).slice(0, 160);
  }

  function referrerInfo() {
    var raw = document.referrer || "";
    if (!raw) return { ref: "", ref_type: "direct" };
    try {
      var url = new URL(raw);
      var same = url.hostname === window.location.hostname;
      return {
        ref: (url.hostname + url.pathname).slice(0, 120),
        ref_type: same ? "internal" : "external"
      };
    } catch (error) {
      return { ref: "", ref_type: "direct" };
    }
  }

  function utmProps() {
    var out = {};
    ["source", "medium", "campaign", "content", "term"].forEach(function (key) {
      var value = param("utm_" + key);
      if (value) out["utm_" + key] = String(value).slice(0, 80);
    });
    return out;
  }

  function connectionType() {
    var connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    return connection && connection.effectiveType ? connection.effectiveType : "";
  }

  function sanitizeValue(value) {
    if (value == null) return null;
    var type = typeof value;
    if (type === "string") return value.slice(0, 200);
    if (type === "number") return isFinite(value) ? Math.round(value * 1000) / 1000 : null;
    if (type === "boolean") return value;
    return null;
  }

  function sanitizeProps(props) {
    if (!props || typeof props !== "object") return null;
    var out = {};
    var keys = Object.keys(props).slice(0, 30);
    keys.forEach(function (key) {
      var clean = sanitizeValue(props[key]);
      if (clean !== null && clean !== "") out[key.slice(0, 40)] = clean;
    });
    return Object.keys(out).length ? out : null;
  }

  function byteLength(text) {
    return text ? text.length * 2 : 0;
  }

  /* ------------------------------------------------------------- debug ring */

  function debugLog(event) {
    if (!debug) return;
    try {
      console.debug("[analytics]", event.name, event.props || {});
    } catch (error) { /* ignore */ }
    if (!local) return;
    var ring = readJSON(local, prefix + "ring", []);
    if (!Array.isArray(ring)) ring = [];
    ring.push(event);
    while (ring.length > defaults.debugRingSize) ring.shift();
    writeJSON(local, prefix + "ring", ring);
  }

  /* --------------------------------------------------------------- transport */

  var queue = restoreQueue();
  var flushTimer = 0;
  var sending = false;
  var attempts = {};

  function restoreQueue() {
    var stored = readJSON(local, prefix + "q", []);
    if (!Array.isArray(stored)) return [];
    return stored.filter(function (event) {
      return event && event.id && event.name && Number(event.ts) > 0;
    }).slice(-defaults.maxRestored);
  }

  function persistQueue() {
    if (!local) return;
    var keep = queue.slice(0, defaults.maxQueue).map(function (event) {
      return { id: event.id, name: event.name, ts: event.ts, sid: event.sid, vid: event.vid, pid: event.pid, screen: event.screen, props: event.props };
    });
    writeJSON(local, prefix + "q", keep);
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = window.setTimeout(function () {
      flushTimer = 0;
      flush("timer");
    }, defaults.flushDelayMs);
  }

  function payloadFor(batch) {
    return JSON.stringify({
      v: 1,
      site: siteId,
      sent_at: Date.now(),
      events: batch.map(function (event) {
        return {
          id: event.id,
          name: event.name,
          ts: event.ts,
          sid: event.sid,
          vid: event.vid,
          pid: event.pid,
          screen: event.screen,
          props: event.props || undefined
        };
      })
    });
  }

  function flush(reason) {
    if (flushTimer) {
      window.clearTimeout(flushTimer);
      flushTimer = 0;
    }
    if (!queue.length) return;
    if (!active) {
      // Opted out / sampled out: keep the ring for local inspection only.
      queue = [];
      return;
    }
    if (!endpoint) {
      if (debug) queue.forEach(function (event) { console.debug("[analytics]", event.name, event.props || {}); });
      queue = [];
      return;
    }
    var beacon = reason === "hidden" || reason === "pagehide";
    if (sending && !beacon) return;
    var batch = [];
    var bytes = 0;
    while (queue.length && batch.length < defaults.maxBatch) {
      var next = queue[0];
      var size = byteLength(JSON.stringify(next));
      if (batch.length && bytes + size > defaults.maxEventBytes) break;
      batch.push(queue.shift());
      bytes += size;
    }
    if (!batch.length) return;

    var body = payloadFor(batch);
    if (beacon && navigator.sendBeacon) {
      var ok = false;
      try {
        ok = navigator.sendBeacon(endpoint, new Blob([body], { type: "text/plain;charset=UTF-8" }));
      } catch (error) {
        ok = false;
      }
      if (!ok) requeue(batch, true);
      return;
    }

    sending = true;
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = controller ? window.setTimeout(function () { controller.abort(); }, 8000) : 0;
    var finish = function (ok) {
      if (timer) window.clearTimeout(timer);
      sending = false;
      if (!ok) requeue(batch, false);
      else batch.forEach(function (event) { delete attempts[event.id]; });
      if (queue.length) scheduleFlush();
    };
    if (!window.fetch) {
      finish(false);
      return;
    }
    window.fetch(endpoint, {
      method: "POST",
      mode: "cors",
      keepalive: true,
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body: body,
      signal: controller ? controller.signal : undefined
    }).then(function (response) {
      finish(response && response.ok);
    }).catch(function () {
      finish(false);
    });
  }

  function requeue(batch, beacon) {
    var keep = [];
    batch.forEach(function (event) {
      var count = (attempts[event.id] || 0) + 1;
      attempts[event.id] = count;
      if (count <= 3 || beacon) keep.push(event);
    });
    if (!keep.length) return;
    // beacon failures cannot be confirmed; put them back only if the page is
    // still alive, otherwise the next load would replay stale events.
    if (beacon) {
      queue = keep.concat(queue).slice(0, defaults.maxQueue);
      persistQueue();
      return;
    }
    queue = keep.concat(queue).slice(0, defaults.maxQueue);
    persistQueue();
  }

  /* ------------------------------------------------------------------- track */

  var pageViewSent = false;

  function track(name, props) {
    if (!active) {
      // Opted out (DNT/GPC/sampling): no queue, no local ring.
      if (debug) console.debug("[analytics:off]", name, props || {});
      return;
    }
    if (!name) return;
    touchSession();
    var event = {
      id: makeId("e"),
      name: String(name).replace(/[^a-z0-9_]/gi, "_").slice(0, 40),
      ts: Date.now(),
      sid: session.id,
      vid: visitor.id,
      pid: pageId,
      screen: screen,
      props: sanitizeProps(props)
    };
    queue.push(event);
    if (debug) debugLog(event);
    if (queue.length >= defaults.maxBatch) flush("batch");
    else scheduleFlush();
  }

  /* ------------------------------------------------------------------- vitals */

  var vitals = { lcp: null, cls: 0, inp: null, fcp: null, ttfb: null, load: null };
  var vitalsSent = { early: false, final: false };

  function observeVitals() {
    if (!window.PerformanceObserver) return;
    try {
      new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (entry) { vitals.lcp = Math.round(entry.startTime); });
      }).observe({ type: "largest-contentful-paint", buffered: true });
    } catch (error) { /* unsupported */ }
    try {
      new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (entry) {
          if (!entry.hadRecentInput) vitals.cls += entry.value;
        });
      }).observe({ type: "layout-shift", buffered: true });
    } catch (error) { /* unsupported */ }
    try {
      new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (entry) {
          if (vitals.inp == null || entry.duration > vitals.inp) vitals.inp = Math.round(entry.duration);
        });
      }).observe({ type: "event", durationThreshold: 40, buffered: true });
    } catch (error) { /* unsupported */ }
    try {
      var paints = window.performance.getEntriesByType("paint") || [];
      paints.forEach(function (entry) {
        if (entry.name === "first-contentful-paint") vitals.fcp = Math.round(entry.startTime);
      });
      var nav = window.performance.getEntriesByType("navigation")[0];
      if (nav) {
        vitals.ttfb = Math.round(nav.responseStart);
        vitals.load = nav.loadEventEnd ? Math.round(nav.loadEventEnd) : null;
      }
    } catch (error) { /* ignore */ }
  }

  function sendVitals(stage) {
    if (!active || vitalsSent[stage]) return;
    var cls = Math.round(vitals.cls * 1000) / 1000;
    if (vitals.lcp == null && vitals.fcp == null && vitals.ttfb == null && !cls && vitals.inp == null) return;
    vitalsSent[stage] = true;
    track("web_vitals", {
      stage: stage,
      lcp_ms: vitals.lcp,
      fcp_ms: vitals.fcp,
      cls: cls,
      inp_ms: vitals.inp,
      ttfb_ms: vitals.ttfb,
      load_ms: vitals.load,
      vw: window.innerWidth,
      vh: window.innerHeight,
      mode: viewportClass()
    });
    flush(stage === "final" ? "pagehide" : "timer");
  }

  function trackPageLoad() {
    if (!active || trackPageLoad.sent) return;
    trackPageLoad.sent = true;
    var nav = null;
    try {
      nav = window.performance.getEntriesByType("navigation")[0] || null;
    } catch (error) { /* ignore */ }
    var resources = 0;
    var transferKb = 0;
    var imageKb = 0;
    try {
      (window.performance.getEntriesByType("resource") || []).forEach(function (entry) {
        resources += 1;
        transferKb += (entry.transferSize || 0) / 1024;
        if (entry.initiatorType === "img") imageKb += (entry.transferSize || 0) / 1024;
      });
    } catch (error) { /* ignore */ }
    track("page_load", {
      load_ms: nav && nav.loadEventEnd ? Math.round(nav.loadEventEnd) : null,
      dom_ms: nav && nav.domContentLoadedEventEnd ? Math.round(nav.domContentLoadedEventEnd) : null,
      resources: resources,
      transfer_kb: Math.round(transferKb),
      image_kb: Math.round(imageKb),
      mode: viewportClass()
    });
    window.setTimeout(function () { sendVitals("early"); }, 20000);
  }

  function schedulePageLoad() {
    if (document.readyState === "complete") {
      window.setTimeout(trackPageLoad, 800);
      return;
    }
    window.addEventListener("load", function () {
      window.setTimeout(trackPageLoad, 800);
    }, { once: true });
  }

  /* ------------------------------------------------------------------ errors */

  var errorKeys = {};
  var errorCount = 0;

  function trackError(props) {
    if (!active || errorCount >= 10) return;
    var key = [props.type, props.message, props.url].join("|").slice(0, 240);
    if (errorKeys[key]) return;
    errorKeys[key] = true;
    errorCount += 1;
    track("error", props);
  }

  window.addEventListener("error", function (event) {
    var target = event.target;
    if (target && target !== window && target.tagName) {
      var source = target.currentSrc || target.src || target.href || "";
      trackError({
        type: "resource",
        tag: String(target.tagName).toLowerCase(),
        url: String(source).split("?")[0].slice(0, 160),
        page: pathOf()
      });
      return;
    }
    trackError({
      type: "js",
      message: String(event.message || "unknown").slice(0, 160),
      url: String(event.filename || "").split("?")[0].slice(0, 160),
      line: event.lineno || null,
      page: pathOf()
    });
  }, true);

  window.addEventListener("unhandledrejection", function (event) {
    var reason = event.reason;
    var message = reason && reason.message ? reason.message : String(reason || "unhandled");
    trackError({ type: "promise", message: message.slice(0, 160), page: pathOf() });
  });

  /* ---------------------------------------------------------------- session */

  var sessionEnded = false;
  var eventsSent = 0;

  function endSession(reason) {
    if (!active) return;
    if (sessionEnded) return;
    sessionEnded = true;
    track("session_end", {
      reason: reason,
      duration_ms: Date.now() - session.start,
      active_ms: activeTime(),
      screens: screensVisited.slice(-6).join(">"),
      event_count: eventsSent,
      last_screen: screen,
      viewer_project: context.viewer_project || null,
      viewer_page: context.viewer_page || null
    });
  }

  var hiddenAt = 0;

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") {
      hiddenAt = Date.now();
      endSession("hidden");
      sendVitals("final");
      flush("hidden");
    } else {
      sessionEnded = false;
      if (hiddenAt && Date.now() - hiddenAt > 3000) {
        track("visibility_return", { hidden_ms: Date.now() - hiddenAt });
      }
      hiddenAt = 0;
    }
  });

  window.addEventListener("pagehide", function () {
    endSession("pagehide");
    sendVitals("final");
    flush("pagehide");
  });

  window.addEventListener("online", function () {
    flush("online");
  });

  /* ------------------------------------------------------------------- public */

  function setScreen(name, props) {
    var next = String(name || "").slice(0, 20);
    var from = screen;
    if (next === from) return;
    var dwell = screenEnteredAt ? Math.max(0, activeTime() - screenEnteredAt) : 0;
    screen = next;
    screensVisited.push(next);
    screenEnteredAt = activeTime();
    track("screen_view", Object.assign({ screen: next, from: from, dwell_ms: dwell, path: pathOf() }, props || {}));
    if (next !== "viewer") context = {};
  }

  function pageView() {
    if (pageViewSent) return;
    pageViewSent = true;
    var navType = "navigate";
    try {
      var nav = window.performance.getEntriesByType("navigation")[0];
      if (nav && nav.type && nav.type !== "navigate") navType = nav.type;
    } catch (error) { /* ignore */ }
    var ref = referrerInfo();
    track("page_view", Object.assign({
      screen: screen,
      path: pathOf(),
      entry: navType,
      ref: ref.ref,
      ref_type: ref.ref_type,
      visitor_new: visitor.isNew,
      session_new: session.isNew,
      visits: visitor.visits,
      vw: window.innerWidth,
      vh: window.innerHeight,
      dpr: Math.round((window.devicePixelRatio || 1) * 100) / 100,
      lang: String(navigator.language || ""),
      tz: (function () {
        try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (error) { return ""; }
      })(),
      conn: connectionType(),
      mode: viewportClass(),
      reduced_motion: Boolean(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches)
    }, utmProps()));
    screenEnteredAt = activeTime();
    schedulePageLoad();
    scheduleHeartbeat();
  }

  function scheduleHeartbeat() {
    if (!active) return;
    window.setInterval(function () {
      if (document.visibilityState === "hidden") return;
      track("heartbeat", {
        active_ms: activeTime(),
        since_start_ms: Date.now() - startedAt,
        viewer_project: context.viewer_project || null,
        viewer_page: context.viewer_page || null
      });
    }, defaults.heartbeatMs);
  }

  function setContext(next) {
    if (!next || typeof next !== "object") return;
    Object.keys(next).forEach(function (key) {
      var value = next[key];
      if (value == null) delete context[key];
      else context[key] = value;
    });
  }

  var lastTrackedEvents = 0;
  var originalTrack = track;
  track = function (name, props) {
    lastTrackedEvents += 1;
    eventsSent = lastTrackedEvents;
    originalTrack(name, props);
  };

  observeVitals();

  window.PortfolioAnalytics = {
    version: "1.0.0",
    enabled: active,
    debug: debug,
    config: {
      endpoint: endpoint,
      siteId: siteId,
      heartbeatMs: defaults.heartbeatMs,
      sessionGapMs: defaults.sessionGapMs
    },
    track: track,
    pageView: pageView,
    setScreen: setScreen,
    setContext: setContext,
    activeMs: activeTime,
    id: makeId,
    flush: flush,
    visitor: function () {
      return { id: visitor.id, new: visitor.isNew, visits: visitor.visits };
    },
    session: function () {
      return { id: session.id, start: session.start, new: session.isNew };
    },
    events: function () {
      return readJSON(local, prefix + "ring", []);
    },
    clearEvents: function () {
      writeJSON(local, prefix + "ring", []);
    }
  };

  if (debug) {
    console.info("[analytics] enabled:", active, "endpoint:", endpoint || "(debug only, no network)");
  }

  // Safety net: if the app never calls pageView() (blocked/broken script), the
  // entry page view is still recorded once the document is ready.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { pageView(); }, { once: true });
  } else {
    window.setTimeout(pageView, 0);
  }
}(window, document));
