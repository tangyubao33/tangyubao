const assetRoot = "唐尉保作品集2_files";

const pad = (value) => String(value).padStart(2, "0");

/* ---------------------------------------------------------------------------
   Analytics hooks (analytics.js). Every call is guarded: a blocked or broken
   collector must never affect the portfolio itself. `pageView()` fires here so
   the entry page view is the first event of the session, even on a deep link.
--------------------------------------------------------------------------- */
const analytics = window.PortfolioAnalytics || null;
const track = (name, props) => {
  try {
    analytics?.track?.(name, props);
  } catch (error) {
    /* analytics must never break the page */
  }
};
const analyticsActiveMs = () => {
  try {
    return analytics?.activeMs?.() || 0;
  } catch (error) {
    return 0;
  }
};
const makeTrackId = (prefix) => {
  try {
    return analytics?.id?.(prefix) || `${prefix}_${Date.now().toString(36)}`;
  } catch (error) {
    return `${prefix}_${Date.now().toString(36)}`;
  }
};
const currentViewportMode = () => {
  const width = window.innerWidth || 0;
  const height = window.innerHeight || 0;
  if (height <= 520 && width > 760) return "short-landscape";
  if (width <= 760) return "mobile";
  if (width <= 1100) return "tablet";
  return "desktop";
};
analytics?.pageView?.();

const jdSlides = Array.from({ length: 37 }, (_, index) => {
  const number = index + 1;
  const extension = [22, 33].includes(number) ? "jpg" : "png";
  return {
    src: `${assetRoot}/图片${number}.${extension}`,
    thumb: `assets/slide-thumbs/jd-${pad(number)}.jpg`,
    alt: `京东数坊案例第 ${number} 页`
  };
});

const kingsoftPages = [30, 31, 32, 33, 34, 35, 37, 38, 40, 41];
const kingsoftSlides = kingsoftPages.map((number, index) => ({
  src: `${assetRoot}/C端${number}.png`,
  thumb: `assets/slide-thumbs/kingsoft-${pad(index + 1)}.jpg`,
  alt: `金山词霸案例第 ${index + 1} 页`
}));

/* ---------------------------------------------------------------------------
   Composite slides: one PPT background image with media boxes laid on top.
   Every box is positioned in percentages of the frame, so the page scales as
   a single unit and the boxes never drift between viewports.
   `demoOverlays` is a placeholder until the real pages land via the local
   placement editor (.qa/media/compose.html).
--------------------------------------------------------------------------- */
const isComposite = (slide) => Boolean(slide && slide.type === "composite");
// Every project ends with the gallery back cover ("封底"). It is a normal image
// slide, but it is a closing page rather than content, so it does not count
// towards the "N PAGES" shown on the home / projects cards.
const isClosing = (slide) => Boolean(slide && slide.closing);
const contentPageCount = (project) => (project?.slides || []).filter((slide) => !isClosing(slide)).length;
const slideSource = (slide) => (isComposite(slide) ? (slide.src || slide.background) : slide?.src);
// High-res originals stay untouched; the viewer loads the smallest WebP that
// still covers the frame at the current device pixel ratio. The original is
// the fallback for large/retina/fullscreen displays.
const slideVariants = (src) => {
  const base = src.replace(/\.[^.]+$/, "");
  return [960, 1280, 1920, 2560].map((width) => ({
    width,
    src: `${base}.w${width}.webp`
  }));
};

/* Cards use the same cover art as viewer page 1 but only need a fraction of
   its pixels (a 259px-wide card at 2x is ~520 device px). Serving the 3200px
   JPEG there cost ~3MB on the home screen; the WebP variants cut that ~6x. */
const coverSrcset = (cover) => {
  const base = cover.replace(/\.[^.]+$/, "");
  // 640 is enough for the small home cards (and saves another ~40% there);
  // larger project / panel cards step up through the existing variants.
  return [640, 960, 1280, 1920, 2560]
    .map((width) => `${base}.w${width}.webp ${width}w`)
    .join(", ");
};

const isStack = (slide) => Boolean(slide && slide.type === "stack");
const stackProgress = new WeakMap();
const stackIndex = (slide) => stackProgress.get(slide) ?? 0;
const activeVisualSlide = (slide) => {
  if (!isStack(slide)) return slide;
  const layers = slide.layers || [];
  return layers[Math.max(0, Math.min(stackIndex(slide), layers.length - 1))] || slide;
};

const pickSlideSource = (slide) => {
  const visual = activeVisualSlide(slide);
  const base = slideSource(visual);
  const variants = visual?.variants;
  if (!base || !variants?.length) return base;
  const frame = document.querySelector(".artwork-frame");
  const cssWidth = frame?.clientWidth || Math.min(window.innerWidth * 0.82, 1920);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const target = Math.ceil((cssWidth * dpr) / 16) * 16;
  for (const variant of variants) {
    if (variant.width >= target) return variant.src;
  }
  // A 1440px fullscreen frame at 2x asks for ~2880px; the 3840px PNG master is
  // several MB. Up-to-30% upscaling from the 2560 variant is visually free and
  // avoids that download; only genuinely huge frames fall back to the master.
  const largest = variants[variants.length - 1];
  if (largest && target <= Math.round(largest.width * 1.3)) return largest.src;
  return base;
};

// Legacy JD / Kingsoft pages also get responsive variants.
jdSlides.forEach((slide) => { slide.variants = slideVariants(slide.src); });
kingsoftSlides.forEach((slide) => { slide.variants = slideVariants(slide.src); });

/* Keep the next few pages decoded before they are needed. Merely warming the
   URL still leaves the browser to decode a ~2560px WebP on the turn itself,
   which makes the loading veil flash on slower machines; decoding ahead moves
   that cost off the turn. The small LRU keeps decoded bitmaps alive for the
   next couple of pages without holding the whole project in memory. */
const warmedImages = new Map();
const WARM_IMAGE_LIMIT = 4;
/* Neighbours are warmed only after the page the visitor is looking at has
   decoded, so a slow link spends its bandwidth on the visible artwork first.
   Turns get a ~640ms head start while the slide animation runs. */
function warmViewerNeighbors() {
  if (state.screen !== "viewer") return;
  const project = currentProject();
  if (!project?.slides?.length) return;
  const index = state.slideIndex;
  [1, 2, -1].forEach((offset) => {
    const preloadIndex = index + offset;
    if (preloadIndex < 0 || preloadIndex >= project.slides.length) return;
    warmSlideImage(project.slides[preloadIndex]);
  });
}
function warmSlideImage(slide) {
  if (isStack(slide)) {
    (slide.layers || []).forEach((layer) => warmSlideImage(layer));
    return;
  }
  const src = pickSlideSource(slide);
  if (!src) return;
  const cached = warmedImages.get(src);
  if (cached) {
    warmedImages.delete(src);
    warmedImages.set(src, cached);
    return;
  }
  const image = new Image();
  image.decoding = "async";
  image.src = src;
  if (typeof image.decode === "function") image.decode().catch(() => {});
  warmedImages.set(src, image);
  while (warmedImages.size > WARM_IMAGE_LIMIT) {
    warmedImages.delete(warmedImages.keys().next().value);
  }
}

function whenImageDecoded(image, callback) {
  if (!image) { callback(); return; }
  if (typeof image.decode === "function") {
    image.decode().then(callback, callback);
  } else {
    callback();
  }
}

// When the viewport, DPR or fullscreen state changes, upgrade/downgrade the
// current image to the variant that matches the new displayed size.
let resolutionRefreshToken = 0;
function refreshArtworkResolution() {
  if (state.screen !== "viewer" || !elements.viewerScreen || elements.viewerScreen.hidden) return;
  if (elements.artwork.classList.contains("is-loading")) return;
  const project = currentProject();
  const slide = project?.slides?.[state.slideIndex];
  const visual = activeVisualSlide(slide);
  if (!slide || !visual || !visual.variants?.length) return;
  const wanted = pickSlideSource(visual);
  const current = elements.artwork.getAttribute("src") || "";
  if (!wanted || wanted === current) return;
  const token = ++resolutionRefreshToken;
  const preload = new Image();
  preload.decoding = "async";
  preload.onload = () => {
    whenImageDecoded(preload, () => {
      if (token !== resolutionRefreshToken || state.screen !== "viewer") return;
      const active = currentProject()?.slides?.[state.slideIndex];
      if (active !== slide || pickSlideSource(activeVisualSlide(active)) !== wanted) return;
      if (elements.artwork.getAttribute("src") === wanted) return;
      elements.artwork.src = wanted;
    });
  };
  preload.src = wanted;
}
const slideThumb = (slide) => slide?.thumb || slideSource(slide);
const slideVideoCount = (slide) =>
  isComposite(slide) ? (slide.overlays || []).filter((overlay) => overlay.kind === "video").length : 0;

/* 真实 PPT 页：亲声伴读 · iOS 端 AI 开发实践（第 6 页）。
   背景图已按空框位置量好（x/y/w/h 为相对整页的百分比），
   视频源先用 demo 片段占位——真实视频转码后只替换 src / poster 两行即可。 */
const readingSlide = {
  type: "composite",
  src: "assets/demo/ai-reading-01-preview.jpg",
  variants: slideVariants("assets/demo/ai-reading-01-preview.jpg"),
  background: "assets/demo/ai-reading-01.png",
  thumb: "assets/slide-thumbs/ai-reading-01.jpg",
  alt: "亲声伴读：iOS 端 AI 开发实践（PPT 背景图 + 演示视频）",
  overlays: [
    {
      kind: "video",
      id: "reading-demo",
      label: "亲声伴读 · iOS AI 实践演示",
      src: "assets/video/ai-practice-demo.mp4",
      poster: "assets/video/ai-practice-demo-poster.jpg",
      box: { x: 41.02, y: 33.01, w: 52.45, h: 54.35 },
      fit: "cover",
      radius: 1,
      muted: true,
      loop: false,
      soundHint: "注意检查电脑音量后，可取消静音播放",
      autoplay: true
    }
  ]
};

/* ByteDance works imported from 2026 作品材料 (4 folders):
   original-resolution PNG slides + responsive WebP variants + 320×180 rail thumbs. */
const bytedanceWorks = "assets/works/bytedance";
const buildWorksSlides = (folder, count, thumbPrefix, label) =>
  Array.from({ length: count }, (_, index) => {
    const number = pad(index + 1);
    const src = `${bytedanceWorks}/${folder}/${number}.png`;
    return {
      src,
      variants: slideVariants(src),
      thumb: `assets/slide-thumbs/${thumbPrefix}-${number}.jpg`,
      alt: `${label}第 ${index + 1} 页`
    };
  });

const platformSlide = (number, displayNumber) => {
  const src = `${bytedanceWorks}/platform/${pad(number)}.png`;
  return {
    src,
    variants: slideVariants(src),
    thumb: `assets/slide-thumbs/byte-platform-${pad(number)}.jpg`,
    alt: `抖音创作服务平台案例第 ${displayNumber} 页`
  };
};

// Several source pages are states of the same design: 7/8 (base -> click
// heatmap), 13-16 (four-step overview) and 25/26 (competitor comparison).
// Each group collapses into one viewer page whose layers cross-fade in place
// as the visitor scrolls; the rail thumbnail shows the settled/final layer.
const platformStack = (numbers, displayNumber, note) => {
  const layers = numbers.map((number) => platformSlide(number, displayNumber));
  return {
    type: "stack",
    src: layers[0].src,
    variants: layers[0].variants,
    thumb: layers[layers.length - 1].thumb,
    alt: `抖音创作服务平台案例第 ${displayNumber} 页（${note}）`,
    layers
  };
};
const platformPage = (number) => platformSlide(number, bytedancePlatformSlides.length + 1);
const bytedancePlatformSlides = [];
// Opening six pages: cover, macro background, problem, creator journey,
// creator lifecycle, then the three-direction framework (source 4) right
// before the STEP 1-3 chapters. Display numbers follow this order, not the
// source file numbers.
for (const number of [1, 2, 5, 3, 6, 4]) {
  bytedancePlatformSlides.push(platformPage(number));
}
bytedancePlatformSlides.push(platformStack([7, 8, 9, 10, 11], bytedancePlatformSlides.length + 1, "7–11 页渐隐叠加"));
bytedancePlatformSlides.push(platformPage(12));
bytedancePlatformSlides.push(platformStack([13, 14, 15, 16], bytedancePlatformSlides.length + 1, "13–16 页渐隐叠加"));
bytedancePlatformSlides.push(platformStack([17, 18, 19, 20], bytedancePlatformSlides.length + 1, "17–20 页渐隐叠加"));
for (let number = 21; number <= 24; number += 1) {
  bytedancePlatformSlides.push(platformPage(number));
}
bytedancePlatformSlides.push(platformStack([25, 26], bytedancePlatformSlides.length + 1, "25–26 页渐隐叠加"));
for (let number = 27; number <= 35; number += 1) {
  bytedancePlatformSlides.push(platformPage(number));
}
const bytedanceAiCoverSlides = buildWorksSlides("ai-cover", 9, "byte-ai-cover", "抖音 AI 封面案例");
// 抖音其他项目：新增一张首图（00），随后接原第 3 页与原第 1、2、4 页。
// 其中原第 1 页（37.jpg）是视频页：背景图 + 左侧手机框内嵌内容演示。
const bytedanceOtherOrder = [0, 3, 1, 2, 4];
const otherVideoBackground = `${bytedanceWorks}/other/01.jpg`;
const bytedanceOtherSlides = bytedanceOtherOrder.map((fileNumber, index) => {
  if (fileNumber === 1) {
    return {
      type: "composite",
      src: `${bytedanceWorks}/other/01-preview.jpg`,
      background: otherVideoBackground,
      variants: slideVariants(`${bytedanceWorks}/other/01-preview.jpg`),
      thumb: "assets/slide-thumbs/byte-other-01.jpg",
      alt: "抖音其他项目案例第 3 页（含视频演示）",
      overlays: [
        {
          kind: "video",
          id: "other-37-demo",
          label: "抖音其他项目 · 功能演示",
          src: "assets/video/other-37-demo.mp4",
          poster: "assets/video/other-37-demo-poster.jpg",
          box: { x: 8.57, y: 25.29, w: 20.71, h: 67.09 },
          fit: "cover",
          objectPosition: "top",
          radius: 1.6,
          radiusCorners: { tl: 1.6, tr: 1.6, br: 0, bl: 0 },
          muted: true,
          loop: false,
          silent: true,
          autoplay: true
        }
      ]
    };
  }
  const src = `${bytedanceWorks}/other/${pad(fileNumber)}.png`;
  return {
    src,
    variants: slideVariants(src),
    thumb: `assets/slide-thumbs/byte-other-${pad(fileNumber)}.jpg`,
    alt: `抖音其他项目案例第 ${index + 1} 页`
  };
});

// 抖音AI封面第 6 页（20240539）：左侧一个大手机框，嵌入产品端体验链路录屏。
const aiCover39Background = `${bytedanceWorks}/ai-cover/06.jpg`;
bytedanceAiCoverSlides[5] = {
  type: "composite",
  src: `${bytedanceWorks}/ai-cover/06-preview.jpg`,
  background: aiCover39Background,
  variants: slideVariants(`${bytedanceWorks}/ai-cover/06-preview.jpg`),
  thumb: "assets/slide-thumbs/byte-ai-cover-06.jpg",
  alt: "抖音 AI 封面案例第 6 页（含视频演示）",
  overlays: [
    {
      kind: "video",
      id: "ai-cover-39-demo",
      label: "AI 封面 · 产品端体验链路",
      src: "assets/video/ai-cover-39-demo.mp4",
      poster: "assets/video/ai-cover-39-demo-poster.jpg",
      // box = the phone frame's inner screen rect measured on 06.jpg
      // (inner x 513..1584, inner top 994 of 5760x3240), so the recording sits
      // inside the drawn border instead of covering it; objectPosition top keeps
      // the app's status bar flush with the frame's top edge.
      box: { x: 8.91, y: 30.68, w: 18.59, h: 70 },
      fit: "cover",
      objectPosition: "top",
      radius: 1.06,
      radiusCorners: { tl: 1.06, tr: 1.06, br: 0, bl: 0 },
      muted: true,
      loop: false,
      silent: true,
      autoplay: true
    }
  ]
};

// 抖音AI封面第 7 页：三个手机框分别嵌入修改底图 / 添加主题 / 自定义文字
// 三段录屏，点击播放，保持原背景图不动。
const aiCoverVideoBackground = `${bytedanceWorks}/ai-cover/07.jpg`;
const aiCoverVideoBoxes = [
  { x: 29.7, y: 33.12, w: 17.8, h: 70, radius: 1.3, label: "修改底图", src: "assets/video/ai-cover-step-1.mp4", poster: "assets/video/ai-cover-step-1-poster.jpg" },
  { x: 52.14, y: 33.12, w: 17.8, h: 70, radius: 1.3, label: "添加主题", src: "assets/video/ai-cover-step-2.mp4", poster: "assets/video/ai-cover-step-2-poster.jpg" },
  { x: 74.64, y: 33.12, w: 17.74, h: 70, radius: 1.3, label: "自定义文字", src: "assets/video/ai-cover-step-3.mp4", poster: "assets/video/ai-cover-step-3-poster.jpg" }
];
bytedanceAiCoverSlides[6] = {
  type: "composite",
  src: `${bytedanceWorks}/ai-cover/07-preview.jpg`,
  background: aiCoverVideoBackground,
  variants: slideVariants(`${bytedanceWorks}/ai-cover/07-preview.jpg`),
  thumb: "assets/slide-thumbs/byte-ai-cover-07.jpg",
  alt: "抖音 AI 封面案例第 7 页（含视频演示）",
  overlays: aiCoverVideoBoxes.map((item, index) => ({
    kind: "video",
    id: `ai-cover-step-${index + 1}`,
    label: `AI 封面 · ${item.label}`,
    src: item.src,
    poster: item.poster,
    box: { x: item.x, y: item.y, w: item.w, h: item.h },
    fit: "cover",
    radius: item.radius,
    muted: true,
    loop: false,
    silent: true,
    autoplay: true
  }))
};
// Pages 1-4 print the deployed product URL in their caption; a transparent
// hit area sits exactly on that line and opens the product in a new tab.
const practiceProductUrl = "https://tranquil-harmony-production-e442.up.railway.app/dashboard";
const practiceLinkBoxes = [
  { x: 67.8, y: 85.7, w: 21.1, h: 2.6 },
  { x: 55.2, y: 85.8, w: 32.3, h: 2.4 },
  { x: 55.2, y: 83.6, w: 32.3, h: 2.4 },
  { x: 49.4, y: 86.5, w: 32.4, h: 2.4 }
];
const bytedanceAiPracticeSlides = [
  ...buildWorksSlides("ai-practice", 5, "byte-ai-practice", "个人 AI 转型实践"),
  readingSlide
].map((slide, index) => {
  const box = practiceLinkBoxes[index];
  if (!box) return slide;
  return {
    ...slide,
    links: [
      {
        ...box,
        href: practiceProductUrl,
        label: "在新窗口打开「家庭财务系统」产品体验"
      }
    ]
  };
});

const experiences = {
  douyin: {
    id: "douyin",
    period: "2022~NOW",
    company: "抖音",
    mark: "抖",
    logo: "assets/marks/douyin.webp",
    accent: "#3c8cff",
    markBg: "#11151b",
    role: "平台产品设计师",
    meta: "创作平台设计负责人",
    caption: "项目主导与管理",
    projectNames: ["抖音创作服务平台", "抖音AI封面", "抖音其他项目", "个人AI转型实践"],
    projects: [
      {
        id: "douyin-platform",
        name: "抖音创作服务平台",
        type: "PLATFORM · WEB",
        description: "创作者与机构的一站式服务平台",
        cover: "assets/thumbs/douyin-platform.jpg",
        slides: bytedancePlatformSlides
      },
      {
        id: "douyin-ai-cover",
        name: "抖音AI封面",
        type: "AI · COVER DESIGN",
        description: "AI 封面生成与创作体验设计",
        cover: "assets/thumbs/douyin-ai-cover.jpg",
        slides: bytedanceAiCoverSlides
      },
      {
        id: "douyin-other",
        name: "抖音其他项目",
        type: "PRODUCT MATRIX",
        description: "多产品线的界面与体验设计",
        cover: "assets/thumbs/douyin-other.jpg",
        slides: bytedanceOtherSlides
      },
      {
        id: "douyin-ai-practice",
        name: "个人AI转型实践",
        type: "AI · PERSONAL PRACTICE",
        description: "AI 工具与个人工作流实践",
        cover: "assets/thumbs/douyin-ai-practice.jpg",
        slides: bytedanceAiPracticeSlides
      }
    ]
  },
  jd: {
    id: "jd",
    period: "2020~2022",
    company: "京东零售",
    mark: "JD",
    logo: "assets/marks/jd.webp",
    accent: "#ed2630",
    markBg: "#ed2630",
    role: "资深体验设计师",
    meta: "数坊项目设计负责人",
    caption: "项目主导与管理",
    projectNames: ["京东数坊平台 · 营销数据"],
    projects: [
      {
        id: "jd-shufang",
        name: "京东数坊平台 · 营销数据",
        type: "DATA PRODUCT · B2B",
        description: "融合营销数据产品与复杂信息体验",
        cover: "assets/thumbs/jd.jpg",
        slides: jdSlides
      }
    ]
  },
  kingsoft: {
    id: "kingsoft",
    period: "2016~2020",
    company: "金山办公",
    mark: "W",
    logo: "assets/marks/kingsoft.webp",
    accent: "#ff5a52",
    markBg: "linear-gradient(145deg, #ff784e, #f33d5d)",
    role: "高级 UI 设计师",
    meta: "设计执行角色",
    caption: "项目主导",
    projectNames: ["金山词霸"],
    projects: [
      {
        id: "kingsoft-powerword",
        name: "金山词霸",
        type: "MOBILE · CONSUMER",
        description: "学习、效率与增长场景的移动产品体验",
        cover: "assets/thumbs/mobile.jpg",
        slides: kingsoftSlides
      }
    ]
  }
};

// The current project cover is also the first viewer page. Keeping the cover
// and page 1 identical makes the card-to-viewer handoff seamless and avoids
// showing a second, unrelated opening slide.
Object.values(experiences).forEach((experience) => {
  experience.projects.forEach((project) => {
    const first = project.slides?.[0];
    if (!first || first.type) return;
    first.src = project.cover;
    first.variants = slideVariants(project.cover);
    first.alt = `${project.name}封面`;
    delete first.links;
  });
});

// Every project closes with the same gallery back cover (封底), a 16:9 bitmap
// from the cover design folder. It is appended after the cover setup above so
// it always lands last, and it is a normal image slide: page turns, thumbnails,
// fullscreen and the "other projects" panel need no special casing.
const BACK_COVER_SLIDE = {
  closing: true,
  src: "assets/works/back-cover.png",
  variants: slideVariants("assets/works/back-cover.png"),
  thumb: "assets/slide-thumbs/back-cover.jpg",
  alt: "封底 · 感谢观看",
  // The printed TEL / E-MAIL line stays clickable, like the old closing page.
  links: [
    { x: 37.9, y: 63.4, w: 13.4, h: 3.4, href: "tel:+8618911300923", label: "拨打 189113300923" },
    { x: 51.2, y: 63.4, w: 11.2, h: 3.4, href: "mailto:834316142@qq.com", label: "发送邮件到 834316142@qq.com" }
  ]
};
Object.values(experiences).forEach((experience) => {
  experience.projects.forEach((project) => {
    if (!project.slides?.length) return;
    project.slides.push({ ...BACK_COVER_SLIDE });
  });
});

const state = {
  screen: "home",
  experienceId: null,
  projectId: null,
  slideIndex: 0,
  viewerOrigin: "home"
};

const elements = {
  screens: [...document.querySelectorAll("[data-screen]")],
  timeline: document.querySelector("[data-timeline]"),
  projectGrid: document.querySelector("[data-project-grid]"),
  projectsMark: document.querySelector("[data-projects-mark]"),
  projectsPeriod: document.querySelector("[data-projects-period]"),
  projectsCompany: document.querySelector("[data-projects-company]"),
  projectsRole: document.querySelector("[data-projects-role]"),
  projectsMeta: document.querySelector("[data-projects-meta]"),
  viewerCompany: document.querySelector("[data-viewer-company]"),
  viewerTitle: document.querySelector("[data-viewer-title]"),
  currentCount: document.querySelector("[data-current-count]"),
  totalCount: document.querySelector("[data-total-count]"),
  artwork: document.querySelector("[data-main-artwork]"),
  artworkGhost: document.querySelector("[data-artwork-ghost]"),
  artworkLinks: document.querySelector("[data-artwork-links]"),
  slideCanvas: document.querySelector("[data-slide-canvas]"),
  loader: document.querySelector("[data-image-loader]"),
  thumbnailRail: document.querySelector("[data-thumbnail-rail]"),
  artworkFrame: document.querySelector("[data-artwork-frame]"),
  viewerScreen: document.querySelector('[data-screen="viewer"]'),
  fullscreenToggle: document.querySelector("[data-fullscreen-toggle]"),
  fullscreenCurrent: document.querySelector("[data-fullscreen-current]"),
  fullscreenTotal: document.querySelector("[data-fullscreen-total]"),
  viewerStage: document.querySelector("[data-viewer-stage]"),
  homeScreen: document.querySelector('[data-screen="home"]'),
  otherProjectsRail: document.querySelector("[data-other-projects-rail]"),
  otherProjects: document.querySelector("[data-other-projects]"),
  streamShell: document.querySelector("[data-stream-shell]"),
  streamProgress: document.querySelector("[data-stream-progress]"),
  viewerBackLabel: document.querySelector("[data-viewer-back-label]")
};

const currentExperience = () => experiences[state.experienceId];

function isViewerFullscreen() {
  return document.fullscreenElement === elements.viewerScreen || elements.viewerScreen.classList.contains("is-pseudo-fullscreen");
}

let fullscreenIdleTimer = 0;
let fullscreenExitAt = 0;
let fullscreenMorph = null;

function wakeFullscreenUI() {
  if (!isViewerFullscreen()) return;
  elements.viewerScreen.classList.remove("is-ui-idle");
  window.clearTimeout(fullscreenIdleTimer);
  fullscreenIdleTimer = window.setTimeout(() => {
    if (isViewerFullscreen()) elements.viewerScreen.classList.add("is-ui-idle");
  }, 2400);
}

function resetFullscreenUI() {
  window.clearTimeout(fullscreenIdleTimer);
  elements.viewerScreen.classList.remove("is-ui-idle");
}

function beginFullscreenMorph() {
  if (fullscreenMorph) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const frame = elements.artworkFrame.getBoundingClientRect();
  const source = elements.artwork.currentSrc || elements.artwork.src;
  if (!source || !frame.width) return;
  const overlay = document.createElement("div");
  overlay.className = "viewer-entry";
  overlay.setAttribute("aria-hidden", "true");
  const image = document.createElement("img");
  image.className = "viewer-entry-page";
  image.alt = "";
  image.src = source;
  image.style.objectFit = "contain";
  image.style.opacity = "1";
  overlay.append(image);
  overlay.style.left = `${frame.left}px`;
  overlay.style.top = `${frame.top}px`;
  overlay.style.width = `${frame.width}px`;
  overlay.style.height = `${frame.height}px`;
  overlay.style.borderRadius = "0px";
  // the overlay must live inside the fullscreen element, otherwise the
  // browser only paints the fullscreen subtree
  elements.viewerScreen.appendChild(overlay);
  elements.viewerScreen.classList.add("is-scene-entering");
  fullscreenMorph = { overlay, from: frame };
}

function finishFullscreenMorph() {
  const morph = fullscreenMorph;
  if (!morph) {
    elements.viewerScreen.classList.remove("is-scene-entering");
    return;
  }
  fullscreenMorph = null;
  sizeArtworkFrame();
  const { overlay, from } = morph;
  if (!overlay.isConnected) {
    elements.viewerScreen.classList.remove("is-scene-entering");
    return;
  }
  const to = elements.artworkFrame.getBoundingClientRect();
  const animation = overlay.animate([
    { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` },
    { left: `${to.left}px`, top: `${to.top}px`, width: `${to.width}px`, height: `${to.height}px` }
  ], { duration: 460, easing: "cubic-bezier(.22, 1, .36, 1)", fill: "forwards" });
  animation.onfinish = () => {
    overlay.remove();
    elements.viewerScreen.classList.remove("is-scene-entering");
  };
}

function syncFullscreenUI() {
  const active = isViewerFullscreen();
  elements.viewerScreen.classList.toggle("is-fullscreen", active);
  elements.fullscreenToggle.setAttribute("aria-pressed", String(active));
  const label = active ? "退出全屏" : "全屏浏览";
  elements.fullscreenToggle.setAttribute("aria-label", label);
  elements.fullscreenToggle.setAttribute("title", label);
  const labelNode = elements.fullscreenToggle.querySelector("[data-fullscreen-label]");
  if (labelNode) labelNode.textContent = label;
  if (active) wakeFullscreenUI();
  else resetFullscreenUI();
  window.requestAnimationFrame(() => {
    sizeArtworkFrame();
    updateRailMask();
  });
  window.setTimeout(refreshArtworkResolution, 80);
}

function clearFullscreenMorph() {
  if (!fullscreenMorph) return;
  fullscreenMorph.overlay.remove();
  fullscreenMorph = null;
  elements.viewerScreen.classList.remove("is-scene-entering");
}

function exitPseudoFullscreen() {
  elements.viewerScreen.classList.remove("is-pseudo-fullscreen");
  fullscreenExitAt = performance.now();
  syncFullscreenUI();
}

function toggleViewerFullscreen() {
  if (state.screen !== "viewer") return;
  const entering = !isViewerFullscreen();
  if (entering && viewerSession) viewerSession.fullscreen = true;
  track("fullscreen_toggle", {
    entering: entering,
    project: state.projectId,
    page: state.slideIndex + 1
  });
  beginFullscreenMorph();
  if (isViewerFullscreen()) {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {
        exitPseudoFullscreen();
        window.requestAnimationFrame(finishFullscreenMorph);
      });
    } else {
      exitPseudoFullscreen();
      window.requestAnimationFrame(finishFullscreenMorph);
    }
    return;
  }
  const request = elements.viewerScreen.requestFullscreen;
  if (typeof request === "function") {
    request.call(elements.viewerScreen).catch(() => {
      elements.viewerScreen.classList.add("is-pseudo-fullscreen");
      syncFullscreenUI();
      window.requestAnimationFrame(finishFullscreenMorph);
    });
  } else {
    elements.viewerScreen.classList.add("is-pseudo-fullscreen");
    syncFullscreenUI();
    window.requestAnimationFrame(finishFullscreenMorph);
  }
}

document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement) {
    elements.viewerScreen.classList.remove("is-pseudo-fullscreen");
    fullscreenExitAt = performance.now();
  }
  syncFullscreenUI();
  if (fullscreenMorph) window.requestAnimationFrame(() => window.requestAnimationFrame(finishFullscreenMorph));
});

// Reading gesture: left click on the artwork turns forward, right click (in
// fullscreen, where the browser menu is suppressed) turns back. Links, buttons,
// native video controls and media boxes keep their own clicks. In the normal
// viewer only the big image area is a page-turn target, not the empty stage.
function viewerPageTarget(event) {
  if (state.screen !== "viewer") return false;
  if (!event.target.closest?.("[data-artwork-frame]")) return false;
  return !event.target.closest("a, button, video, audio, .artwork-toolbar, .slide-canvas, .other-projects");
}

elements.viewerScreen.addEventListener("click", (event) => {
  if (viewerPageTarget(event)) navigateViewer(1, "click");
});

elements.viewerScreen.addEventListener("contextmenu", (event) => {
  if (!isViewerFullscreen() || state.screen !== "viewer") return;
  event.preventDefault();
  if (viewerPageTarget(event)) navigateViewer(-1, "click");
});

/* Casual image saving is blocked: no context menu / drag on artwork, cards,
   thumbnails or video frames. This cannot stop screenshots or devtools, but it
   removes the obvious right-click / long-press "save image" path. The fullscreen
   right-click page-turn above still runs before this handler and is unaffected. */
const protectedImageTarget = (event) =>
  event.target instanceof Element
    ? event.target.closest("img, video, .artwork-frame, .stream-project, .project-card, .other-project, .media-box, .thumbnail")
    : null;

document.addEventListener("contextmenu", (event) => {
  if (protectedImageTarget(event)) event.preventDefault();
});

document.addEventListener("dragstart", (event) => {
  if (event.target instanceof Element && event.target.closest("img, video")) event.preventDefault();
});

document.addEventListener("pointermove", wakeFullscreenUI, { passive: true });
document.addEventListener("touchstart", wakeFullscreenUI, { passive: true });
document.addEventListener("keydown", wakeFullscreenUI);

function updateRailMask() {
  const rail = elements.thumbnailRail;
  if (!rail.offsetHeight) return;
  // Portrait screens use a horizontal strip at the bottom of the viewer;
  // wide screens keep the vertical rail on the right.
  const horizontal = getComputedStyle(rail).flexDirection === "row";
  const max = horizontal ? rail.scrollWidth - rail.clientWidth : rail.scrollHeight - rail.clientHeight;
  const position = horizontal ? rail.scrollLeft : rail.scrollTop;
  rail.classList.toggle("is-no-scroll", max <= 2);
  rail.classList.toggle("is-at-top", max > 2 && position <= 2);
  rail.classList.toggle("is-at-bottom", max > 2 && position >= max - 2);
  // Fewer than 15 pages: if they all fit, center the group in the rail
  // instead of leaving the empty space at the bottom (wide screens) or right
  // (portrait strip). This also keeps the first thumb clear of the top fade.
  const count = rail.querySelectorAll(".thumbnail").length;
  rail.classList.toggle("is-short-list", count > 0 && count < 15 && max <= 2);
}

elements.thumbnailRail.addEventListener("scroll", updateRailMask, { passive: true });

/* The artwork frame hugs the artwork instead of the whole stage, so the
   image never letterboxes inside its own container and the click transition
   can hand off to an identical rectangle. */
function otherProjectsReserve() {
  const panel = elements.otherProjects;
  const screen = elements.viewerScreen;
  if (!panel || !screen || !screen.classList.contains("is-last-slide") || isViewerFullscreen()) return 0;
  return panel.offsetHeight + 14;
}

/* the last page panel slides over the stage bottom: reserve its height so the
   artwork + fullscreen button sit above it instead of under the project cards */
function syncPanelReserve() {
  const screen = elements.viewerScreen;
  const reserve = otherProjectsReserve();
  screen.style.setProperty("--panel-reserve", `${reserve}px`);
  return reserve;
}

function sizeArtworkFrame() {
  const stage = elements.viewerStage;
  const frame = elements.artworkFrame;
  if (!stage || !frame) return;
  const style = window.getComputedStyle(stage);
  const padTop = parseFloat(style.paddingTop);
  const padBottom = parseFloat(style.paddingBottom);
  const availableWidth = stage.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  const toolbar = elements.fullscreenToggle?.closest(".artwork-toolbar");
  // In fullscreen the exit button floats over the page, so the artwork can use
  // the whole screen instead of reserving a row underneath it.
  const toolbarHeight = isViewerFullscreen() ? 0 : (toolbar ? toolbar.offsetHeight + 16 : 0);
  const reserve = syncPanelReserve();
  const availableHeight = stage.clientHeight - padTop - padBottom - toolbarHeight - reserve;
  if (availableWidth <= 0 || availableHeight <= 0) return;
  const artwork = elements.artwork;
  const ratio = artwork.naturalWidth && artwork.naturalHeight ? artwork.naturalWidth / artwork.naturalHeight : 16 / 9;
  let width = availableWidth;
  let height = width / ratio;
  if (height > availableHeight) {
    height = availableHeight;
    width = height * ratio;
  }
  frame.style.width = `${Math.round(width)}px`;
  frame.style.height = `${Math.round(height)}px`;
  // 1% of the frame width: media-box radii/shadows are stored as percentages
  // so they scale with the page instead of looking oversized on small screens;
  frame.style.setProperty("--frame-unit", `${width / 100}px`);
  if (elements.slideCanvas) elements.slideCanvas.style.setProperty("--frame-unit", `${width / 100}px`);
  // the "other projects" panel overlays the stage bottom: nudge the whole
  // stack (artwork + fullscreen button) up so it ends above the panel
  const stackHeight = height + toolbarHeight;
  const contentHeight = stage.clientHeight - padTop - padBottom;
  const stackBottom = padTop + (contentHeight + stackHeight) / 2;
  const overlap = Math.max(0, stackBottom - (stage.clientHeight - reserve));
  elements.viewerScreen.style.setProperty("--stack-shift", `${Math.round(overlap)}px`);
}

let panelAdjustTimer = 0;

function setLastSlide(active) {
  const screen = elements.viewerScreen;
  const wasLast = screen.classList.contains("is-last-slide");
  if (wasLast === active) {
    sizeArtworkFrame();
    return;
  }
  if (!screen.classList.contains("is-scene-entering")) {
    // the panel slides in/out over 550ms; resize + shift the artwork with it
    screen.classList.add("is-panel-adjusting");
    window.clearTimeout(panelAdjustTimer);
    panelAdjustTimer = window.setTimeout(() => screen.classList.remove("is-panel-adjusting"), 620);
  }
  screen.classList.toggle("is-last-slide", active);
  sizeArtworkFrame();
}

const contactToggles = [...document.querySelectorAll("[data-contact-toggle]")];
const contactCard = document.querySelector("[data-contact-card]");
const contactBackdrop = document.querySelector("[data-contact-backdrop]");
const aboutCols = [...(contactCard?.querySelectorAll(".about-col") || [])];
let contactTrigger = null;

function contactFocusable() {
  return [...contactCard.querySelectorAll("a, button")].filter((element) => element.offsetParent !== null);
}

/* Overlay scrollbar: the native bar is hidden in CSS so this thin thumb can fade
   in with a transition when the pointer enters the dialog. */
function updateAboutScrollbar(col) {
  const view = col.querySelector(".about-side, .about-main");
  const bar = col.querySelector(".about-scrollbar");
  const thumb = bar?.firstElementChild;
  if (!view || !bar || !thumb) return;
  const max = view.scrollHeight - view.clientHeight;
  const scrollable = max > 2;
  col.dataset.scrollable = String(scrollable);
  if (!scrollable) {
    thumb.style.height = "0px";
    return;
  }
  const track = Math.max(0, view.clientHeight - 24);
  const thumbHeight = Math.min(track, Math.max(28, Math.round(track * (view.clientHeight / view.scrollHeight))));
  const offset = Math.round((view.scrollTop / max) * Math.max(0, track - thumbHeight));
  thumb.style.height = `${thumbHeight}px`;
  thumb.style.transform = `translateY(${offset}px)`;
}

function updateAboutScrollbars() {
  aboutCols.forEach(updateAboutScrollbar);
}

aboutCols.forEach((col) => {
  col.querySelector(".about-side, .about-main")?.addEventListener("scroll", () => updateAboutScrollbar(col), { passive: true });
});

function setContactCard(open, restoreFocus = false, reason = "toggle") {
  if (!contactToggles.length || !contactCard) return;
  const isOpen = contactCard.classList.contains("is-open");
  if (open === isOpen) return;
  if (open) {
    const source = contactTrigger?.classList.contains("profile-top") ? "profile" : "header";
    aboutSession = {
      id: makeTrackId("ab"),
      source: source,
      screen: state.screen,
      startedAt: analyticsActiveMs(),
      project: state.projectId || null
    };
    track("about_open", {
      about_id: aboutSession.id,
      source: source,
      screen: state.screen,
      project: state.projectId || null,
      page: state.screen === "viewer" ? state.slideIndex + 1 : null
    });
  } else if (aboutSession) {
    track("about_close", {
      about_id: aboutSession.id,
      source: aboutSession.source,
      screen: aboutSession.screen,
      duration_ms: Math.max(0, analyticsActiveMs() - aboutSession.startedAt),
      reason: reason,
      side_scroll: aboutScrollPct("side"),
      main_scroll: aboutScrollPct("main")
    });
    aboutSession = null;
  }
  contactCard.classList.toggle("is-open", open);
  contactBackdrop?.classList.toggle("is-open", open);
  document.body.classList.toggle("is-about-open", open);
  contactToggles.forEach((element) => element.setAttribute("aria-expanded", String(open)));
  if (open) {
    // the card fades in from visibility:hidden, so focus has to wait for the
    // next task or the browser refuses it
    window.setTimeout(() => contactFocusable()[0]?.focus({ preventScroll: true }), 0);
    updateAboutScrollbars();
    window.setTimeout(updateAboutScrollbars, 460);
  } else if (restoreFocus) {
    (contactTrigger || contactToggles[0]).focus({ preventScroll: true });
  }
}

contactToggles.forEach((element) => {
  element.addEventListener("click", () => {
    contactTrigger = element;
    setContactCard(!contactCard.classList.contains("is-open"));
  });
});

contactCard.addEventListener("click", (event) => {
  if (event.target.closest("[data-contact-close]")) setContactCard(false, true);
});

// 主要职责 / 能力亮点 fold away; JD and the ability highlights start collapsed
contactCard.addEventListener("click", (event) => {
  const toggle = event.target.closest?.("[data-fold-toggle]");
  if (!toggle) return;
  const wrap = toggle.closest("[data-fold]");
  if (!wrap) return;
  const open = !wrap.classList.contains("is-open");
  wrap.classList.toggle("is-open", open);
  toggle.setAttribute("aria-expanded", String(open));
  track("about_fold", {
    about_id: aboutSession?.id || null,
    fold: toggle.getAttribute("aria-controls") || "unknown",
    open: open
  });
  const panel = wrap.querySelector(".about-fold-panel");
  if (panel) {
    panel.toggleAttribute("inert", !open);
    panel.setAttribute("aria-hidden", String(!open));
  }
  updateAboutScrollbars();
  window.setTimeout(updateAboutScrollbars, 420);
});

contactCard.addEventListener("keydown", (event) => {
  if (event.key !== "Tab") return;
  const focusable = contactFocusable();
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  }
});

document.addEventListener("click", (event) => {
  if (!contactCard.classList.contains("is-open")) return;
  if (contactCard.contains(event.target)) return;
  if (contactToggles.some((element) => element.contains(event.target))) return;
  setContactCard(false);
});

/* Contact / resume / outbound-link intents. These are captured on document
   because the links live in several places (header, about dialog, artwork
   hotspots) and are re-rendered per slide. */
document.addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  const contact = target.closest('a[href^="tel:"], a[href^="mailto:"]');
  if (contact) {
    const href = contact.getAttribute("href") || "";
    const scope = contact.closest("[data-contact-card]")
      ? "about"
      : contact.closest(".site-header")
        ? "header"
        : "viewer";
    track("contact_click", {
      channel: href.indexOf("tel:") === 0 ? "tel" : "email",
      source: scope,
      screen: state.screen,
      project: state.projectId || null,
      page: state.screen === "viewer" ? state.slideIndex + 1 : null
    });
  }
  const download = target.closest(".about-download");
  if (download) {
    track("resume_download", {
      file: "tangyubao-resume-2026.pdf",
      source: "about",
      about_id: aboutSession?.id || null,
      screen: state.screen,
      since_about_open_ms: aboutSession ? analyticsActiveMs() - aboutSession.startedAt : null
    });
  }
  const outbound = target.closest(".artwork-links a, .artwork-link");
  if (outbound) {
    let host = "";
    try {
      host = new URL(outbound.href).hostname;
    } catch (error) {
      host = "";
    }
    track("link_click", {
      project: state.projectId,
      page: state.slideIndex + 1,
      label: outbound.getAttribute("aria-label") || outbound.getAttribute("title") || "",
      host: host
    });
  }
});

window.addEventListener("resize", () => {
  if (contactCard.classList.contains("is-open")) updateAboutScrollbars();
});

const currentProject = () => currentExperience()?.projects.find((project) => project.id === state.projectId);

/* ---- analytics session state --------------------------------------------
   A viewer "session" starts when a project is opened and ends when it is left,
   so page-depth, dwell and drop-off can be paired per open instead of being
   inferred from loose events. `homeEngagement` keeps the per-home-visit state
   used by the exposure and scroll-depth events. */
let viewerSession = null;
let viewerExitReason = "";
let aboutSession = null;
let playedMedia = new Set();
const homeEngagement = { enteredAt: 0, exposures: new Set(), drags: 0, hovers: 0, maxProgress: 0, buckets: new Set() };
const cardImpressions = new Set();
const impressionTimers = new Map();
let impressionCheckTimer = 0;

const slideTypeOf = (slide) => (isComposite(slide) ? "composite" : isStack(slide) ? "stack" : "image");

function startViewerSession(project, experience, source) {
  endViewerSession("restart");
  if (!project || !experience || !project.slides?.length) return;
  playedMedia = new Set();
  viewerSession = {
    id: makeTrackId("vr"),
    projectId: project.id,
    projectName: project.name,
    experienceId: experience.id,
    total: project.slides.length,
    contentPages: contentPageCount(project),
    source: source || "direct",
    startedAt: analyticsActiveMs(),
    slideAt: analyticsActiveMs(),
    maxIndex: 0,
    exitIndex: 0,
    lastPage: -1,
    viewed: new Set(),
    slides: 0,
    fullscreen: false,
    ended: false
  };
  const visitor = analytics?.visitor?.() || {};
  track("viewer_open", {
    viewer_id: viewerSession.id,
    project: project.id,
    project_key: `${experience.id}/${project.id}`,
    name: project.name,
    experience: experience.id,
    company: experience.company,
    pages: viewerSession.total,
    content_pages: viewerSession.contentPages,
    origin: viewerSession.source,
    visitor_new: visitor.new,
    mode: currentViewportMode()
  });
  analytics?.setContext?.({ viewer_project: project.id, viewer_page: 1, viewer_id: viewerSession.id });
}

function endViewerSession(reason = "navigate") {
  if (!viewerSession || viewerSession.ended) return;
  const session = viewerSession;
  session.ended = true;
  viewerSession = null;
  const duration = Math.max(0, analyticsActiveMs() - session.startedAt);
  const maxPercent = session.total > 1 ? Math.round(((session.maxIndex + 1) / session.total) * 100) : 100;
  track("viewer_exit", {
    viewer_id: session.id,
    project: session.projectId,
    project_key: `${session.experienceId}/${session.projectId}`,
    experience: session.experienceId,
    total: session.total,
    content_pages: session.contentPages,
    max_index: session.maxIndex + 1,
    exit_index: state.slideIndex + 1,
    slides_viewed: session.viewed.size,
    duration_ms: duration,
    bounce: session.viewed.size <= 1,
    quick_exit: duration < 5000,
    reached_last_content: session.maxIndex >= session.contentPages - 1,
    reached_thank: session.maxIndex >= session.total - 1,
    max_percent: Math.max(0, Math.min(100, maxPercent)),
    fullscreen: session.fullscreen,
    last_dwell_ms: Math.max(0, analyticsActiveMs() - session.slideAt),
    exit_reason: reason
  });
  analytics?.setContext?.({ viewer_project: null, viewer_page: null, viewer_id: null });
}

function trackViewerSlide(slide, via) {
  const session = viewerSession;
  if (!session) return;
  const now = analyticsActiveMs();
  const dwell = Math.max(0, now - session.slideAt);
  const previousPage = session.lastPage >= 0 ? session.lastPage + 1 : 0;
  session.slideAt = now;
  session.maxIndex = Math.max(session.maxIndex, state.slideIndex);
  session.exitIndex = state.slideIndex;
  session.lastPage = state.slideIndex;
  const firstView = !session.viewed.has(state.slideIndex);
  if (firstView) session.viewed.add(state.slideIndex);
  session.slides += 1;
  track("viewer_slide", {
    viewer_id: session.id,
    project: session.projectId,
    project_key: `${session.experienceId}/${session.projectId}`,
    page: state.slideIndex + 1,
    total: session.total,
    content_pages: session.contentPages,
    type: slideTypeOf(slide),
    source: via,
    first_view: firstView,
    prev_page: previousPage,
    prev_dwell_ms: dwell
  });
  analytics?.setContext?.({ viewer_project: session.projectId, viewer_page: state.slideIndex + 1, viewer_id: session.id });
}

/* 作品页图片加载耗时：从开始选图到解码完成（不含 640ms 翻页动画），
   用于区分「首屏页加载」与「翻页加载」的性能问题。 */
let artworkLoad = null;

function beginArtworkLoad(slide, phase) {
  if (!slide) { artworkLoad = null; return; }
  const project = currentProject();
  if (!project) { artworkLoad = null; return; }
  const src = pickSlideSource(slide);
  artworkLoad = {
    startedAt: performance.now(),
    project: project.id,
    projectKey: `${state.experienceId}/${project.id}`,
    page: state.slideIndex + 1,
    type: slideTypeOf(slide),
    phase: phase,
    src: src
  };
}

function finishArtworkLoad(ok) {
  const load = artworkLoad;
  if (!load) return;
  artworkLoad = null;
  const duration = Math.max(0, performance.now() - load.startedAt);
  const match = /\.w(\d+)\.webp$/.exec(load.src || "");
  track("artwork_load", {
    project: load.project,
    project_key: load.projectKey,
    page: load.page,
    type: load.type,
    phase: load.phase,
    duration_ms: Math.round(duration),
    success: ok !== false,
    variant_w: match ? Number(match[1]) : 0,
    mode: currentViewportMode()
  });
}

function trackCardClick(experience, project, mode) {
  if (!experience || !project) return;
  const key = `${experience.id}/${project.id}`;
  track("card_click", {
    project: project.id,
    project_key: key,
    name: project.name,
    experience: experience.id,
    company: experience.company,
    mode: mode,
    position: experience.projects.findIndex((item) => item.id === project.id) + 1,
    exposed: cardImpressions.has(key),
    time_on_home_ms: mode === "home" && homeEngagement.enteredAt ? analyticsActiveMs() - homeEngagement.enteredAt : null
  });
}

function startHomeEngagement() {
  homeEngagement.enteredAt = analyticsActiveMs();
  homeEngagement.exposures = new Set();
  homeEngagement.drags = 0;
  homeEngagement.hovers = 0;
  homeEngagement.maxProgress = 0;
  homeEngagement.buckets = new Set();
  const visitor = analytics?.visitor?.() || {};
  const session = analytics?.session?.() || {};
  track("home_view", {
    cards: elements.timeline.querySelectorAll(".stream-project").length,
    experiences: Object.keys(experiences).length,
    visitor_new: visitor.new,
    session_new: session.new,
    returning: visitor.new === false,
    mode: currentViewportMode(),
    vw: window.innerWidth,
    vh: window.innerHeight
  });
  scheduleImpressionCheck(700);
}

function endHomeEngagement() {
  if (!homeEngagement.enteredAt) return;
  const duration = Math.max(0, analyticsActiveMs() - homeEngagement.enteredAt);
  track("home_exit", {
    duration_ms: duration,
    impressions: homeEngagement.exposures.size,
    drags: homeEngagement.drags,
    hovers: homeEngagement.hovers,
    max_progress: Math.round(homeEngagement.maxProgress * 100),
    scroll_buckets: [...homeEngagement.buckets].sort((a, b) => a - b).map((bucket) => Math.round(bucket * 100)).join(","),
    mode: currentViewportMode()
  });
  homeEngagement.enteredAt = 0;
}

function aboutScrollPct(which) {
  const view = contactCard?.querySelector(which === "side" ? ".about-side" : ".about-main");
  if (!view) return 0;
  const max = view.scrollHeight - view.clientHeight;
  return max > 0 ? Math.round((view.scrollTop / max) * 100) : 100;
}

/* Exposure = at least half of the card's area inside the stream viewport for
   500ms. The stream moves by transform (not native scroll), so Intersection-
   Observer would miss drags; the checks are driven by the damped stream frame
   settling instead. */
function scheduleImpressionCheck(delay = 120) {
  window.clearTimeout(impressionCheckTimer);
  impressionCheckTimer = window.setTimeout(checkCardImpressions, delay);
}

function checkCardImpressions() {
  if (state.screen !== "home" || document.visibilityState !== "visible") return;
  const shell = elements.streamShell;
  if (!shell) return;
  const shellRect = shell.getBoundingClientRect();
  const viewportHeight = window.innerHeight;
  const cards = [...elements.timeline.querySelectorAll(".stream-project")];
  cards.forEach((card, index) => {
    const key = card.dataset.homeExperience ? `${card.dataset.homeExperience}/${card.dataset.homeProject}` : "";
    if (!key || cardImpressions.has(key)) return;
    const rect = card.getBoundingClientRect();
    const left = Math.max(rect.left, shellRect.left);
    const right = Math.min(rect.right, shellRect.right);
    const top = Math.max(rect.top, 0);
    const bottom = Math.min(rect.bottom, viewportHeight);
    const area = Math.max(0, right - left) * Math.max(0, bottom - top);
    const ratio = rect.width && rect.height ? area / (rect.width * rect.height) : 0;
    if (ratio >= 0.5) {
      if (impressionTimers.has(key)) return;
      impressionTimers.set(key, window.setTimeout(() => {
        impressionTimers.delete(key);
        if (cardImpressions.has(key) || state.screen !== "home") return;
        cardImpressions.add(key);
        homeEngagement.exposures.add(key);
        const nameNode = card.querySelector(".stream-project-info b");
        track("card_impression", {
          project: card.dataset.homeProject,
          project_key: key,
          experience: card.dataset.homeExperience,
          name: nameNode?.textContent || "",
          position: index + 1,
          ratio: Math.round(ratio * 100) / 100,
          time_on_home_ms: homeEngagement.enteredAt ? analyticsActiveMs() - homeEngagement.enteredAt : null
        });
      }, 500));
    } else if (impressionTimers.has(key)) {
      window.clearTimeout(impressionTimers.get(key));
      impressionTimers.delete(key);
    }
  });
}

function renderTimeline() {
  elements.timeline.innerHTML = Object.values(experiences).map((experience, experienceIndex) => `
    <section class="experience-group" style="--accent:${experience.accent};--mark-bg:${experience.markBg}">
      <header class="group-meta">
        <span class="group-mark${experience.logo ? " has-logo" : ""}" aria-hidden="true">${experience.logo ? `<img src="${experience.logo}" alt="" loading="lazy" decoding="async">` : experience.mark}</span>
        <span class="group-identity">
          <span class="group-index">${experience.period}</span>
          <b class="group-company">${experience.company}</b>
        </span>
        <span class="group-divider" aria-hidden="true"></span>
        <span class="group-copy">
          <strong>${experience.role}</strong>
          <small>${experience.meta}</small>
        </span>
      </header>
      <div class="group-projects" style="--group-width:calc(${experience.projects.map(() => "var(--stream-card-width)").concat(experience.projects.slice(1).map(() => "var(--group-gap)")).join(" + ")})">
        ${experience.projects.map((project, projectIndex) => `
          <button class="stream-project${project.disabled ? " is-pending" : ""}" type="button" data-home-project="${project.id}" data-home-experience="${experience.id}" aria-label="查看 ${project.name}">
            <img src="${project.cover}" srcset="${coverSrcset(project.cover)}" sizes="(max-width: 760px) 74vw, (max-height: 520px) and (min-width: 761px) 26vw, 18vw" alt="" loading="lazy" decoding="async"${experienceIndex === 0 && projectIndex === 0 ? ' fetchpriority="high"' : ""}>
            <span class="stream-project-top"><i>${pad(projectIndex + 1)}</i><em>${project.type}</em></span>
            <span class="stream-project-info">
              <b>${project.name}</b>
              <small>${project.disabled ? "项目资料整理中" : `${contentPageCount(project)} PAGES · EXPLORE`}</small>
            </span>
          </button>
        `).join("")}
      </div>
    </section>
  `).join("");
}

function renderProjects() {
  const experience = currentExperience();
  if (!experience) return;

  elements.projectsMark.classList.toggle("has-logo", Boolean(experience.logo));
  elements.projectsMark.innerHTML = experience.logo
    ? `<img src="${experience.logo}" alt="" decoding="async">`
    : experience.mark;
  elements.projectsMark.style.setProperty("--accent", experience.accent);
  elements.projectsMark.style.setProperty("--mark-bg", experience.markBg);
  elements.projectsPeriod.textContent = experience.period;
  elements.projectsCompany.textContent = experience.company;
  elements.projectsRole.textContent = experience.role;
  elements.projectsMeta.textContent = experience.meta;

  elements.projectGrid.innerHTML = experience.projects.map((project, index) => `
    <button class="project-card${project.disabled ? " is-disabled" : ""}" type="button" ${project.disabled ? "disabled" : `data-project="${project.id}"`}>
      <img src="${project.cover}" srcset="${coverSrcset(project.cover)}" sizes="(max-width: 760px) calc(100vw - 48px), (max-width: 1100px) 44vw, 33vw" alt="" loading="lazy" decoding="async">
      <span class="project-card-number">${pad(index + 1)}</span>
      <span class="project-card-content">
        <span>${project.type}</span>
        <h3>${project.name}</h3>
        <p>${project.description}${project.slides ? ` · ${contentPageCount(project)} PAGES` : ""}</p>
      </span>
    </button>
  `).join("");
}

function otherProjectItems() {
  const currentExperienceId = state.experienceId;
  const currentProjectId = state.projectId;
  return Object.values(experiences).flatMap((experience) =>
    experience.projects
      .filter((project) => !project.disabled && project.slides?.length)
      .map((project) => ({ experience, project }))
  ).filter(({ experience, project }) => !(experience.id === currentExperienceId && project.id === currentProjectId));
}

function renderOtherProjects() {
  const rail = elements.otherProjectsRail;
  if (!rail) return;
  const items = otherProjectItems();
  const span = Math.max(1, items.length - 1);
  rail.innerHTML = items.map(({ experience, project }, index) => {
    // one-by-one rise with a parabolic acceleration across the row
    const delay = Math.round(60 + 150 * Math.pow(index / span, 2));
    return `
    <button class="other-project" type="button" data-other-project="${project.id}" data-other-experience="${experience.id}" aria-label="查看 ${project.name}" style="--stagger: ${delay}ms">
      <img src="${project.cover}" srcset="${coverSrcset(project.cover)}" sizes="(max-width: 760px) 44vw, 190px" alt="" loading="lazy" decoding="async">
      <b>${project.name}</b>
      <em>${experience.company} · ${experience.period}</em>
    </button>`;
  }).join("");
}

/* Hovering a home card prefetches that project's first viewer page, so the
   card -> viewer handoff usually starts from a warm 2560px WebP instead of
   downloading it after the click. Only after the home page has loaded, so it
   never competes with the covers that are still arriving. */
let cardPrefetchTimer = 0;
elements.timeline.addEventListener("pointerover", (event) => {
  if (event.pointerType && event.pointerType !== "mouse") return;
  const card = event.target instanceof Element ? event.target.closest(".stream-project") : null;
  if (!card || document.readyState !== "complete") return;
  window.clearTimeout(cardPrefetchTimer);
  cardPrefetchTimer = window.setTimeout(() => {
    const project = experiences[card.dataset.homeExperience]?.projects.find((item) => item.id === card.dataset.homeProject);
    const first = project?.slides?.[0];
    if (first) warmSlideImage(first);
  }, 150);
});

function openOtherProject(experienceId, projectId, card) {
  const experience = experiences[experienceId];
  const project = experience?.projects.find((item) => item.id === projectId);
  if (!experience || !project || project.disabled) return;
  track("other_project_click", {
    from_project: state.projectId,
    from_experience: state.experienceId,
    from_page: state.slideIndex + 1,
    to_project: projectId,
    to_experience: experienceId
  });
  if (state.screen === "viewer") endViewerSession("other_project");
  const commit = () => {
    state.experienceId = experienceId;
    state.projectId = projectId;
    state.slideIndex = 0;
    state.viewerOrigin = "home";
    startViewerSession(project, experience, "other_project");
    renderViewer();
    updateViewerBackLabel();
    setActiveScreen("viewer");
    sizeArtworkFrame();
    pushRoute(`#project/${experienceId}/${projectId}`);
  };
  clearViewerExit();
  if (!(card instanceof Element) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    commit();
    return;
  }
  startViewerEntry(card, project, { hideDock: false });
  commit();
  runViewerEntry();
}

function renderViewer() {
  const experience = currentExperience();
  const project = currentProject();
  if (!experience || !project?.slides) return;

  elements.viewerCompany.textContent = `${experience.company} · ${experience.period}`;
  elements.viewerTitle.textContent = project.name;
  elements.totalCount.textContent = pad(project.slides.length);
  elements.fullscreenTotal.textContent = pad(project.slides.length);
  window.clearTimeout(lastSlideTimer);
  elements.viewerScreen.classList.remove("is-last-slide", "is-panel-adjusting");
  window.clearTimeout(panelAdjustTimer);
  elements.viewerScreen.style.setProperty("--stack-shift", "0px");
  renderOtherProjects();
  elements.thumbnailRail.innerHTML = project.slides.map((slide, index) => {
    const videoCount = slideVideoCount(slide);
    const badge = videoCount ? `<i class="thumbnail-play" aria-hidden="true">▶${videoCount > 1 ? videoCount : ""}</i>` : "";
    const label = `查看第 ${index + 1} 页${videoCount ? "（含视频）" : ""}`;
    const visual = `<img src="${slideThumb(slide)}" alt="" loading="lazy">`;
    return `
    <button class="thumbnail${index === state.slideIndex ? " is-current" : ""}" type="button" data-slide-index="${index}" role="option" aria-selected="${index === state.slideIndex}" tabindex="${index === state.slideIndex ? 0 : -1}" aria-label="${label}">
      ${visual}
      ${badge}
      <b>${pad(index + 1)}</b>
    </button>`;
  }).join("");
  showSlide(state.slideIndex, false, "initial");
  window.requestAnimationFrame(() => {
    updateRailMask();
    revealCurrentThumbnail("auto");
  });
}

const slideMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
let slideAnimToken = 0;
let slideAnimTimer = 0;

/* Loading veil: while a page bitmap is still being fetched/decoded the frame
   shows a blurred, slightly dimmed copy of whatever is underneath (rail thumb
   or the outgoing page) plus a spinner, so a slow 4K page never reads as a
   blank/upscaled placeholder. The veil only appears after a short delay so a
   cached page never flashes it, and once visible it stays up briefly before
   fading out (a 20ms blink at the threshold would read as a flicker). */
const ARTWORK_LOADER_DELAY = 220;
const ARTWORK_LOADER_MIN_VISIBLE = 300;
let artworkLoaderShowTimer = 0;
let artworkLoaderHideTimer = 0;
let artworkLoaderShownAt = 0;

function showArtworkLoading() {
  window.clearTimeout(artworkLoaderShowTimer);
  window.clearTimeout(artworkLoaderHideTimer);
  artworkLoaderShowTimer = window.setTimeout(() => {
    if (state.screen === "viewer" && elements.viewerScreen && !elements.viewerScreen.hidden) {
      artworkLoaderShownAt = performance.now();
      elements.loader.classList.add("is-active");
    }
  }, ARTWORK_LOADER_DELAY);
}

function hideArtworkLoading() {
  window.clearTimeout(artworkLoaderShowTimer);
  if (!elements.loader.classList.contains("is-active")) return;
  const remaining = ARTWORK_LOADER_MIN_VISIBLE - (performance.now() - artworkLoaderShownAt);
  if (remaining <= 0) {
    window.clearTimeout(artworkLoaderHideTimer);
    elements.loader.classList.remove("is-active");
    return;
  }
  window.clearTimeout(artworkLoaderHideTimer);
  artworkLoaderHideTimer = window.setTimeout(() => {
    elements.loader.classList.remove("is-active");
  }, remaining);
}

/* Immediate teardown for page swaps / leaving the viewer, where carrying a
   fade-out into the next transition would smear the blur across it. */
function clearArtworkLoading() {
  window.clearTimeout(artworkLoaderShowTimer);
  window.clearTimeout(artworkLoaderHideTimer);
  elements.loader.classList.remove("is-active");
}

function markArtworkReady() {
  elements.artwork.classList.remove("is-loading");
  hideArtworkLoading();
  elements.artworkFrame.style.backgroundImage = "";
  sizeArtworkFrame();
  finishArtworkLoad(true);
  warmViewerNeighbors();
  window.setTimeout(refreshArtworkResolution, 60);
}

function setArtworkPlaceholder(slide) {
  // Stack pages use the last layer as their rail thumb; the backdrop must
  // still match the layer actually on screen (the base layer on entry).
  const thumb = slideThumb(activeVisualSlide(slide));
  elements.artworkFrame.style.backgroundImage = thumb ? `url("${thumb}")` : "";
  // Inline these too: the later .artwork-frame shorthand resets them, and a
  // repeating 320×180 thumbnail looked like a wall of many images on refresh.
  elements.artworkFrame.style.backgroundSize = "cover";
  elements.artworkFrame.style.backgroundRepeat = "no-repeat";
  elements.artworkFrame.style.backgroundPosition = "center";
}

function placeArtwork(slide) {
  beginArtworkLoad(slide, "initial");
  elements.artwork.classList.add("is-loading");
  showArtworkLoading();
  setArtworkPlaceholder(slide);
  const ready = () => whenImageDecoded(elements.artwork, markArtworkReady);
  elements.artwork.onload = ready;
  elements.artwork.onerror = () => {
    finishArtworkLoad(false);
    markArtworkReady();
  };
  elements.artwork.src = pickSlideSource(slide);
  elements.artwork.alt = slide.alt || "";
  renderSlideLinks(slide);
  renderOverlays(slide);
  startSlideMedia(slide);
  if (elements.artwork.complete) ready();
}

/* ---- composite page media boxes -------------------------------------------
   Every box starts as a poster + play button. The <video> element is created
   on first click and its src is only attached then, so a page with three
   demos costs three small JPEGs until the visitor actually plays one. */

/* ---- composite page media ------------------------------------------------
   Each box starts as a poster + play button; the <video> element is created on
   first play and only then gets a src, so an idle video page costs just the
   poster JPEG. Playback uses the site's own control bar (play/pause, progress,
   mute) instead of the browser one: these frames are small and heavily scaled,
   and owning the bar keeps the muted hint bubble exactly on the mute button.
   Video pages autoplay muted (the only autoplay browsers allow) and hand over
   to the next demo on the same page, left to right. */

const MEDIA_ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill-rule="evenodd" clip-rule="evenodd" fill="currentColor" d="M4.5 5.653c0-1.427 1.529-2.33 2.779-1.643l11.54 6.347c1.295.712 1.295 2.573 0 3.286L7.279 20.99c-1.25.686-2.779-.217-2.779-1.643V5.653Z"></path></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M7.5 4.5c-.83 0-1.5.67-1.5 1.5v12c0 .83.67 1.5 1.5 1.5h1.2c.83 0 1.5-.67 1.5-1.5V6c0-.83-.67-1.5-1.5-1.5H7.5Zm7.8 0c-.83 0-1.5.67-1.5 1.5v12c0 .83.67 1.5 1.5 1.5h1.2c.83 0 1.5-.67 1.5-1.5V6c0-.83-.67-1.5-1.5-1.5h-1.2Z"></path></svg>',
  muted: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M11.55 4.24a.9.9 0 0 0-1.44-.72L6.1 6.9H4.5a1.5 1.5 0 0 0-1.5 1.5v7.2a1.5 1.5 0 0 0 1.5 1.5h1.6l4.01 3.38a.9.9 0 0 0 1.44-.72V4.24Zm3.98 5.23a.9.9 0 0 1 1.27 0L18.5 11.17l1.7-1.7a.9.9 0 1 1 1.27 1.27l-1.7 1.7 1.7 1.7a.9.9 0 0 1-1.27 1.27l-1.7-1.7-1.7 1.7a.9.9 0 0 1-1.27-1.27l1.7-1.7-1.7-1.7a.9.9 0 0 1 0-1.27Z"></path></svg>',
  sound: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M11.55 4.24a.9.9 0 0 0-1.44-.72L6.1 6.9H4.5a1.5 1.5 0 0 0-1.5 1.5v7.2a1.5 1.5 0 0 0 1.5 1.5h1.6l4.01 3.38a.9.9 0 0 0 1.44-.72V4.24Z"></path><path fill="currentColor" d="M15.1 8.4a5.4 5.4 0 0 1 0 7.2.9.9 0 0 0 1.34 1.2 7.2 7.2 0 0 0 0-9.6.9.9 0 1 0-1.34 1.2Z"></path><path fill="currentColor" d="M17.8 5.6a9 9 0 0 1 0 12.8.9.9 0 0 0 1.3 1.25 10.8 10.8 0 0 0 0-15.3.9.9 0 0 0-1.3 1.25Z"></path></svg>'
};

const mediaState = {
  slide: null,
  queue: [],
  soundOn: false,
  hintShown: false,
  idleTimer: 0
};

function resetMediaBoxes() {
  const canvas = elements.slideCanvas;
  if (!canvas) return;
  stopSlideMedia();
  canvas.querySelectorAll("video").forEach((video) => {
    try { video.pause(); } catch { /* ignore */ }
    video.removeAttribute("src");
    video.load();
  });
  canvas.innerHTML = "";
  canvas.hidden = true;
  canvas.style.opacity = "";
}

function pauseAllMedia() {
  elements.slideCanvas?.querySelectorAll("video").forEach((video) => {
    try { video.pause(); } catch { /* ignore */ }
  });
}

function mediaBoxes() {
  return [...(elements.slideCanvas?.querySelectorAll(".media-box") || [])];
}

function slideVideoOverlays(slide) {
  if (!isComposite(slide)) return [];
  return (slide.overlays || [])
    .filter((overlay) => overlay && overlay.kind === "video" && overlay.box)
    .sort((a, b) => a.box.x - b.box.x);
}

function startSlideMedia(slide) {
  stopSlideMedia();
  mediaState.hintShown = false;
  if (state.screen !== "viewer") return;
  const overlays = slideVideoOverlays(slide).filter((overlay) => overlay.autoplay !== false);
  if (!overlays.length) return;
  mediaState.slide = slide;
  mediaState.queue = overlays.slice();
  playNextSlideMedia();
}

function stopSlideMedia() {
  window.clearTimeout(mediaState.idleTimer);
  mediaState.slide = null;
  mediaState.queue = [];
  pauseAllMedia();
  mediaBoxes().forEach((box) => {
    box.dataset.playing = "false";
    box.classList.remove("is-loading", "is-playing");
    hideControls(box);
    hideSoundHint(box);
    box.querySelector(".media-play")?.classList.remove("is-hidden");
  });
}

function playNextSlideMedia() {
  const overlay = mediaState.queue.shift();
  if (!overlay) return;
  const box = elements.slideCanvas?.querySelector(`.media-box[data-media-id="${overlay.id}"]`);
  if (!box) {
    playNextSlideMedia();
    return;
  }
  startMedia(box, overlay, { auto: true });
}

function controlsMayHide(box) {
  const video = box.querySelector("video");
  // While a muted video still has an unmute button there is an action the
  // visitor needs, so the bar stays visible; silent recordings and unmuted
  // videos behave like a normal auto-hiding player. The hover check keeps the
  // bar available while the mouse rests on the frame.
  if (!video) return false;
  if (video.muted && box.querySelector(".media-mute")) return false;
  return !box.matches(":hover");
}

function showControls(box) {
  const bar = box.querySelector(".media-controls");
  if (!bar) return;
  bar.classList.add("is-visible");
  window.clearTimeout(box._controlsTimer);
  box._controlsTimer = window.setTimeout(() => {
    if (box.dataset.playing === "true" && controlsMayHide(box)) bar.classList.remove("is-visible");
  }, 2600);
}

function revealControls(box) {
  const bar = box.querySelector(".media-controls");
  if (!bar) return;
  bar.classList.add("is-visible");
  window.clearTimeout(box._controlsTimer);
  if (box.dataset.playing === "true") {
    box._controlsTimer = window.setTimeout(() => {
      if (controlsMayHide(box)) bar.classList.remove("is-visible");
    }, 2600);
  }
}

function hideControls(box) {
  window.clearTimeout(box._controlsTimer);
  box.querySelector(".media-controls")?.classList.remove("is-visible");
}

function hideSoundHint(box) {
  const hint = box?._soundHint;
  if (!hint) return;
  window.clearTimeout(hint._hideTimer);
  hint.classList.remove("is-visible");
}

/* The bubble lives on the slide canvas, not inside the media box: these frames
   can be narrower than the sentence, and the box clips its content. It is
   anchored from the box rectangle to the control bar's mute button so it lines
   up at every frame size. */
function showSoundHint(box) {
  const hint = box?._soundHint;
  const canvas = elements.slideCanvas;
  const mute = box?.querySelector(".media-mute");
  if (!hint || !canvas || !mute) return;
  // once per page is enough: a page with three demos should not flash the same
  // hint three times while they hand over to each other
  if (mediaState.hintShown) return;
  mediaState.hintShown = true;
  // Anchor from the real mute button rectangle (it is our own DOM), so the
  // bubble tail sits exactly on the icon at any frame size or bar padding.
  const canvasRect = canvas.getBoundingClientRect();
  const muteRect = mute.getBoundingClientRect();
  hint.style.right = `${canvasRect.right - muteRect.right}px`;
  hint.style.bottom = `${canvasRect.bottom - muteRect.top + 8}px`;
  hint.style.setProperty("--media-hint-tail", `${muteRect.width / 2 - 4.5}px`);
  window.clearTimeout(hint._hideTimer);
  window.requestAnimationFrame(() => hint.classList.add("is-visible"));
  hint._hideTimer = window.setTimeout(() => hint.classList.remove("is-visible"), 7000);
}

function updateMediaUi(box, video) {
  if (!video) return;
  const toggle = box.querySelector(".media-toggle");
  const mute = box.querySelector(".media-mute");
  const progress = box.querySelector(".media-progress");
  if (toggle) {
    const playing = !video.paused && !video.ended;
    toggle.innerHTML = playing ? MEDIA_ICON.pause : MEDIA_ICON.play;
    toggle.setAttribute("aria-label", playing ? "暂停" : "播放");
  }
  if (mute) {
    mute.innerHTML = video.muted ? MEDIA_ICON.muted : MEDIA_ICON.sound;
    mute.setAttribute("aria-label", video.muted ? "取消静音" : "静音");
  }
  if (progress && Number.isFinite(video.duration) && video.duration > 0) {
    const ratio = Math.min(1, video.currentTime / video.duration);
    progress.querySelector(".media-progress-fill").style.width = `${(ratio * 100).toFixed(2)}%`;
    progress.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
  }
}

function toggleMedia(box) {
  const video = box.querySelector("video");
  if (!video) return;
  if (video.paused) playMedia(box);
  else video.pause();
}

function toggleMute(box) {
  const video = box.querySelector("video");
  if (!video) return;
  video.muted = !video.muted;
  mediaState.soundOn = !video.muted;
  if (!video.muted) {
    video.volume = 1;
    // Some WebKit / WeChat builds keep an autoplay-muted video silent until a
    // play() call happens inside the same gesture, even while it is playing.
    if (!video.paused) video.play().catch(() => {});
    revealControls(box);
  }
}

function seekFromEvent(box, progress, event) {
  const video = box.querySelector("video");
  if (!video || !Number.isFinite(video.duration) || video.duration <= 0) return;
  const rect = progress.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  video.currentTime = ratio * video.duration;
  updateMediaUi(box, video);
}

function buildMediaControls(box, overlay) {
  const bar = document.createElement("div");
  bar.className = "media-controls";
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "视频控件");

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "media-toggle";
  toggle.innerHTML = MEDIA_ICON.play;
  toggle.setAttribute("aria-label", "播放");

  const progress = document.createElement("div");
  progress.className = "media-progress";
  progress.tabIndex = 0;
  progress.setAttribute("role", "slider");
  progress.setAttribute("aria-label", "播放进度");
  progress.setAttribute("aria-valuemin", "0");
  progress.setAttribute("aria-valuemax", "100");
  progress.setAttribute("aria-valuenow", "0");
  progress.innerHTML = '<span class="media-progress-fill"></span>';

  bar.append(toggle, progress);
  // silent screen recordings get no mute button (and no sound hint): there is
  // nothing to unmute, so the control bar only carries playback
  let mute = null;
  if (!overlay.silent) {
    mute = document.createElement("button");
    mute.type = "button";
    mute.className = "media-mute";
    mute.innerHTML = MEDIA_ICON.muted;
    mute.setAttribute("aria-label", "取消静音");
    bar.append(mute);
    mute.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleMute(box);
    });
  }

  box.append(bar);

  toggle.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleMedia(box);
  });
  progress.addEventListener("click", (event) => {
    event.stopPropagation();
    seekFromEvent(box, progress, event);
  });
  progress.addEventListener("keydown", (event) => {
    const video = box.querySelector("video");
    if (!video || !Number.isFinite(video.duration)) return;
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      video.currentTime = Math.min(video.duration, Math.max(0, video.currentTime + (event.key === "ArrowRight" ? 2 : -2)));
      updateMediaUi(box, video);
    }
  });
  bar.addEventListener("pointerdown", (event) => event.stopPropagation());
  bar.addEventListener("click", (event) => event.stopPropagation());

  // clicking the picture itself toggles playback once the demo has started;
  // a click on the (possibly hidden) bottom control strip just brings the bar
  // back, so tapping where the mute button lives never pauses the video first
  box.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest(".media-controls, .media-play")) return;
    const video = box.querySelector("video");
    if (!video) return;
    const rect = box.getBoundingClientRect();
    if (event.clientY >= rect.bottom - 56) {
      revealControls(box);
      return;
    }
    toggleMedia(box);
  });
  // keep the bar on screen while the pointer moves over the frame
  box.addEventListener("pointermove", () => {
    if (box.dataset.playing === "true") revealControls(box);
  });
  return bar;
}

/* One, short-lived loading indicator. A fast start never flashes a spinner, and
   buffering in the middle of playback no longer blinks one either — repeated
   spinners read as "several loadings". */
function setBoxLoading(box, on) {
  window.clearTimeout(box._loadingTimer);
  if (!on) {
    box.classList.remove("is-loading");
    return;
  }
  box._loadingTimer = window.setTimeout(() => box.classList.add("is-loading"), 220);
}

function bindMediaVideo(box, overlay, video) {
  video.addEventListener("playing", () => {
    const mediaKey = `${state.projectId || "none"}:${state.slideIndex}:${box.dataset.mediaId || "video"}`;
    if (!playedMedia.has(mediaKey)) {
      playedMedia.add(mediaKey);
      track("video_play", {
        project: state.projectId,
        page: state.slideIndex + 1,
        video_id: box.dataset.mediaId || "",
        label: overlay?.label || "",
        muted: Boolean(video.muted)
      });
    }
    setBoxLoading(box, false);
    box.dataset.playing = "true";
    box.classList.add("is-playing");
    box.querySelector(".media-play")?.classList.add("is-hidden");
    showControls(box);
    updateMediaUi(box, video);
    if (video.muted) showSoundHint(box);
    else hideSoundHint(box);
  });
  video.addEventListener("pause", () => {
    if (video.ended) return;
    box.classList.remove("is-loading");
    updateMediaUi(box, video);
    revealControls(box);
    hideSoundHint(box);
  });
  // only the very first load gets a spinner; mid-playback buffering stays quiet
  video.addEventListener("waiting", () => {
    if (box.dataset.playing !== "true") setBoxLoading(box, true);
  });
  video.addEventListener("timeupdate", () => updateMediaUi(box, video));
  video.addEventListener("loadedmetadata", () => updateMediaUi(box, video));
  video.addEventListener("durationchange", () => updateMediaUi(box, video));
  video.addEventListener("volumechange", () => {
    updateMediaUi(box, video);
    if (video.muted) {
      if (box.dataset.playing === "true") showSoundHint(box);
    } else {
      hideSoundHint(box);
    }
  });
  video.addEventListener("ended", () => {
    box.dataset.playing = "false";
    box.classList.remove("is-playing");
    setBoxLoading(box, false);
    hideControls(box);
    hideSoundHint(box);
    box.querySelector(".media-play")?.classList.remove("is-hidden");
    updateMediaUi(box, video);
    // hand over to the next demo on the page (left to right)
    if (mediaState.slide && mediaState.queue.length) playNextSlideMedia();
  });
}

function startMedia(box, overlay, options = {}) {
  const auto = Boolean(options.auto);
  if (!auto) mediaState.queue = [];
  mediaBoxes().forEach((other) => {
    if (other === box) return;
    const otherVideo = other.querySelector("video");
    if (!otherVideo) return;
    try { otherVideo.pause(); } catch { /* ignore */ }
    other.dataset.playing = "false";
    other.classList.remove("is-playing");
    hideControls(other);
    hideSoundHint(other);
    other.querySelector(".media-play")?.classList.remove("is-hidden");
  });
  setBoxLoading(box, true);
  // hide the big play affordance right away: the spinner is the only loading
  // indicator, otherwise the ▶ circle and the spinner stack on the same spot
  box.querySelector(".media-play")?.classList.add("is-hidden");
  let video = box.querySelector("video");
  if (!video) {
    video = document.createElement("video");
    video.className = "media-video";
    video.volume = 1;
    video.loop = Boolean(overlay.loop);
    video.playsInline = true;
    video.preload = "auto";
    video.setAttribute("playsinline", "");
    video.setAttribute("aria-label", overlay.label || "演示视频");
    if (overlay.poster) video.poster = overlay.poster;
    bindMediaVideo(box, overlay, video);
    box.append(video);
  }
  box.dataset.playing = "false";
  if (!video.src) video.src = overlay.src;
  if (video.readyState < 2) video.load();
  updateMediaUi(box, video);
  // muted first (autoplay policy); once the visitor has unmuted a demo, keep
  // their preference for the next one and fall back to muted if it is refused
  video.muted = auto || !mediaState.soundOn;
  const attempt = video.play();
  if (attempt?.catch) {
    attempt.catch(() => {
      if (!video.muted) {
        video.muted = true;
        video.play().catch(() => { /* ignore */ });
      }
      setBoxLoading(box, false);
      box.querySelector(".media-play")?.classList.remove("is-hidden");
    });
  }
}

function playMedia(box) {
  const video = box.querySelector("video");
  if (!video) return;
  const attempt = video.play();
  if (attempt?.catch) {
    attempt.catch(() => {
      video.muted = true;
      video.play().catch(() => { /* ignore */ });
    });
  }
}

// Pages can carry clickable hotspots that follow the bitmap exactly (percentage
// boxes, same coordinate system as composite overlays). They are rebuilt after
// every page change and cleared while a turn or layer fade is in flight.
function renderSlideLinks(slide) {
  const layer = elements.artworkLinks;
  if (!layer) return;
  layer.textContent = "";
  const links = slide?.links || [];
  links.forEach((link) => {
    const anchor = document.createElement("a");
    anchor.className = "artwork-link";
    anchor.href = link.href;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
    anchor.title = link.label || link.href;
    anchor.setAttribute("aria-label", link.label || `在新窗口打开 ${link.href}`);
    anchor.style.left = `${link.x}%`;
    anchor.style.top = `${link.y}%`;
    anchor.style.width = `${link.w}%`;
    anchor.style.height = `${link.h}%`;
    layer.append(anchor);
  });
}

function renderOverlays(slide) {
  const canvas = elements.slideCanvas;
  if (!canvas) return;
  resetMediaBoxes();
  if (!isComposite(slide)) return;
  const overlays = slide.overlays || [];
  if (!overlays.length) return;
  canvas.hidden = false;
  overlays.forEach((overlay) => {
    if (!overlay?.box) return;
    const box = document.createElement("div");
    box.className = "media-box";
    box.dataset.mediaId = overlay.id || "";
    box.style.left = `${overlay.box.x}%`;
    box.style.top = `${overlay.box.y}%`;
    box.style.width = `${overlay.box.w}%`;
    box.style.height = `${overlay.box.h}%`;
    box.style.setProperty("--media-radius", overlay.radius ?? 0);
    if (overlay.radiusCorners) {
      const corners = overlay.radiusCorners;
      box.style.setProperty("--media-radius-tl", corners.tl ?? overlay.radius ?? 0);
      box.style.setProperty("--media-radius-tr", corners.tr ?? overlay.radius ?? 0);
      box.style.setProperty("--media-radius-br", corners.br ?? overlay.radius ?? 0);
      box.style.setProperty("--media-radius-bl", corners.bl ?? overlay.radius ?? 0);
    }
    if (overlay.objectPosition) box.style.setProperty("--media-object-position", overlay.objectPosition);
    box.style.setProperty("--media-shadow", overlay.shadow ?? 0);
    if (overlay.z != null) box.style.zIndex = String(overlay.z);
    if (overlay.opacity != null) box.style.opacity = String(overlay.opacity);
    if (overlay.fit === "contain") box.classList.add("is-contain");
    if (overlay.kind === "image") {
      // static PNG layer (may carry transparency, e.g. a screenshot poured into
      // a device frame drawn on the PPT background); never intercepts clicks
      box.classList.add("is-image");
      const image = document.createElement("img");
      image.className = "media-image";
      image.src = overlay.src || "";
      image.alt = overlay.alt || overlay.label || "";
      image.decoding = "async";
      image.draggable = false;
      if (overlay.fit !== "cover") box.classList.add("is-contain");
      box.append(image);
      canvas.append(box);
      return;
    }
    if (overlay.kind !== "video") return;

    const poster = document.createElement("img");
    poster.className = "media-poster";
    poster.src = overlay.poster || "";
    poster.alt = "";
    poster.decoding = "async";
    poster.draggable = false;
    box.append(poster);

    const button = document.createElement("button");
    button.className = "media-play";
    button.type = "button";
    button.setAttribute("aria-label", `播放视频：${overlay.label || "页面演示"}`);
    button.innerHTML = `<span class="media-play-icon" aria-hidden="true">${MEDIA_ICON.play}</span>`;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      startMedia(box, overlay);
    });
    box.append(button);
    buildMediaControls(box, overlay);
    canvas.append(box);
    if (overlay.soundHint) {
      const hint = document.createElement("div");
      hint.className = "media-sound-hint";
      hint.setAttribute("role", "status");
      hint.textContent = overlay.soundHint;
      box._soundHint = hint;
      canvas.append(hint);
    }
  });
}


function resetArtworkLayers() {
  window.clearTimeout(slideAnimTimer);
  clearArtworkLoading();
  if (elements.artworkLinks) elements.artworkLinks.textContent = "";
  slideAnimToken += 1;
  const ghost = elements.artworkGhost;
  if (ghost) {
    ghost.style.transition = "none";
    ghost.style.transform = "";
    ghost.style.opacity = "";
    ghost.style.visibility = "hidden";
  }
  elements.artwork.style.transition = "none";
  elements.artwork.style.transform = "";
  elements.artwork.style.opacity = "";
  if (elements.slideCanvas) elements.slideCanvas.style.opacity = "";
  void elements.artwork.offsetWidth;
  elements.artwork.style.transition = "";
  elements.artwork.style.transform = "";
  elements.artwork.style.opacity = "";
}

/* Page turn: the outgoing page slides out while the next one slides in from
   the opposite edge (the damped vertical motion used by motion-led sites). */
function moveArtwork(slide, direction) {
  const ghost = elements.artworkGhost;
  if (!ghost || slideMotionQuery.matches) {
    resetArtworkLayers();
    placeArtwork(slide);
    return;
  }
  const previousSrc = elements.artwork.currentSrc || elements.artwork.src;
  resetArtworkLayers();
  resetMediaBoxes();
  if (!previousSrc) {
    placeArtwork(slide);
    return;
  }
  const token = slideAnimToken;
  ghost.src = previousSrc;
  ghost.alt = "";
  ghost.style.visibility = "visible";
  ghost.style.transform = "translateY(0)";
  elements.artwork.classList.remove("is-loading");
  showArtworkLoading();

  beginArtworkLoad(slide, "turn");
  const incoming = new Image();
  const incomingSrc = pickSlideSource(slide);
  const start = () => {
    finishArtworkLoad(true);
    if (token !== slideAnimToken) return;
    elements.artwork.onload = null;
    elements.artwork.onerror = null;
    elements.artwork.src = incomingSrc;
    elements.artwork.alt = slide.alt;
    elements.artwork.style.transform = `translateY(${direction > 0 ? 100 : -100}%) scale(1.02)`;
    sizeArtworkFrame();
    // Decode the image that will actually be displayed before starting the
    // slide; otherwise the incoming layer can be blank for a frame.
    whenImageDecoded(elements.artwork, () => {
      if (token !== slideAnimToken) return;
      warmViewerNeighbors();
      void elements.artwork.offsetWidth;
      const easing = "cubic-bezier(.76, 0, .24, 1)";
      const duration = 640;
      ghost.style.transition = `transform ${duration}ms ${easing}`;
      elements.artwork.style.transition = `transform ${duration}ms ${easing}`;
      window.requestAnimationFrame(() => {
        ghost.style.transform = `translateY(${direction > 0 ? -100 : 100}%)`;
        elements.artwork.style.transform = "translateY(0) scale(1)";
      });
      clearArtworkLoading();
      elements.artwork.classList.remove("is-loading");
      slideAnimTimer = window.setTimeout(() => {
        if (token !== slideAnimToken) return;
        ghost.style.visibility = "hidden";
        ghost.style.transition = "none";
        elements.artwork.style.transition = "";
        elements.artwork.style.transform = "";
        renderSlideLinks(slide);
        if (isComposite(slide)) {
          renderOverlays(slide);
          startSlideMedia(slide);
        }
        markArtworkReady();
      }, duration + 40);
    });
  };
  const startReady = () => whenImageDecoded(incoming, start);
  incoming.src = incomingSrc;
  if (incoming.complete && incoming.naturalWidth) startReady();
  else {
    incoming.onload = startReady;
    incoming.onerror = () => {
      finishArtworkLoad(false);
      start();
    };
  }
}

let thumbnailRevealTimer = 0;

// Center the active thumbnail without chasing every wheel event. Rapid page
// turns used to queue multiple smooth scrollIntoView() calls on the rail,
// which made it visibly bounce up and down while the next image was loading.
function revealCurrentThumbnail(behavior = "smooth") {
  const rail = elements.thumbnailRail;
  const active = rail?.querySelector(".thumbnail.is-current");
  if (!rail || !active || !rail.clientHeight) return;
  const horizontal = getComputedStyle(rail).flexDirection === "row";
  const railRect = rail.getBoundingClientRect();
  const thumbRect = active.getBoundingClientRect();
  const current = horizontal ? rail.scrollLeft : rail.scrollTop;
  const viewport = horizontal ? rail.clientWidth : rail.clientHeight;
  const size = horizontal ? thumbRect.width : thumbRect.height;
  const start = (horizontal ? thumbRect.left - railRect.left : thumbRect.top - railRect.top) + current;
  const max = Math.max(0, horizontal ? rail.scrollWidth - rail.clientWidth : rail.scrollHeight - rail.clientHeight);
  const target = Math.min(max, Math.max(0, start - (viewport - size) / 2));
  if (Math.abs(target - current) < 1) return;
  rail.scrollTo(horizontal ? { left: target, top: 0, behavior } : { left: 0, top: target, behavior });
}

function scheduleThumbnailReveal(delay = 160) {
  window.clearTimeout(thumbnailRevealTimer);
  thumbnailRevealTimer = window.setTimeout(() => revealCurrentThumbnail("smooth"), delay);
}

let stackStepLock = 0;

function animateStackStep(slide, nextIndex, direction) {
  const ghost = elements.artworkGhost;
  const targetLayer = slide.layers[nextIndex];
  const targetSrc = pickSlideSource(targetLayer);
  const token = ++slideAnimToken;
  window.clearTimeout(slideAnimTimer);
  elements.artwork.onload = null;
  elements.artwork.onerror = null;
  elements.artwork.classList.remove("is-loading");
  if (!ghost || slideMotionQuery.matches) {
    placeArtwork(targetLayer);
    return;
  }
  const easing = "cubic-bezier(.4, 0, .2, 1)";
  const duration = 480;
  // Layers cross-fade in place: the layer being left stays on top (ghost) and
  // dissolves out while the target layer is already decoded underneath, so
  // nothing moves on screen and no blank frame can appear between layers.
  const fromSrc = elements.artwork.currentSrc || elements.artwork.src;
  ghost.style.transition = "none";
  ghost.style.visibility = "visible";
  ghost.style.opacity = "1";
  ghost.style.transform = "translateY(0)";
  ghost.src = fromSrc;
  ghost.alt = "";
  elements.artwork.style.transition = "none";
  elements.artwork.style.transform = "";
  elements.artwork.src = targetSrc;
  elements.artwork.alt = targetLayer.alt || "";
  whenImageDecoded(elements.artwork, () => {
    if (token !== slideAnimToken) return;
    ghost.style.transition = `opacity ${duration}ms ${easing}`;
    window.requestAnimationFrame(() => {
      if (token !== slideAnimToken) return;
      ghost.style.opacity = "0";
    });
    slideAnimTimer = window.setTimeout(() => {
      if (token !== slideAnimToken) return;
      elements.artwork.style.transition = "";
      ghost.style.visibility = "hidden";
      ghost.style.transition = "none";
      ghost.style.opacity = "";
      ghost.style.transform = "";
      markArtworkReady();
    }, duration + 40);
  });
}

function stepStack(direction, via = "wheel") {
  const project = currentProject();
  const slide = project?.slides?.[state.slideIndex];
  if (!isStack(slide)) return false;
  const layers = slide.layers || [];
  const current = stackIndex(slide);
  const next = current + direction;
  if (next < 0 || next >= layers.length) return false;
  const now = performance.now();
  // consume repeated wheel ticks while one layer transition is in flight
  if (now < stackStepLock) return true;
  stackStepLock = now + 620;
  stackProgress.set(slide, next);
  track("stack_step", {
    project: state.projectId,
    page: state.slideIndex + 1,
    from_layer: current + 1,
    to_layer: next + 1,
    total_layers: layers.length,
    direction: direction,
    source: via
  });
  animateStackStep(slide, next, direction);
  return true;
}

function navigateViewer(direction, via = "wheel") {
  if (stepStack(direction, via)) return;
  showSlide(state.slideIndex + direction, true, via);
}

let lastSlideTimer = 0;

/* The bottom "other projects" panel changes the artwork frame size and lifts
   the stack. Open/close it in the same frame as the page turn so the panel,
   the frame resize and the slide are one continuous motion; deferring the
   resize until after the slide read as a stutter on the closing page. */
function scheduleLastSlide(wantsLast) {
  window.clearTimeout(lastSlideTimer);
  setLastSlide(wantsLast);
}

function showSlide(index, scrollThumbnail = true, via = "programmatic") {
  const project = currentProject();
  if (!project?.slides?.length) return;

  const previousIndex = state.slideIndex;
  const direction = index === state.slideIndex ? 0 : (index > state.slideIndex ? 1 : -1);
  state.slideIndex = (index + project.slides.length) % project.slides.length;
  const slide = project.slides[state.slideIndex];
  if (previousIndex !== state.slideIndex || via === "initial") trackViewerSlide(slide, via);
  if (isStack(slide)) {
    // Every entry into a merged page starts from its initial (base) layer,
    // whether the visitor arrived by scrolling down or up.
    stackProgress.set(slide, 0);
    stackStepLock = 0;
  }
  elements.currentCount.textContent = pad(state.slideIndex + 1);
  elements.fullscreenCurrent.textContent = pad(state.slideIndex + 1);
  const panelFromIndex = project.slides.length - 1;
  scheduleLastSlide(state.slideIndex >= panelFromIndex);

  if (direction === 0) {
    resetArtworkLayers();
    placeArtwork(slide);
  } else {
    moveArtwork(slide, direction);
  }

  const thumbnails = [...elements.thumbnailRail.querySelectorAll(".thumbnail")];
  thumbnails.forEach((thumbnail, thumbnailIndex) => {
    const isCurrent = thumbnailIndex === state.slideIndex;
    thumbnail.classList.toggle("is-current", isCurrent);
    thumbnail.setAttribute("aria-selected", String(isCurrent));
    thumbnail.tabIndex = isCurrent ? 0 : -1;
  });

  const activeThumbnail = thumbnails[state.slideIndex];
  if (scrollThumbnail && activeThumbnail) scheduleThumbnailReveal();
  if (document.activeElement?.closest(".thumbnail-rail") && activeThumbnail) activeThumbnail.focus({ preventScroll: true });

  warmSlideImage(project.slides[state.slideIndex]);
}

const screenHeadings = {
  home: "#home-title",
  projects: "#projects-title",
  viewer: "#viewer-title"
};
let routeHydrated = false;

function focusScreenHeading(screenName) {
  const heading = document.querySelector(screenHeadings[screenName] || "");
  if (heading) heading.focus({ preventScroll: true });
}

function setActiveScreen(screenName) {
  const changed = state.screen !== screenName;
  const previousScreen = state.screen;
  if (changed) {
    if (previousScreen === "viewer") endViewerSession(viewerExitReason || "navigate");
    if (previousScreen === "home") endHomeEngagement();
    viewerExitReason = "";
    setContactCard(false, false, "screen_change");
  }
  if (screenName !== "viewer") {
    clearViewerEntry();
    clearFullscreenMorph();
    resetMediaBoxes();
    clearArtworkLoading();
  }
  if (screenName !== "viewer") window.clearTimeout(lastSlideTimer);
  if (screenName !== "viewer" && isViewerFullscreen()) {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    elements.viewerScreen.classList.remove("is-pseudo-fullscreen");
    syncFullscreenUI();
  }
  if (screenName !== "home") {
    resetHoverReveal();
    resetAccordionShift();
  }
  state.screen = screenName;
  document.body.dataset.screen = screenName;
  if (changed) {
    analytics?.setScreen?.(screenName, {
      from: previousScreen,
      project: state.projectId || null,
      experience: state.experienceId || null
    });
    if (screenName === "home") startHomeEngagement();
  }
  if (changed && routeHydrated) window.requestAnimationFrame(() => focusScreenHeading(screenName));
  elements.screens.forEach((screen) => {
    const active = screen.dataset.screen === screenName;
    if (active) {
      screen.hidden = false;
      screen.scrollTop = 0;
    }
    screen.classList.toggle("is-active", active);
    if (!active) {
      // Initial deep-link render has no cross-screen transition to protect;
      // hiding immediately prevents the home card grid from painting behind
      // the viewer while its entry transition is still running.
      if (!routeHydrated) screen.hidden = true;
      else window.setTimeout(() => { if (!screen.classList.contains("is-active")) screen.hidden = true; }, 430);
    }
  });
}

function pushRoute(hash) {
  if (location.hash === hash) return;
  history.pushState(null, "", hash);
}

function updateViewerBackLabel() {
  if (!elements.viewerBackLabel) return;
  const label = state.viewerOrigin === "projects" ? "返回项目" : "返回首页";
  elements.viewerBackLabel.textContent = label;
  document.querySelector("[data-viewer-back]")?.setAttribute("aria-label", label);
}

function goHome(updateHash = true) {
  state.experienceId = null;
  state.projectId = null;
  state.slideIndex = 0;
  state.viewerOrigin = "home";
  setActiveScreen("home");
  scheduleStreamMeasure(520);
  if (updateHash) pushRoute("#home");
}

let viewerExit = null;

function clearViewerExit() {
  if (!viewerExit) return;
  viewerExit.animation?.cancel();
  viewerExit.overlay.remove();
  viewerExit.card?.classList.remove("is-returning");
  elements.homeScreen.classList.remove("is-scene-revealing");
  elements.viewerScreen.classList.remove("is-scene-shrinking", "is-dock-hidden");
  viewerExit = null;
}

/* Reverse of the card-to-viewer entrance: the artwork shrinks back into the
   home card while the page underneath swaps back to home. */
function startViewerExit() {
  if (viewerExit) return true;
  if (state.screen !== "viewer" || isViewerFullscreen()) return false;
  if (state.viewerOrigin === "projects") return false;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  const experienceId = state.experienceId;
  const projectId = state.projectId;
  if (!experienceId || !projectId) return false;
  const card = document.querySelector(`[data-home-project="${projectId}"][data-home-experience="${experienceId}"]`);
  const artwork = elements.artwork;
  const pageSource = artwork.currentSrc || artwork.src;
  if (!card || !pageSource) return false;
  if (stream.dirty && !elements.homeScreen.hidden) measureStream();
  const cardItem = stream.cards.find((item) => item.element === card);
  if (!cardItem) return false;
  const cardLeft = cardItem.center - cardItem.width / 2 - stream.current;
  const cardRight = cardItem.center + cardItem.width / 2 - stream.current;
  const visible = Math.min(cardRight, stream.viewport) - Math.max(cardLeft, 0);
  if (visible < cardItem.width * 0.5) return false;

  // release hover and pin the cover's resting look before cloning it, so the
  // clone copies the same appearance the card will have at handoff
  card.classList.add("is-returning");
  const coverImage = card.querySelector("img");
  const coverSource = coverImage?.currentSrc || coverImage?.src;
  const frame = elements.artworkFrame.getBoundingClientRect();
  clearViewerEntry();

  const overlay = document.createElement("div");
  overlay.className = "viewer-entry";
  overlay.setAttribute("aria-hidden", "true");
  const page = document.createElement("img");
  page.className = "viewer-entry-page";
  page.alt = "";
  page.src = pageSource;
  const cover = document.createElement("img");
  cover.className = "viewer-entry-cover";
  cover.alt = "";
  if (coverSource) cover.src = coverSource;
  if (coverImage) {
    const style = window.getComputedStyle(coverImage);
    cover.style.filter = style.filter;
    cover.style.transform = style.transform;
  }
  overlay.append(page, cover);
  overlay.classList.add("is-exiting");
  overlay.style.left = `${frame.left}px`;
  overlay.style.top = `${frame.top}px`;
  overlay.style.width = `${frame.width}px`;
  overlay.style.height = `${frame.height}px`;
  overlay.style.borderRadius = "0px";
  document.body.appendChild(overlay);

  elements.viewerScreen.classList.add("is-scene-shrinking", "is-dock-hidden");
  elements.homeScreen.classList.add("is-scene-revealing");
  const entry = { overlay, animation: null, card };
  viewerExit = entry;
  goHome(false);
  history.replaceState(null, "", "#home");

  window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
    if (!overlay.isConnected) return;
    // the home screen is display:none while the viewer is open, so computed
    // transforms on the card read as "none" before goHome; copy the cover's
    // real transform/filter now that home is visible, otherwise the clone's
    // cover is unzoomed and pops when the real card appears at handoff
    if (coverImage) {
      const coverStyle = window.getComputedStyle(coverImage);
      cover.style.transform = coverStyle.transform;
      cover.style.filter = coverStyle.filter;
    }
    // target the card's default (non-hover) rectangle; the .is-returning class
    // has already released any hover lift with the normal 0.7s transition, so
    // the clone lands where the card will settle (no snap on handoff)
    const computed = window.getComputedStyle(card);
    const matrix = computed.transform === "none" ? new DOMMatrix() : new DOMMatrixReadOnly(computed.transform);
    const rect = card.getBoundingClientRect();
    const target = {
      left: rect.left - (matrix.m41 || 0),
      top: rect.top - (matrix.m42 || 0),
      width: rect.width,
      height: rect.height
    };
    const radius = computed.borderRadius || "0px";
    const animation = overlay.animate([
      { left: `${frame.left}px`, top: `${frame.top}px`, width: `${frame.width}px`, height: `${frame.height}px`, borderRadius: "0px" },
      { left: `${target.left}px`, top: `${target.top}px`, width: `${target.width}px`, height: `${target.height}px`, borderRadius: radius }
    ], { duration: 660, easing: "cubic-bezier(.66, 0, .2, 1)", fill: "forwards" });
    entry.animation = animation;
    animation.onfinish = () => {
      // only after the artwork has shrunk to card size, softly dissolve it
      // back into the card cover, then hand off to the home screen
      overlay.classList.add("is-remorphing");
      window.setTimeout(() => {
        overlay.classList.add("is-fading");
        window.setTimeout(() => {
          overlay.remove();
          card.classList.remove("is-returning");
          elements.homeScreen.classList.remove("is-scene-revealing");
          elements.viewerScreen.classList.remove("is-scene-shrinking", "is-dock-hidden");
          if (viewerExit === entry) viewerExit = null;
        }, 180);
      }, 200);
    };
  }));
  return true;
}

function leaveViewer(reason = "back") {
  viewerExitReason = reason;
  if (startViewerExit()) return;
  if (state.viewerOrigin === "projects" && state.experienceId && state.screen === "viewer") {
    elements.viewerScreen.classList.add("is-dock-hidden");
    window.setTimeout(() => history.back(), 260);
    return;
  }
  goHome(false);
  history.replaceState(null, "", "#home");
}

function openExperience(experienceId, updateHash = true) {
  if (!experiences[experienceId]) return;
  track("experience_open", {
    experience: experienceId,
    company: experiences[experienceId].company,
    from: state.screen,
    mode: currentViewportMode()
  });
  state.experienceId = experienceId;
  state.projectId = null;
  state.slideIndex = 0;
  renderProjects();
  setActiveScreen("projects");
  if (updateHash) pushRoute(`#experience/${experienceId}`);
}

function openProject(projectId, updateHash = true, source = "direct") {
  const project = currentExperience()?.projects.find((item) => item.id === projectId);
  if (!project || project.disabled) return;
  if (state.screen === "viewer") endViewerSession("switch_project");
  clearViewerExit();
  state.viewerOrigin = state.screen === "projects" ? "projects" : "home";
  state.projectId = projectId;
  state.slideIndex = 0;
  startViewerSession(project, currentExperience(), source);
  renderViewer();
  updateViewerBackLabel();
  setActiveScreen("viewer");
  sizeArtworkFrame();
  if (!elements.viewerScreen.classList.contains("is-dock-hidden")) {
    elements.viewerScreen.classList.add("is-dock-hidden");
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      if (state.screen === "viewer") elements.viewerScreen.classList.remove("is-dock-hidden");
    }));
  }
  if (updateHash) pushRoute(`#project/${state.experienceId}/${projectId}`);
}

let viewerEntry = null;

function clearViewerEntry() {
  if (!viewerEntry) return;
  viewerEntry.animation?.cancel();
  viewerEntry.overlay.remove();
  viewerEntry.screen?.classList.remove("is-scene-entering", "is-dock-hidden");
  viewerEntry = null;
}

/* The clicked home card expands into the viewer stage: the card cover is
   cloned into a fixed overlay that flips to the artwork frame, then the
   overlay dissolves into the first page while the viewer chrome settles. */
function startViewerEntry(card, project, options = {}) {
  if (!(card instanceof Element)) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  clearViewerExit();
  clearViewerEntry();
  const image = card.querySelector("img");
  const coverSource = image?.currentSrc || image?.src;
  const pageSource = project?.slides?.[0] ? pickSlideSource(project.slides[0]) : "";
  const start = card.getBoundingClientRect();
  const overlay = document.createElement("div");
  overlay.className = "viewer-entry";
  overlay.setAttribute("aria-hidden", "true");
  const cover = document.createElement("img");
  cover.className = "viewer-entry-cover";
  cover.alt = "";
  if (coverSource) cover.src = coverSource;
  const page = document.createElement("img");
  page.className = "viewer-entry-page";
  page.alt = "";
  if (pageSource) page.src = pageSource;
  overlay.append(cover, page);
  if (pageSource) {
    const fullPage = new Image();
    fullPage.src = pageSource;
    fullPage.onload = () => {
      if (overlay.isConnected) page.src = pageSource;
    };
  }
  overlay.style.left = `${start.left}px`;
  overlay.style.top = `${start.top}px`;
  overlay.style.width = `${start.width}px`;
  overlay.style.height = `${start.height}px`;
  document.body.appendChild(overlay);
  const viewerScreen = elements.screens.find((screen) => screen.dataset.screen === "viewer");
  viewerScreen?.classList.add("is-scene-entering");
  if (options.hideDock !== false) viewerScreen?.classList.add("is-dock-hidden");
  viewerEntry = { overlay, animation: null, screen: viewerScreen, pageImage: page };

  // swap the card cover for the first page early, while the layer is still
  // close to card size, so the large artwork never cross-fades at full size
  const morph = () => {
    if (overlay.isConnected) overlay.classList.add("is-morphing");
  };
  if (page.complete && page.naturalWidth) window.requestAnimationFrame(morph);
  else {
    page.addEventListener("load", () => window.requestAnimationFrame(morph), { once: true });
    page.addEventListener("error", () => window.requestAnimationFrame(morph), { once: true });
  }
}

function runViewerEntry() {
  const entry = viewerEntry;
  if (!entry) return;
  const { overlay } = entry;
  const start = overlay.style;
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
    if (!overlay.isConnected || viewerEntry !== entry) return;
    sizeArtworkFrame();
    const end = elements.artworkFrame.getBoundingClientRect();
    const animation = overlay.animate([
      { left: start.left, top: start.top, width: start.width, height: start.height, borderRadius: "20px" },
      { left: `${end.left}px`, top: `${end.top}px`, width: `${end.width}px`, height: `${end.height}px`, borderRadius: "0px" }
    ], { duration: 660, easing: "cubic-bezier(.66, 0, .2, 1)", fill: "forwards" });
    entry.animation = animation;
    animation.onfinish = () => {
      if (!overlay.isConnected) return;
      // the rail slides in with the expansion, not with the (possibly slow)
      // full-resolution artwork load
      entry.screen?.classList.remove("is-dock-hidden");
      const handoff = () => {
        overlay.remove();
        entry.screen?.classList.remove("is-scene-entering", "is-dock-hidden");
        if (viewerEntry === entry) viewerEntry = null;
      };
      const page = entry.pageImage;
      const artwork = elements.artwork;
      const handoffWhenReady = () => {
        if (page && artwork.currentSrc) page.src = artwork.currentSrc;
        window.setTimeout(handoff, 230);
      };
      if ((!page || (page.complete && page.naturalWidth)) && artwork.complete && artwork.naturalWidth) {
        handoffWhenReady();
        return;
      }
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        handoffWhenReady();
      };
      artwork.addEventListener("load", finish, { once: true });
      artwork.addEventListener("error", finish, { once: true });
      if (page) {
        page.addEventListener("load", finish, { once: true });
        page.addEventListener("error", finish, { once: true });
      }
      window.setTimeout(finish, 6000);
    };
  }));
}

function openHomeProject(experienceId, projectId, card) {
  const experience = experiences[experienceId];
  const project = experience?.projects.find((item) => item.id === projectId);
  if (!experience || !project) return;
  trackCardClick(experience, project, "home");
  if (project.disabled) {
    openExperience(experienceId);
    return;
  }
  state.experienceId = experienceId;
  startViewerEntry(card, project);
  openProject(projectId, true, "home");
  runViewerEntry();
}

function handleRoute() {
  if (state.screen === "viewer") viewerExitReason = "route";
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "project" && parts[1] && parts[2]) {
    const experience = experiences[parts[1]];
    const project = experience?.projects.find((item) => item.id === parts[2]);
    if (!experience || !project || project.disabled) {
      if (experience) {
        openExperience(parts[1], false);
        history.replaceState(null, "", `#experience/${parts[1]}`);
      } else {
        goHome(false);
        history.replaceState(null, "", "#home");
      }
      return;
    }
    state.experienceId = parts[1];
    openProject(parts[2], false);
  } else if (parts[0] === "experience" && parts[1] && experiences[parts[1]]) {
    openExperience(parts[1], false);
  } else {
    goHome(false);
    if (location.hash && location.hash !== "#home") history.replaceState(null, "", "#home");
  }
}

document.addEventListener("click", (event) => {
  const homeTrigger = event.target.closest('[data-route="home"]');
  const homeProjectTrigger = event.target.closest("[data-home-project]");
  const projectTrigger = event.target.closest("[data-project]");
  const thumbnailTrigger = event.target.closest("[data-slide-index]");
  const viewerBack = event.target.closest("[data-viewer-back]");
  const fullscreenTrigger = event.target.closest("[data-fullscreen-toggle]");
  const otherProjectTrigger = event.target.closest("[data-other-project]");

  if (homeTrigger) {
    if (state.screen === "viewer") viewerExitReason = "brand_home";
    goHome();
  } else if (homeProjectTrigger) openHomeProject(homeProjectTrigger.dataset.homeExperience, homeProjectTrigger.dataset.homeProject, homeProjectTrigger);
  else if (projectTrigger) {
    const experience = currentExperience();
    const project = experience?.projects.find((item) => item.id === projectTrigger.dataset.project);
    trackCardClick(experience, project, "projects");
    openProject(projectTrigger.dataset.project, true, "projects");
  }
  else if (thumbnailTrigger) showSlide(Number(thumbnailTrigger.dataset.slideIndex), true, "thumbnail");
  else if (otherProjectTrigger) openOtherProject(otherProjectTrigger.dataset.otherExperience, otherProjectTrigger.dataset.otherProject, otherProjectTrigger);
  else if (fullscreenTrigger) toggleViewerFullscreen();
  else if (viewerBack) leaveViewer("back");
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && contactCard.classList.contains("is-open")) {
    setContactCard(false, true);
    return;
  }
  if (contactCard.classList.contains("is-open")) return;
  if (state.screen === "home") {
    if (event.key === "ArrowRight" || event.key === "PageDown") nudgeStream(1);
    if (event.key === "ArrowLeft" || event.key === "PageUp") nudgeStream(-1);
    if (event.key === "Home") jumpStream(0);
    if (event.key === "End") jumpStream(1);
  }
  if (state.screen === "viewer") {
    if (event.key === "ArrowDown" || event.key === "PageDown") navigateViewer(1, "keyboard");
    if (event.key === "ArrowUp" || event.key === "PageUp") navigateViewer(-1, "keyboard");
    if (event.key === "Escape") {
      if (isViewerFullscreen()) {
        beginFullscreenMorph();
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else exitPseudoFullscreen();
        return;
      }
      if (performance.now() - fullscreenExitAt < 400) return;
      leaveViewer("esc");
    }
  }
});

let swipeStartY = null;
// Media boxes own their pointer gestures (video controls, the big play button,
// clicking the picture to pause). Recording their pointerdown would otherwise
// leave a stale row and the following pointerup could be read as a page swipe.
elements.artworkFrame.addEventListener("pointerdown", (event) => {
  swipeStartY = event.target instanceof Element && event.target.closest(".media-box") ? null : event.clientY;
}, true);
elements.artworkFrame.addEventListener("pointerup", (event) => {
  if (swipeStartY == null) return;
  const distance = swipeStartY - event.clientY;
  swipeStartY = null;
  if (Math.abs(distance) > 60) navigateViewer(distance > 0 ? 1 : -1, "swipe");
});
elements.artworkFrame.addEventListener("pointercancel", () => { swipeStartY = null; });

const viewerElement = elements.screens.find((screen) => screen.dataset.screen === "viewer");
let viewerWheelDelta = 0;
let viewerWheelLock = 0;
let viewerWheelTimer = 0;
viewerElement.addEventListener("wheel", (event) => {
  if (state.screen !== "viewer") return;
  if (event.ctrlKey || event.metaKey) return;
  if (event.target.closest(".thumbnail-rail") || event.target.closest(".other-projects")) return;
  event.preventDefault();
  const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * window.innerHeight : event.deltaY;
  viewerWheelDelta += delta;
  window.clearTimeout(viewerWheelTimer);
  viewerWheelTimer = window.setTimeout(() => { viewerWheelDelta = 0; }, 200);
  const now = performance.now();
  if (now < viewerWheelLock || Math.abs(viewerWheelDelta) < 24) return;
  const direction = Math.sign(viewerWheelDelta);
  viewerWheelDelta = 0;
  viewerWheelLock = now + 230;
  navigateViewer(direction, "wheel");
}, { passive: false });

window.addEventListener("popstate", handleRoute);
window.addEventListener("hashchange", handleRoute);

// Capture phase: analytics.js also listens for pagehide (bubble) to flush its
// beacon, so the closing viewer/home events have to be queued before that.
window.addEventListener("pagehide", () => {
  endViewerSession("page_hide");
  endHomeEngagement();
  analytics?.flush?.("pagehide");
}, true);

if (window.matchMedia("(pointer: fine)").matches) {
  window.addEventListener("pointermove", (event) => {
    const shift = ((event.clientX / window.innerWidth) - 0.5) * 14;
    document.documentElement.style.setProperty("--pointer-shift", `${shift}px`);
  });
}

/* ── Horizontal work stream ─────────────────────────────────────────────
   Wheel and drag write to a virtual offset that is damped toward its target
   on every frame (the interaction model used by motion-led portfolios),
   instead of scrolling the element natively. Native scroll has no inertia:
   the page jumps by the exact wheel delta and drag is a rigid 1:1 mapping.
   ─────────────────────────────────────────────────────────────────────── */
const stream = {
  target: 0,
  current: 0,
  max: 0,
  origin: 0,
  viewport: 1,
  cards: [],
  raf: 0,
  lastFrame: 0,
  dirty: true,
  dragging: false,
  shift: 0,
  accordion: false,
  accordionCard: null
};

const STREAM_LERP = 0.085;
const STREAM_DRAG_SENSITIVITY = 1.15;
const STREAM_DRAG_THRESHOLD = 5;
const reduceMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

const clampStream = (value) => Math.min(Math.max(value, 0), stream.max);

const STREAM_COVER_RATIO = 16 / 9;

function measureStreamAccordion() {
  elements.timeline.querySelectorAll(".group-projects").forEach((group) => {
    const card = group.querySelector(".stream-project");
    if (!card) return;
    const height = card.getBoundingClientRect().height;
    if (height > 0) {
      group.style.setProperty("--expanded-card-width", `${(height * STREAM_COVER_RATIO).toFixed(2)}px`);
    }
  });
}

function measureStream() {
  measureStreamAccordion();
  const shell = elements.streamShell;
  if (!shell.offsetWidth) {
    stream.dirty = true;
    return;
  }
  const trackRect = elements.timeline.getBoundingClientRect();
  stream.viewport = shell.clientWidth || window.innerWidth || 1;
  // Track-local coordinate of the shell's content origin (the shell's left
  // padding): viewport position = track position + origin - current offset.
  stream.origin = trackRect.left + stream.current;
  stream.max = Math.max(0, shell.scrollWidth - shell.clientWidth);
  stream.cards = [...elements.timeline.querySelectorAll(".stream-project")].map((element) => {
    const rect = element.getBoundingClientRect();
    return { element, center: rect.left + rect.width / 2 - trackRect.left, width: rect.width };
  });
  stream.dirty = false;
}

function applyStream() {
  // Snap the track to whole device pixels. A fractional translate makes the
  // compositor resample the whole row every frame, so the 1px seams between
  // cover cards shimmer while the row animates (worst during the hover
  // accordion). Whole-device-pixel steps keep every edge on a stable phase.
  const density = window.devicePixelRatio || 1;
  const offset = Math.round((stream.current + stream.shift) * density) / density;
  elements.timeline.style.transform = `translate3d(${-offset}px, 0, 0)`;
  const progress = stream.max > 0 ? stream.current / stream.max : 0;
  elements.streamProgress.style.transform = `scaleX(${Math.max(0.08, progress).toFixed(4)})`;
}

/* Center-anchored opening: the hovered card grows by `growth` while everything
   before it has to move left by half of that and everything after it right by
   half, which is a single translate of the whole track. Reading the live widths
   every frame keeps this offset exactly in step with the CSS flex-basis
   transition (and with any interruption), so nothing jumps. `growth` is the sum
   of all widening, which stays constant when the hover moves from one card to
   the next because one card opens while the other closes. */
const SHELL_GUTTER = () => parseFloat(getComputedStyle(elements.streamShell).paddingLeft) || 0;

function updateAccordionShift() {
  const cards = [...elements.timeline.querySelectorAll(".stream-project")];
  if (!cards.length) {
    stream.shift = 0;
    return;
  }
  const widths = cards.map((card) => card.getBoundingClientRect().width);
  const resting = Math.min(...widths);
  let growth = 0;
  widths.forEach((width) => { growth += Math.max(0, width - resting); });
  // Open around the card's own centre: the row shifts by half the widening, so
  // the neighbours are pushed apart on both sides. Near a viewport edge the card
  // is simply allowed to be clipped — there is no extra pan or slide after the
  // width transition, so nothing else gets dragged across the screen.
  let shift = growth / 2;
  const item = stream.accordionCard && stream.cards.find((entry) => entry.element === stream.accordionCard);
  if (item && shift > 0) {
    const gutter = SHELL_GUTTER();
    const left = item.center - item.width / 2 + stream.origin - stream.current;
    // the first card has no room on its left: open to the right instead
    shift = Math.min(shift, Math.max(0, left - gutter));
    // never pull blank space in from the end of the track
    const blankRoom = elements.streamShell.scrollWidth - stream.current - stream.viewport;
    if (blankRoom > 0) shift = Math.min(shift, blankRoom);
    shift = Math.max(0, shift);
  }
  stream.shift = shift;
}

function trackAccordion(card) {
  stream.accordionCard = card;
  stream.accordion = true;
  window.clearTimeout(trackAccordion.timer);
  trackAccordion.timer = window.setTimeout(() => {
    stream.accordion = false;
    stream.accordionCard = null;
  }, 800);
  runStream();
}

function streamFrame(time) {
  if (stream.dirty) measureStream();
  const shell = elements.streamShell;
  if (!stream.lastFrame) stream.lastFrame = time;
  const delta = Math.min(64, time - stream.lastFrame);
  stream.lastFrame = time;
  const factor = reduceMotionQuery.matches ? 1 : 1 - Math.exp(Math.log(1 - STREAM_LERP) * (delta / (1000 / 60)));
  // While an open row collapses the content narrows frame by frame; clamp the
  // target to that live bound instead of snapping to the resting max later,
  // otherwise the focused card would jump sideways when the pointer leaves.
  if (stream.target > stream.max) {
    const liveMax = Math.max(stream.max, shell.scrollWidth - shell.clientWidth);
    if (stream.target > liveMax) stream.target = liveMax;
  }
  stream.current += (stream.target - stream.current) * factor;
  if (Math.abs(stream.target - stream.current) < 0.1) stream.current = stream.target;
  if (stream.accordion) updateAccordionShift();
  applyStream();
  if (state.screen === "home" && stream.max > 0) {
    const progress = stream.current / stream.max;
    if (progress > homeEngagement.maxProgress) homeEngagement.maxProgress = progress;
    [0.25, 0.5, 0.75, 1].forEach((bucket) => {
      if (progress < bucket || homeEngagement.buckets.has(bucket)) return;
      homeEngagement.buckets.add(bucket);
      track("stream_scroll", { bucket: Math.round(bucket * 100), progress: Math.round(progress * 100) });
    });
  }
  if (stream.current === stream.target && !stream.dragging && !stream.accordion) {
    stream.raf = 0;
    stream.lastFrame = 0;
    scheduleImpressionCheck(160);
    return;
  }
  stream.raf = requestAnimationFrame(streamFrame);
}

function runStream() {
  if (stream.raf) return;
  stream.lastFrame = 0;
  stream.raf = requestAnimationFrame(streamFrame);
}

elements.streamShell.addEventListener("wheel", (event) => {
  if (event.ctrlKey || event.metaKey || state.screen !== "home") return;
  event.preventDefault();
  if (stream.dirty) measureStream();
  const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
  let delta = horizontal ? event.deltaX : event.deltaY;
  if (event.deltaMode === 1) delta *= 16;
  else if (event.deltaMode === 2) delta *= stream.viewport;
  stream.target = clampStream(stream.target + delta);
  runStream();
}, { passive: false });

let streamDrag = null;
let suppressStreamClick = false;

elements.streamShell.addEventListener("pointerdown", (event) => {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  if (stream.dirty) measureStream();
  streamDrag = { id: event.pointerId, x: event.clientX, target: stream.target, moved: false };
  stream.dragging = true;
});

window.addEventListener("pointermove", (event) => {
  if (!streamDrag || event.pointerId !== streamDrag.id) return;
  const distance = event.clientX - streamDrag.x;
  if (!streamDrag.moved && Math.abs(distance) > STREAM_DRAG_THRESHOLD) {
    streamDrag.moved = true;
    // a drag suspends the hover accordion: drop the expanded state (and its
    // dimming) so the row does not change width while the user is panning it
    const expanded = elements.timeline.querySelector(".stream-project.is-expanded");
    resetHoverReveal();
    if (expanded) trackAccordion(expanded);
    elements.streamShell.classList.add("is-dragging");
  }
  if (!streamDrag.moved || !stream.max) return;
  stream.target = clampStream(streamDrag.target - distance * STREAM_DRAG_SENSITIVITY);
  runStream();
});

function endStreamDrag(event) {
  if (!streamDrag || (event && event.pointerId !== streamDrag.id)) return;
  const dragged = streamDrag.moved;
  if (dragged) {
    homeEngagement.drags += 1;
    suppressStreamClick = true;
    window.setTimeout(() => { suppressStreamClick = false; }, 400);
  }
  streamDrag = null;
  stream.dragging = false;
  elements.streamShell.classList.remove("is-dragging");
  if (dragged) {
    // a drag suspends the hover accordion; after releasing, re-arm it for the
    // card that happens to be under the pointer (there is no pointerover then)
    const expanded = elements.timeline.querySelector(".stream-project.is-expanded");
    resetHoverReveal();
    if (expanded) trackAccordion(expanded);
    const under = event ? document.elementFromPoint(event.clientX, event.clientY) : null;
    const card = under instanceof Element ? under.closest(".stream-project") : null;
    if (card) {
      hoveredStreamCard = card;
      armStreamHover(card);
    }
  }
  runStream();
}

window.addEventListener("pointerup", endStreamDrag);
window.addEventListener("pointercancel", endStreamDrag);

elements.streamShell.addEventListener("click", (event) => {
  if (!suppressStreamClick) return;
  suppressStreamClick = false;
  event.preventDefault();
  event.stopPropagation();
}, true);

elements.streamShell.addEventListener("dragstart", (event) => event.preventDefault());

// The home screen (and the page itself on mobile) can scroll vertically, which
// changes which cards are visible; re-check exposures after it settles.
elements.homeScreen?.addEventListener("scroll", () => scheduleImpressionCheck(200), { passive: true });
window.addEventListener("scroll", () => scheduleImpressionCheck(200), { passive: true });

/* The accordion grows the hovered card to 16:9 to the right, so a card that
   sits near the right edge would expand out of the viewport and stay clipped.
   Follow the hovered card the same way keyboard focus already does, and allow
   the pan to exceed the resting bound only while a single-project group (JD /
   Kingsoft) is actually wide open; leaving the card clamps it back so the
   stream never exposes blank space where the wider card used to be. */
/* Keyboard focus still pans the stream so a tabbed-to card is not left
   off-screen. Mouse hover does not pan at all: the opened card grows from its
   own centre and may be clipped at a viewport edge, which is the trade-off for
   never dragging the rest of the row around. */
const REVEAL_MARGIN = 48;

function revealStreamCard(card) {
  if (state.screen !== "home") return;
  if (stream.dragging || suppressStreamClick) return;
  if (stream.dirty) measureStream();
  const item = stream.cards.find((entry) => entry.element === card);
  if (!item) return;
  const group = card.closest(".group-projects");
  const expanded = group ? parseFloat(getComputedStyle(group).getPropertyValue("--expanded-card-width")) : NaN;
  const open = card.classList.contains("is-expanded") || card.matches(":focus-visible");
  const width = open && Number.isFinite(expanded) && expanded > 0 ? Math.max(item.width, expanded) : item.width;
  const left = item.center - item.width / 2 + stream.origin - stream.current - stream.shift;
  const gutter = Math.min(stream.viewport, parseFloat(getComputedStyle(elements.streamShell).paddingRight) || REVEAL_MARGIN);
  const leftEdge = gutter;
  const rightEdge = stream.viewport - gutter;
  let target = stream.target;
  if (left < leftEdge) target = stream.current + (left - leftEdge);
  else if (left + width > rightEdge) target = stream.current + (left + width - rightEdge);
  // stay inside the resting scroll bound: no over-pan of the stream
  target = Math.min(Math.max(target, 0), stream.max);
  if (Math.abs(target - stream.target) < 0.5) return;
  stream.target = target;
  runStream();
}

let hoveredStreamCard = null;
let streamHoverTimer = 0;

/* Hovering a cover expands it only after a short pause: sliding the pointer
   across the stream (or accidentally crossing it) must not pop the accordion.
   The visual hover states are driven by `.is-expanded` (see styles.css), which
   is added 150ms after the pointer settles on a card; leaving clears it at
   once so the collapse still starts immediately. Keyboard focus stays instant. */
const STREAM_HOVER_DELAY = 150;

function setStreamExpanded(card, expanded) {
  if (!card) return;
  card.classList.toggle("is-expanded", expanded);
  const anyExpanded = elements.timeline.querySelector(".stream-project.is-expanded");
  elements.streamShell.classList.toggle("is-hovering", Boolean(anyExpanded));
}

function armStreamHover(card) {
  window.clearTimeout(streamHoverTimer);
  streamHoverTimer = window.setTimeout(() => {
    if (hoveredStreamCard !== card || stream.dragging) return;
    homeEngagement.hovers += 1;
    setStreamExpanded(card, true);
    // start following the accordion shift only when it really expands
    trackAccordion(card);
  }, STREAM_HOVER_DELAY);
}

function resetHoverReveal() {
  window.clearTimeout(streamHoverTimer);
  hoveredStreamCard = null;
  elements.timeline.querySelectorAll(".stream-project.is-expanded").forEach((card) => {
    card.classList.remove("is-expanded");
  });
  elements.streamShell.classList.remove("is-hovering");
}

function resetAccordionShift() {
  window.clearTimeout(trackAccordion.timer);
  stream.accordion = false;
  stream.accordionCard = null;
  stream.shift = 0;
  applyStream();
}

elements.streamShell.addEventListener("pointerover", (event) => {
  if (event.pointerType !== "mouse" || stream.dragging) return;
  const card = event.target instanceof Element ? event.target.closest(".stream-project") : null;
  if (!card || card === hoveredStreamCard) return;
  const previous = hoveredStreamCard;
  hoveredStreamCard = card;
  window.clearTimeout(streamHoverTimer);
  if (previous && previous !== card && previous.classList.contains("is-expanded")) {
    setStreamExpanded(previous, false);
    // follow that collapse so the track offset returns with the width
    trackAccordion(previous);
  }
  armStreamHover(card);
});

elements.streamShell.addEventListener("pointerout", (event) => {
  if (event.pointerType !== "mouse") return;
  const card = event.target instanceof Element ? event.target.closest(".stream-project") : null;
  if (!card) return;
  const next = event.relatedTarget;
  if (next instanceof Element && card.contains(next)) return;
  if (hoveredStreamCard !== card && !card.classList.contains("is-expanded")) return;
  window.clearTimeout(streamHoverTimer);
  if (hoveredStreamCard === card) hoveredStreamCard = null;
  if (card.classList.contains("is-expanded")) {
    setStreamExpanded(card, false);
    // keep following the collapse so the offset returns with the width
    trackAccordion(card);
  }
});

elements.timeline.addEventListener("transitionend", (event) => {
  if (event.propertyName !== "flex-basis") return;
  const card = event.target instanceof Element ? event.target.closest(".stream-project") : null;
  if (!card || !card.matches(":focus-visible")) return;
  revealStreamCard(card);
});

// The stream cards use a one-off entrance animation; when the home screen is
// hidden and shown again the CSS animation would restart and make the card
// drift ~36px while the reverse transition is running. Clear it after the
// first play so returning home never replays it.
elements.timeline.addEventListener("animationend", (event) => {
  if (event.animationName === "stream-card-in" && event.target instanceof Element) {
    event.target.style.animation = "none";
  }
});

elements.timeline.addEventListener("focusin", (event) => {
  const card = event.target.closest(".stream-project");
  if (!card) return;
  trackAccordion(card);
});

function nudgeStream(direction) {
  if (state.screen !== "home") return;
  if (stream.dirty) measureStream();
  stream.target = clampStream(stream.target + direction * stream.viewport * 0.45);
  runStream();
}

function jumpStream(ratio) {
  if (state.screen !== "home") return;
  if (stream.dirty) measureStream();
  stream.target = clampStream(stream.max * ratio);
  runStream();
}

function scheduleStreamMeasure(delay = 0) {
  stream.dirty = true;
  window.clearTimeout(scheduleStreamMeasure.timer);
  scheduleStreamMeasure.timer = window.setTimeout(() => {
    stream.dirty = true;
    runStream();
  }, delay);
}

window.addEventListener("resize", () => {
  scheduleStreamMeasure(120);
  scheduleImpressionCheck(240);
  updateRailMask();
  sizeArtworkFrame();
  refreshArtworkResolution();
  if (state.screen === "viewer") {
    window.clearTimeout(thumbnailRevealTimer);
    revealCurrentThumbnail("auto");
  }
});

renderTimeline();
runStream();
handleRoute();
routeHydrated = true;
if (state.screen === "home") startHomeEngagement();
// Reveal the routed screen only after it has been hydrated; otherwise a hard
// refresh on a deep link paints the home stream (many large cards) first.
window.requestAnimationFrame(() => document.documentElement.classList.remove("is-booting"));
if (document.fonts?.ready) document.fonts.ready.then(() => scheduleStreamMeasure(60));
