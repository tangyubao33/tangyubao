/*!
 * Zero-dependency regression check for the shared aggregation contract.
 *   node analytics/tools/verify-summary.mjs
 * Generates synthetic events, aggregates them and asserts the invariants the
 * dashboard and the docs rely on. Run it after touching summary.js, the event
 * model or the sample generator.
 */
import { buildComparison, PROJECTS } from "../summary.js";
import { generateSampleEvents } from "./generate.mjs";

const events = generateSampleEvents({ days: 60, seed: 20261116 });
const comparison = buildComparison(events, { days: 30 });
const { current, previous } = comparison;
const failures = [];
let passes = 0;

function check(name, condition, detail) {
  if (condition) {
    passes += 1;
    return;
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

check("sessions > 0", current.overview.sessions > 0, `sessions=${current.overview.sessions}`);
check("visitors > 0", current.overview.visitors > 0);
check("impressions > 0", current.overview.impressions > 0);
check("viewer opens > 0", current.overview.viewer_opens > 0);
check("about opens > 0", current.overview.about_opens > 0);
check("downloads > 0", current.overview.resume_downloads > 0);
check("previous window has data", previous.overview.sessions > 0);
check("daily rows sorted", current.daily.every((row, index) => index === 0 || current.daily[index - 1].date <= row.date));
check("funnel browse monotonic", current.funnel.browse.every((step, index) => index === 0 || step.sessions <= current.funnel.browse[index - 1].sessions));
check("funnel convert monotonic", current.funnel.convert.every((step, index) => index === 0 || step.sessions <= current.funnel.convert[index - 1].sessions));
check("download sessions <= about-open sessions", current.overview.resume_download_sessions <= current.overview.about_open_sessions,
  `${current.overview.resume_download_sessions}/${current.overview.about_open_sessions}`);
check("viewer sessions <= sessions", current.overview.viewer_sessions <= current.overview.sessions);
check("projects registry matches", current.projects.length === PROJECTS.length);
check("every project has total >= content pages", current.projects.every((project) => project.total >= project.content));
check("every project slide reach exists", current.projects.every((project) => project.slide_reach.length === project.total || project.viewer_opens === 0));
check("slide reach is non-increasing", current.projects.every((project) => project.slide_reach.every((page, index) => index === 0 || page.reached <= project.slide_reach[index - 1].reached)));
check("vitals samples > 0", current.vitals.samples > 0);
check("load samples > 0", current.load.samples > 0);
check("device shares sum near 100", Math.abs(current.devices.reduce((sum, device) => sum + device.pct, 0) - 100) < 1.5,
  current.devices.map((device) => `${device.name}:${device.pct}`).join(","));
check("viewer sources present", current.viewer.sources.length > 0);
check("exit reasons present", current.viewer.exit_reasons.length > 0);
check("no NaN in overview", Object.values(current.overview).every((value) => typeof value !== "number" || Number.isFinite(value)));
check("dashboard contract keys", ["overview", "daily", "projects", "about", "home", "viewer", "funnel", "devices", "referrers", "vitals", "load", "boot", "artwork", "resource_errors", "errors", "actions"].every((key) => key in current));
check("boot attempts >= successes", current.boot.attempts >= current.boot.successes, `${current.boot.successes}/${current.boot.attempts}`);
check("boot success rate in range", current.boot.success_rate >= 0 && current.boot.success_rate <= 100, String(current.boot.success_rate));
check("boot failure reasons reported", current.boot.fail_reasons.length > 0);
check("boot p75 positive", current.boot.p75_ms > 0, String(current.boot.p75_ms));
check("artwork load samples", current.artwork.count > 0, String(current.artwork.count));
check("artwork p75 positive", current.artwork.p75_ms > 0, String(current.artwork.p75_ms));
check("artwork phase split", current.artwork.by_phase.length === 2 && current.artwork.by_phase.every((phase) => phase.count >= 0));
check("daily boot fields", current.daily.every((row) => typeof row.boot_attempts === "number" && typeof row.boot_success === "number"));
check("meta event count positive", current.meta.event_count > 0);

// Sample project consistency: 抖音创作服务平台 has 24 content pages + THANK.
const platform = current.projects.find((project) => project.key === "douyin/douyin-platform");
check("platform page count", platform && platform.content === 24 && platform.total === 25, platform ? `${platform.content}/${platform.total}` : "missing");
check("platform slide reach length", platform && platform.slide_reach.length === 25, platform ? String(platform.slide_reach.length) : "missing");

if (failures.length) {
  console.error(`FAIL (${failures.length}/${passes + failures.length})`);
  failures.forEach((failure) => console.error(" -", failure));
  process.exit(1);
}
console.log(`PASS ${passes} checks · ${current.overview.sessions} sessions · ${current.meta.event_count} events in window`);
