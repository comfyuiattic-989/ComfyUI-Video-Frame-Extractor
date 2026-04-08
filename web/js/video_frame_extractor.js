/**
 * VideoFrameExtractor – ComfyUI custom widget  (v3)
 *
 * Changes vs v2.1:
 *  • Playhead removed entirely — loop region is the only scrub mechanism.
 *  • Hoverable loop zone: handles glow on hover; body brightens with a
 *    dashed highlight border so the user knows what is grabbable.
 *  • Transport bar with large Play / Pause / Stop buttons drawn in the
 *    widget itself, positioned between the preview and the timeline.
 *  • rAF loop drives videoEl.currentTime through the loop window.
 */

let app;
try {
  ({ app } = await import("../../scripts/app.js"));
} catch {
  ({ app } = await import("/scripts/app.js"));
}

// ─── Layout ──────────────────────────────────────────────────────────────────
const TRANSPORT_H    = 44;
const RULER_H        = 18;
const STRIP_H        = 48;
const ACTIVITY_H     = 28;
const LOOP_H         = 24;
const INFO_H         = 18;
const PAD            = 10;
const HANDLE_W       = 10;
const COLLAPSE_H          = 20;   // preview collapse toggle height
const RESIZE_H       = 14;   // preview resize handle — tall enough to be obvious
const PREVIEW_H_DEFAULT = 160;
const PREVIEW_H_MIN     = 80;
const PREVIEW_H_MAX     = 400;
// WIDGET_H is dynamic — computed in widget.computeSize()
const THUMB_COUNT    = 32;

// ─── Colours ─────────────────────────────────────────────────────────────────
const C = {
  surface:       "#131318",
  panel:         "#0f0f14",
  border:        "#222228",
  ruler:         "#1a1a22",
  rulerText:     "#555568",
  rulerMajor:    "#44445a",
  strip:         "#0d0d12",
  stripBorder:   "#1e1e28",
  activity:      "#22d3ee",
  activityFill:  "rgba(34,211,238,0.18)",

  // Loop region
  loopFill:      "rgba(99,102,241,0.22)",
  loopFillHov:   "rgba(99,102,241,0.42)",   // brighter when hovered
  loopBorder:    "#6366f1",
  loopBorderHov: "#a5b4fc",
  loopHandle:    "#818cf8",
  loopHandleHov: "#e0e7ff",
  loopGlow:      "rgba(99,102,241,0.55)",

  // Transport
  btnBg:         "#1e1e2a",
  btnBgHov:      "#2d2d42",
  btnBgActive:   "#3730a3",
  btnBorder:     "#3f3f5a",
  btnBorderHov:  "#818cf8",
  playIcon:      "#a5f3fc",
  pauseIcon:     "#fde68a",
  stopIcon:      "#fca5a5",

  // Playback position line (replaces playhead — simpler, no dragging)
  posLine:       "rgba(99,102,241,0.7)",
  stepBg:        "#0f2744",
  stepBgHov:     "#1a3a5c",
  stepBorder:    "#1e4976",
  stepBorderHov: "#3b82f6",
  stepIcon:      "#93c5fd",

  text:          "#e2e2ea",
  textDim:       "#55556a",
};

// ─── Util ─────────────────────────────────────────────────────────────────────
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function roundRect(ctx, x, y, w, h, r = 6) {
  if (w <= 0 || h <= 0) return;
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y,     x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x,     y + h, r);
  ctx.arcTo(x,     y + h, x,     y,     r);
  ctx.arcTo(x,     y,     x + w, y,     r);
  ctx.closePath();
}

// ─── Widget factory ───────────────────────────────────────────────────────────
function createVideoTimelineWidget(node, videoWidgetName) {

  // Preview size / collapse state
  let previewH         = 160;
  let collapsed        = false;  // preview section
  let resizeDrag       = false;
  let resizeDragStartY = 0;
  let resizeDragStartH = 0;
  // Video state
  let videoEl     = null;
  let totalFrames = 0;
  let fps         = 30;
  let vidW = 0, vidH = 0;

  // Loop region (frame units)
  let loopIn  = 0;
  let loopOut = 0;

  // View window (frame units)
  let viewStart = 0, viewEnd = 0;
  const MIN_VIEW = 10;

  // Filmstrip / activity
  const thumbCache = new Map();
  let thumbsQueued = false;
  let activityData = [];

  // Interaction
  let drag   = null;
  let layout = {};

  // Transport playback state
  // "stopped" | "playing" | "paused"
  let playState    = "stopped";
  let rafId        = null;
  let currentFrame = 0;   // tracks where we are during playback (for pos line)

  // ─── Cursor ──────────────────────────────────────────────────────────────
  let _canvasEl = null, _lastCursor = "";
  function getLGCanvas() {
    if (_canvasEl?.isConnected) return _canvasEl;
    _canvasEl = document.querySelector("canvas.litegraph") ?? document.querySelector("canvas");
    return _canvasEl;
  }
  function setCursor(c) {
    if (c === _lastCursor) return;
    _lastCursor = c;
    const el = getLGCanvas();
    if (el) el.style.cursor = c;
  }
  function cursorFor(type, dragging) {
    if (type === "loopIn" || type === "loopOut") return "ew-resize";
    if (type === "loopBody") return dragging ? "grabbing" : "grab";
    if (type === "btnPlayPause" || type === "btnPrev" || type === "btnNext") return "pointer";
    if (type === "resize")   return "ns-resize";
    if (type === "collapse") return "pointer";
    return "default";
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────
  const getWidget = name => node.widgets?.find(w => w.name === name);

  function syncWidgets() {
    const sf = getWidget("start_frame");
    const ef = getWidget("end_frame");
    const nf = getWidget("num_frames");
    if (sf) sf.value = loopIn;
    if (ef) ef.value = loopOut;
    if (nf) nf.value = loopOut - loopIn + 1;
  }

  function effectiveViewEnd() {
    return viewEnd > viewStart ? viewEnd : totalFrames;
  }

  function frameToX(frame, tX, tW) {
    const vS = viewStart, vE = effectiveViewEnd();
    if (vE <= vS) return tX;
    return tX + ((frame - vS) / (vE - vS)) * tW;
  }

  function xToFrame(x, tX, tW) {
    const t = clamp((x - tX) / tW, 0, 1);
    return Math.round(viewStart + t * (effectiveViewEnd() - viewStart));
  }

  // ─── Transport / playback ────────────────────────────────────────────────

  function play() {
    if (!videoEl || !totalFrames) return;
    if (playState === "stopped" || playState === "paused") {
      // Start from loop start if stopped; resume from current position if paused
      if (playState === "stopped") {
        currentFrame = loopIn;
        videoEl.currentTime = loopIn / fps;
      }
    }
    playState = "playing";
    videoEl.muted = false;
    videoEl.play().catch(() => {});   // tell the browser element to actually play
    scheduleFrame();
    node.setDirtyCanvas(true, false);
  }

  function pause() {
    if (playState !== "playing") return;
    playState = "paused";
    cancelAnimationFrame(rafId);
    rafId = null;
    if (videoEl) videoEl.pause();   // stop the browser video element itself
    node.setDirtyCanvas(true, false);
  }

  function stop() {
    // Internal reset — called when video changes or loop moves.
    // Not exposed as a button any more.
    cancelAnimationFrame(rafId);
    rafId = null;
    playState = "paused";
    currentFrame = loopIn;
    if (videoEl) {
      videoEl.pause();
      videoEl.currentTime = loopIn / fps;
    }
    node.setDirtyCanvas(true, false);
  }

  // Convenience predicate used by mouse handler (avoids closure-over-playState issues)
  function isPlaying() { return playState === "playing"; }

  // Shift the entire loop window by one frame (keeps span constant).
  // Pauses playback, seeks preview to new loopIn, syncs widgets.
  function stepFrame(delta) {
    if (playState === "playing") pause();
    const span = loopOut - loopIn;
    // Clamp so neither end goes out of bounds
    const newIn  = clamp(loopIn + delta, 0, Math.max(0, totalFrames - 1 - span));
    const newOut = newIn + span;
    loopIn       = newIn;
    loopOut      = newOut;
    currentFrame = loopIn;
    if (videoEl && fps > 0) videoEl.currentTime = loopIn / fps;
    syncWidgets();
    node.setDirtyCanvas(true, false);
  }

  function scheduleFrame() {
    rafId = requestAnimationFrame(() => {
      if (playState !== "playing" || !videoEl) return;
      // Derive currentFrame from actual video time
      currentFrame = Math.round((videoEl.currentTime || 0) * fps);
      // Loop back when we reach loopOut
      if (currentFrame >= loopOut) {
        currentFrame = loopIn;
        videoEl.currentTime = loopIn / fps;
      }
      node.setDirtyCanvas(true, false);
      scheduleFrame();
    });
    // Also actually advance the video
    if (videoEl.paused) videoEl.play().catch(() => {});
  }

  // ─── Fetch ───────────────────────────────────────────────────────────────

  async function fetchVideoInfo(videoName) {
    if (!videoName) return;
    try {
      const r    = await fetch(`/video_frame_extractor/info?video=${encodeURIComponent(videoName)}`);
      const info = await r.json();
      if (info.error) return;
      totalFrames  = info.total_frames || 1;
      fps          = info.fps          || 30;
      vidW         = info.width        || 0;
      vidH         = info.height       || 0;
      loopIn       = 0;
      loopOut      = totalFrames - 1;
      currentFrame = 0;
      viewStart    = 0;
      viewEnd      = totalFrames;
      activityData = [];
      thumbsQueued = false;
      thumbCache.clear();
      stop();
      syncWidgets();
      loadVideoEl(videoName);
      queueThumbs(videoName);
      node.setDirtyCanvas(true, true);
    } catch (e) {
      console.warn("[VideoFrameExtractor] fetchVideoInfo:", e);
    }
  }

  function loadVideoEl(videoName) {
    const url = `/view?filename=${encodeURIComponent(videoName)}&type=input`;
    if (!videoEl) {
      videoEl             = document.createElement("video");
      videoEl.muted       = true;
      videoEl.preload     = "auto";
      videoEl.playsInline = true;
      videoEl.crossOrigin = "anonymous";
    }
    if (videoEl.dataset.src !== url) {
      videoEl.src         = url;
      videoEl.dataset.src = url;
      videoEl.load();
    }
  }

  async function queueThumbs(videoName) {
    if (thumbsQueued || !totalFrames) return;
    thumbsQueued = true;
    const indices = Array.from({ length: THUMB_COUNT }, (_, i) =>
      Math.round(i * (totalFrames - 1) / (THUMB_COUNT - 1))
    );
    const BATCH = 4;
    for (let b = 0; b < indices.length; b += BATCH) {
      await Promise.all(indices.slice(b, b + BATCH).map(async (fi, bi) => {
        try {
          const url = `/video_frame_extractor/thumbnail?video=${encodeURIComponent(videoName)}&frame=${fi}`;
          const img = new Image();
          await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
          thumbCache.set(fi, img);
          activityData[b + bi] = computeActivity(img);
          node.setDirtyCanvas(true, false);
        } catch (_) { activityData[b + bi] = 0; }
      }));
    }
  }

  function computeActivity(img) {
    try {
      const oc = document.createElement("canvas");
      oc.width = 16; oc.height = 9;
      const ox = oc.getContext("2d");
      ox.drawImage(img, 0, 0, 16, 9);
      const px = ox.getImageData(0, 0, 16, 9).data;
      let sum = 0;
      for (let i = 0; i < px.length; i += 4)
        sum += (px[i] * 0.299 + px[i+1] * 0.587 + px[i+2] * 0.114) / 255;
      return sum / (16 * 9);
    } catch (_) { return 0.5; }
  }

  // ─── Draw helpers ─────────────────────────────────────────────────────────

  function drawPreview(ctx, x, y, w, h) {
    ctx.fillStyle = C.panel;
    roundRect(ctx, x, y, w, h, 5);
    ctx.fill();
    ctx.strokeStyle = C.border;
    ctx.lineWidth = 1;
    ctx.stroke();

    if (videoEl && videoEl.readyState >= 2) {
      ctx.save();
      roundRect(ctx, x, y, w, h, 5);
      ctx.clip();
      const vAR = (videoEl.videoWidth || 16) / (videoEl.videoHeight || 9);
      const pAR = w / h;
      let dw, dh, dx, dy;
      if (vAR > pAR) { dw = w; dh = w / vAR; dx = x; dy = y + (h - dh) / 2; }
      else            { dh = h; dw = h * vAR; dy = y; dx = x + (w - dw) / 2; }
      ctx.drawImage(videoEl, dx, dy, dw, dh);
      ctx.restore();
    } else {
      ctx.fillStyle = C.textDim;
      ctx.font      = "12px 'Courier New', monospace";
      ctx.textAlign = "center";
      ctx.fillText(totalFrames ? "Loading preview…" : "⬆  Upload a video above", x + w / 2, y + h / 2 + 4);
    }

    // Timecode overlay
    if (totalFrames > 0) {
      const f    = currentFrame;
      const secs = f / fps;
      const mm   = String(Math.floor(secs / 60)).padStart(2, "0");
      const ss   = String(Math.floor(secs % 60)).padStart(2, "0");
      const ff   = String(f % Math.max(1, Math.round(fps))).padStart(2, "0");
      ctx.fillStyle = "rgba(0,0,0,0.72)";
      ctx.fillRect(x + 4, y + h - 22, 160, 18);
      ctx.fillStyle = "#a5b4fc";
      ctx.font      = "12px 'Courier New', monospace";
      ctx.textAlign = "left";
      ctx.fillText(`${mm}:${ss}:${ff}  fr ${f}`, x + 8, y + h - 8);
      if (vidW && vidH) {
        ctx.fillStyle = "rgba(0,0,0,0.55)";
        ctx.fillRect(x + w - 80, y + 4, 76, 16);
        ctx.fillStyle = C.textDim;
        ctx.font      = "10px 'Courier New', monospace";
        ctx.textAlign = "right";
        ctx.fillText(`${vidW}×${vidH}`, x + w - 6, y + 14);
      }
    }
  }

  // ── Transport bar ────────────────────────────────────────────────────────
  // Layout (left → right):
  //   [◀◀ PREV]  [▶ PLAY / ⏸ PAUSE toggle]  [■ STOP]  [NEXT ▶▶]
  //
  // Returns a map of id → {x,y,w,h} in node-local coords for hit-testing.
  // All rects store the ABSOLUTE node-local y so mouse() needs no math.
  function drawTransport(ctx, x, y, w, h) {
    ctx.fillStyle = "#0e0e16";
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = C.border;
    ctx.lineWidth   = 0.5;
    ctx.strokeRect(x, y, w, h);

    if (!totalFrames) return {};

    const BTN_H    = 32;
    const STEP_W   = 44;   // frame-step buttons
    const TOGGLE_W = 100;  // play/pause toggle — most prominent button
    const GAP      = 10;
    const totalW   = STEP_W + GAP + TOGGLE_W + GAP + STEP_W;
    const bx0      = x + Math.round((w - totalW) / 2);
    const by       = y + Math.round((h - BTN_H) / 2);

    // Button descriptors — positions computed left→right
    const isPlaying = playState === "playing";
    const buttons = [
      {
        id: "btnPrev", label: "◀", sublabel: "PREV",
        col: C.stepIcon, isStep: true,
        bx: bx0, bw: STEP_W,
      },
      {
        id: "btnPlayPause",
        label: isPlaying ? "⏸  PAUSE" : "▶  PLAY",
        col: isPlaying ? C.pauseIcon : C.playIcon,
        bx: bx0 + STEP_W + GAP, bw: TOGGLE_W,
        isActive: isPlaying,
      },
      {
        id: "btnNext", label: "▶", sublabel: "NEXT",
        col: C.stepIcon, isStep: true,
        bx: bx0 + STEP_W + GAP + TOGGLE_W + GAP, bw: STEP_W,
      },
    ];

    const hitRects = {};

    for (const btn of buttons) {
      const isActive  = !!btn.isActive;
      const isHovered = widget._hover === btn.id;

      const bgCol = btn.isStep
                  ? (isHovered ? C.stepBgHov  : C.stepBg)
                  : (isActive  ? C.btnBgActive : isHovered ? C.btnBgHov : C.btnBg);
      const bdCol = btn.isStep
                  ? (isHovered ? C.stepBorderHov : C.stepBorder)
                  : (isActive  ? "#818cf8" : isHovered ? C.btnBorderHov : C.btnBorder);

      // Background
      ctx.fillStyle = bgCol;
      roundRect(ctx, btn.bx, by, btn.bw, BTN_H, 6);
      ctx.fill();
      ctx.strokeStyle = bdCol;
      ctx.lineWidth   = isActive ? 1.5 : 1;
      ctx.stroke();

      // Glow ring on active play/pause only
      if (isActive && !btn.isStep) {
        ctx.strokeStyle = "rgba(99,102,241,0.35)";
        ctx.lineWidth   = 3;
        roundRect(ctx, btn.bx - 1, by - 1, btn.bw + 2, BTN_H + 2, 7);
        ctx.stroke();
      }

      // Label — step buttons: large arrow + small text label; others: single line
      ctx.textAlign = "center";
      if (btn.isStep) {
        ctx.fillStyle = isHovered ? "#bfdbfe" : btn.col;
        ctx.font      = "14px 'Courier New', monospace";
        ctx.fillText(btn.label, btn.bx + btn.bw / 2, by + BTN_H / 2 - 1);
        ctx.fillStyle = isHovered ? "#93c5fd" : "#3b6a96";
        ctx.font      = "8px 'Courier New', monospace";
        ctx.fillText(btn.sublabel, btn.bx + btn.bw / 2, by + BTN_H / 2 + 10);
      } else {
        ctx.fillStyle = isActive ? "#ffffff" : (isHovered ? "#e2e2ea" : btn.col);
        ctx.font      = "11px 'Courier New', monospace";
        ctx.fillText(btn.label, btn.bx + btn.bw / 2, by + BTN_H / 2 + 4);
      }

      // Store absolute rect for hit-testing
      hitRects[btn.id] = { x: btn.bx, y: by, w: btn.bw, h: BTN_H };
    }

    // Progress bar — slim strip at bottom of transport row
    if (totalFrames > 0) {
      const pbY  = y + h - 5;
      const pbW  = w - 20;
      const pbX  = x + 10;
      const span = loopOut - loopIn;
      const pct  = span > 0 ? clamp(currentFrame - loopIn, 0, span) / span : 0;
      ctx.fillStyle = "#1a1a26";
      roundRect(ctx, pbX, pbY, pbW, 3, 2); ctx.fill();
      if (pct > 0) {
        ctx.fillStyle = "#6366f1";
        roundRect(ctx, pbX, pbY, Math.round(pbW * pct), 3, 2); ctx.fill();
      }
    }

    return hitRects;
  }

  function drawRuler(ctx, x, y, w, h) {
    ctx.fillStyle = C.ruler;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = C.border;
    ctx.lineWidth = 0.5;
    ctx.strokeRect(x, y, w, h);
    if (!totalFrames) return;

    const vS = viewStart, vE = effectiveViewEnd();
    const vis = vE - vS;
    const raw = 40 * (vis / w);
    const nice = [1,2,5,10,15,30,60,120,300,600,
                  Math.round(fps), Math.round(fps*5), Math.round(fps*10), Math.round(fps*30)];
    const tickInterval = nice.find(n => n >= raw) || nice[nice.length - 1];
    const firstTick    = Math.ceil(vS / tickInterval) * tickInterval;

    ctx.font      = "9px 'Courier New', monospace";
    ctx.textAlign = "center";
    for (let f = firstTick; f <= vE; f += tickInterval) {
      const tx    = frameToX(f, x, w);
      const isSec = fps > 0 && (f % Math.round(fps)) === 0;
      ctx.strokeStyle = isSec ? C.rulerMajor : "#2a2a38";
      ctx.lineWidth   = isSec ? 1 : 0.5;
      ctx.beginPath(); ctx.moveTo(tx, y); ctx.lineTo(tx, y + (isSec ? h : h * 0.5)); ctx.stroke();
      if (isSec || tickInterval >= 30) {
        const secs = f / fps;
        ctx.fillStyle = C.rulerText;
        ctx.fillText(
          `${String(Math.floor(secs/60)).padStart(2,"0")}:${String(Math.floor(secs%60)).padStart(2,"0")}`,
          tx, y + h - 2
        );
      }
    }
    // Hover tint — signals the ruler is clickable
    if (widget._hover === "ruler") {
      ctx.fillStyle = "rgba(165,180,252,0.05)";
      ctx.fillRect(x, y, w, h);
    }
  }

  function drawFilmstrip(ctx, x, y, w, h) {
    ctx.fillStyle = C.strip;
    ctx.fillRect(x, y, w, h);

    if (!totalFrames || thumbCache.size === 0) {
      ctx.fillStyle = C.textDim;
      ctx.font      = "10px monospace";
      ctx.textAlign = "center";
      ctx.fillText("Loading filmstrip…", x + w / 2, y + h / 2 + 3);
      return;
    }

    const vS = viewStart, vE = effectiveViewEnd();
    const thumbW = h * (16 / 9);
    const step   = Math.max(1, Math.round((vE - vS) / Math.max(1, Math.ceil(w / thumbW))));
    const first  = Math.floor(vS / step) * step;

    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();

    for (let f = first; f <= vE + step; f += step) {
      const cellX = frameToX(f, x, w);
      const cellW = Math.max(1, frameToX(f + step, x, w) - cellX);
      const img   = findNearestThumb(f);
      if (img) { try { ctx.drawImage(img, cellX, y, cellW, h); } catch (_) {} }
      else { ctx.fillStyle = "#090910"; ctx.fillRect(cellX, y, cellW, h); }
      ctx.strokeStyle = C.stripBorder; ctx.lineWidth = 0.5;
      ctx.strokeRect(cellX, y, cellW, h);
    }

    // Darken outside loop region
    const lx = frameToX(loopIn,  x, w);
    const rx = frameToX(loopOut, x, w);
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(x,  y, lx - x,       h);
    ctx.fillRect(rx, y, (x + w) - rx, h);

    ctx.restore();

    // Frame labels
    const lblEvery = Math.max(1, Math.round((vE - vS) / 8));
    ctx.fillStyle  = "rgba(255,255,255,0.5)";
    ctx.font       = "9px 'Courier New', monospace";
    ctx.textAlign  = "center";
    for (let f = Math.ceil(vS / lblEvery) * lblEvery; f <= vE; f += lblEvery)
      ctx.fillText(String(f), frameToX(f, x, w), y + h - 3);

    // Hover tint over filmstrip
    if (widget._hover === "filmstrip") {
      ctx.fillStyle = "rgba(165,180,252,0.05)";
      ctx.fillRect(x, y, w, h);
    }
  }

  function findNearestThumb(target) {
    if (thumbCache.has(target)) return thumbCache.get(target);
    let best = null, bestDist = Infinity;
    for (const [f, img] of thumbCache) {
      const d = Math.abs(f - target);
      if (d < bestDist) { bestDist = d; best = img; }
    }
    return best;
  }

  function drawActivity(ctx, x, y, w, h) {
    ctx.fillStyle = C.panel;
    ctx.fillRect(x, y, w, h);
    if (activityData.length < 2) return;
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.beginPath();
    for (let i = 0; i < activityData.length; i++) {
      const frame = Math.round(i * (totalFrames - 1) / (activityData.length - 1));
      const ax = frameToX(frame, x, w);
      const ay = y + h - activityData[i] * h * 0.88;
      i === 0 ? ctx.moveTo(ax, ay) : ctx.lineTo(ax, ay);
    }
    ctx.lineTo(x + w, y + h); ctx.lineTo(x, y + h); ctx.closePath();
    ctx.fillStyle   = C.activityFill; ctx.fill();
    ctx.strokeStyle = C.activity; ctx.lineWidth = 1; ctx.stroke();
    ctx.restore();
    ctx.fillStyle = C.textDim; ctx.font = "9px monospace"; ctx.textAlign = "left";
    ctx.fillText("BRIGHTNESS", x + 3, y + h - 3);
  }

  // ── Loop bar — the star of the show ──────────────────────────────────────
  function drawLoopBar(ctx, x, y, w, h) {
    ctx.fillStyle = "#0c0c12";
    ctx.fillRect(x, y, w, h);

    if (!totalFrames) return;

    const lx = frameToX(loopIn,  x, w);
    const rx = frameToX(loopOut, x, w);
    const regionW = rx - lx;

    const hovIn   = widget._hover === "loopIn"   || drag?.type === "loopIn";
    const hovOut  = widget._hover === "loopOut"  || drag?.type === "loopOut";
    const hovBody = widget._hover === "loopBody" || drag?.type === "loopBody";
    const anyHov  = hovIn || hovOut || hovBody;

    // ── Body fill ───────────────────────────────────────────────────────
    ctx.fillStyle = anyHov ? C.loopFillHov : C.loopFill;
    ctx.fillRect(lx, y, regionW, h);

    // ── Body border ─────────────────────────────────────────────────────
    if (anyHov) {
      // Bright solid border when hovered
      ctx.strokeStyle = C.loopBorderHov;
      ctx.lineWidth   = 1.5;
      ctx.strokeRect(lx, y, regionW, h);

      // Dashed highlight on top edge to signal "this whole area is draggable"
      if (hovBody) {
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = "rgba(165,180,252,0.7)";
        ctx.lineWidth   = 1;
        ctx.beginPath();
        ctx.moveTo(lx + HANDLE_W + 2, y + 1);
        ctx.lineTo(rx - HANDLE_W - 2, y + 1);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    } else {
      ctx.strokeStyle = C.loopBorder;
      ctx.lineWidth   = 1;
      ctx.strokeRect(lx, y, regionW, h);
    }

    // ── "Drag me" hint label inside body ────────────────────────────────
    if (regionW > 80 && !anyHov) {
      ctx.fillStyle = "rgba(99,102,241,0.4)";
      ctx.font      = "9px 'Courier New', monospace";
      ctx.textAlign = "center";
      ctx.fillText("↔ drag", lx + regionW / 2, y + h * 0.68);
    }

    // ── Frame count label ────────────────────────────────────────────────
    if (regionW > 50) {
      ctx.fillStyle = anyHov ? "rgba(224,231,255,0.95)" : "rgba(139,139,255,0.75)";
      ctx.font      = "9px 'Courier New', monospace";
      ctx.textAlign = "center";
      ctx.fillText(`${loopOut - loopIn + 1} fr`, lx + regionW / 2, y + h * 0.40);
    }

    // ── Playback position line inside loop ───────────────────────────────
    if (playState !== "stopped" && totalFrames > 0) {
      const posX = frameToX(currentFrame, x, w);
      if (posX >= lx && posX <= rx) {
        ctx.strokeStyle = C.posLine;
        ctx.lineWidth   = 2;
        ctx.beginPath(); ctx.moveTo(posX, y); ctx.lineTo(posX, y + h); ctx.stroke();
      }
    }

    // ── Handles ─────────────────────────────────────────────────────────
    drawLoopHandle(ctx, lx, y, h, "in",  hovIn);
    drawLoopHandle(ctx, rx, y, h, "out", hovOut);
  }

  function drawLoopHandle(ctx, cx, y, h, side, hovered) {
    const col = hovered ? C.loopHandleHov : C.loopHandle;

    // Glow effect behind handle when hovered
    if (hovered) {
      ctx.fillStyle = C.loopGlow;
      const gw = HANDLE_W + 8;
      if (side === "in")
        ctx.fillRect(cx - gw, y - 2, gw + 2, h + 4);
      else
        ctx.fillRect(cx - 2, y - 2, gw + 2, h + 4);
    }

    // Handle body
    ctx.fillStyle   = col;
    ctx.strokeStyle = hovered ? "#e0e7ff" : "#4f46e5";
    ctx.lineWidth   = hovered ? 1.5 : 1;

    if (side === "in") {
      // Left bracket tab
      ctx.beginPath();
      ctx.moveTo(cx - HANDLE_W, y);
      ctx.lineTo(cx, y);
      ctx.lineTo(cx, y + h);
      ctx.lineTo(cx - HANDLE_W, y + h);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
      // Arrow chevron
      ctx.fillStyle = hovered ? "#1e1b4b" : "#312e81";
      ctx.beginPath();
      ctx.moveTo(cx - HANDLE_W + 3, y + h * 0.28);
      ctx.lineTo(cx - 3,            y + h * 0.50);
      ctx.lineTo(cx - HANDLE_W + 3, y + h * 0.72);
      ctx.closePath(); ctx.fill();
    } else {
      // Right bracket tab
      ctx.beginPath();
      ctx.moveTo(cx, y);
      ctx.lineTo(cx + HANDLE_W, y);
      ctx.lineTo(cx + HANDLE_W, y + h);
      ctx.lineTo(cx, y + h);
      ctx.closePath();
      ctx.fill(); ctx.stroke();
      ctx.fillStyle = hovered ? "#1e1b4b" : "#312e81";
      ctx.beginPath();
      ctx.moveTo(cx + HANDLE_W - 3, y + h * 0.28);
      ctx.lineTo(cx + 3,            y + h * 0.50);
      ctx.lineTo(cx + HANDLE_W - 3, y + h * 0.72);
      ctx.closePath(); ctx.fill();
    }
  }

  function drawCollapseToggle(ctx, x, y, w, h) {
    const isHov = widget._hover === "collapse";
    ctx.fillStyle = isHov ? "#1e1e2e" : "#16161e";
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = C.border; ctx.lineWidth = 0.5;
    ctx.strokeRect(x, y, w, h);
    // Chevron
    const cx = x + 12, cy = y + h / 2;
    ctx.strokeStyle = isHov ? "#a5b4fc" : "#44445a";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (collapsed) {
      ctx.moveTo(cx - 3, cy - 3); ctx.lineTo(cx + 3, cy); ctx.lineTo(cx - 3, cy + 3);
    } else {
      ctx.moveTo(cx - 4, cy - 2); ctx.lineTo(cx, cy + 3); ctx.lineTo(cx + 4, cy - 2);
    }
    ctx.stroke();
    ctx.fillStyle = isHov ? "#a5b4fc" : C.textDim;
    ctx.font      = "10px 'Courier New', monospace";
    ctx.textAlign = "left";
    ctx.fillText(
      collapsed ? "VIDEO PREVIEW  (click to expand)" : "VIDEO PREVIEW  (click to collapse)",
      x + 24, y + h / 2 + 4
    );
    if (collapsed && totalFrames > 0) {
      ctx.textAlign = "right";
      ctx.fillText(`${totalFrames} fr  •  ${fps.toFixed(0)} fps`, x + w - 4, y + h / 2 + 4);
    }
  }

  function drawResizeHandle(ctx, x, y, w, h) {
    const isHov = widget._hover === "resize" || resizeDrag;

    // Background — lightens on hover to signal interactivity
    ctx.fillStyle = isHov ? "#2e2e46" : "#1a1a28";
    ctx.fillRect(x, y, w, h);

    // Top + bottom border
    ctx.strokeStyle = isHov ? "#818cf8" : "#2a2a3e";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y);     ctx.lineTo(x + w, y);
    ctx.moveTo(x, y + h); ctx.lineTo(x + w, y + h);
    ctx.stroke();

    // Label — centred vertically
    ctx.fillStyle = isHov ? "#c7d2fe" : "#55556a";
    ctx.font      = "9px 'Courier New', monospace";
    ctx.textAlign = "center";
    ctx.fillText("↕  DRAG TO RESIZE", x + w / 2, y + h / 2 + 4);
  }

  function drawInfoBar(ctx, x, y, w) {
    if (!totalFrames) return;
    const dur     = ((loopOut - loopIn) / fps).toFixed(2);
    const nFrames = loopOut - loopIn + 1;
    const stateLabel = playState === "playing" ? "▶ PLAYING" : "⏸ PAUSED";
    ctx.fillStyle = C.textDim;
    ctx.font      = "10px 'Courier New', monospace";
    ctx.textAlign = "left";
    ctx.fillText(
      `LOOP  ${loopIn} → ${loopOut}  (${nFrames} fr / ${dur}s)   •   ${stateLabel}`,
      x + 2, y + 12
    );
    const vS = viewStart, vE = effectiveViewEnd();
    const zoomPct = Math.round((totalFrames / Math.max(1, vE - vS)) * 100);
    ctx.textAlign = "right";
    ctx.fillText(`zoom ${zoomPct}%  ⇧+scroll=pan`, x + w - 2, y + 12);
  }

  // ─── Widget object ────────────────────────────────────────────────────────
  const widget = {
    type:    "VIDEOTIMELINE_V3",
    name:    "video_timeline_widget",
    options: {},
    value:   null,
    _hover:  null,
    _btnRects: {},

    // Called externally (e.g. from spinner watches) to update the loop
    // region without going through drag logic.
    setLoop(newIn, newOut) {
      if (!totalFrames) return;
      loopIn  = Math.max(0, Math.min(newIn,  totalFrames - 1));
      loopOut = Math.max(loopIn, Math.min(newOut, totalFrames - 1));
      currentFrame = loopIn;
      if (videoEl) { videoEl.pause(); videoEl.currentTime = loopIn / fps; }
      cancelAnimationFrame(rafId); rafId = null; playState = "paused";
      syncWidgets();
      node.setDirtyCanvas(true, false);
    },

    draw(ctx, nodeObj, widgetWidth, y) {
      ctx.save();
      const outerX = PAD;
      const outerW = widgetWidth - PAD * 2;
      const totalH = widget.computeSize()[1] - 4;

      ctx.fillStyle = C.surface; ctx.strokeStyle = C.border; ctx.lineWidth = 1;
      roundRect(ctx, outerX, y, outerW, totalH);
      ctx.fill(); ctx.stroke();

      const iX = outerX + 6;
      const iW = outerW - 12;

      // Collapse toggle row — always visible
      const collapseY  = y + 4;
      drawCollapseToggle(ctx, iX, collapseY, iW, COLLAPSE_H);

      // Sections below — heights vary when preview is collapsed
      const previewY   = collapseY  + COLLAPSE_H + 2;
      const resizeBarY = previewY   + (collapsed ? 0 : previewH);
      const transportY = resizeBarY + (collapsed ? 0 : RESIZE_H + 2);
      const rulerY     = transportY + (collapsed ? 0 : TRANSPORT_H + 2);
      const stripY     = rulerY     + RULER_H;
      const actY       = stripY     + STRIP_H;
      const loopBarY   = actY       + ACTIVITY_H;
      const infoY      = loopBarY   + LOOP_H + 4;

      layout = { iX, iW, collapseY, previewY, resizeBarY,
                 transportY, rulerY, stripY, actY, loopBarY, infoY };

      if (!collapsed) {
        drawPreview(ctx,         iX, previewY,   iW, previewH);
        drawResizeHandle(ctx,    iX, resizeBarY,  iW, RESIZE_H);
        widget._btnRects = drawTransport(ctx, iX, transportY, iW, TRANSPORT_H);
      } else {
        widget._btnRects = {};
      }
      drawRuler(ctx,     iX, rulerY,   iW, RULER_H);
      drawFilmstrip(ctx, iX, stripY,   iW, STRIP_H);
      drawActivity(ctx,  iX, actY,     iW, ACTIVITY_H);
      drawLoopBar(ctx,   iX, loopBarY, iW, LOOP_H);
      drawInfoBar(ctx,   iX, infoY,    iW);

      ctx.restore();

      if (playState === "playing" || (videoEl && videoEl.readyState >= 2))
        node.setDirtyCanvas(true, false);
    },

    computeSize() {
      const ph = collapsed ? 0 : previewH + RESIZE_H + 2 + TRANSPORT_H + 2;
      return [0, COLLAPSE_H + 10 + ph + RULER_H + STRIP_H + ACTIVITY_H + LOOP_H + INFO_H + 28];
    },

    mouse(event, pos) {
      if (!layout.iX) return false;

      const mx = pos[0];
      const my = pos[1];

      // ── Wheel ──────────────────────────────────────────────────────
      if (event.type === "wheel") {
        handleWheel(event, mx);
        node.setDirtyCanvas(true, false);
        return true;
      }

      const { iX, iW, collapseY, resizeBarY, transportY, rulerY,
              stripY, actY, loopBarY } = layout;

      // ── Pre-compute zone membership ─────────────────────────────────
      const inCollapse  = collapseY  != null && my >= collapseY  && my <= collapseY  + COLLAPSE_H;
      const inResize    = !collapsed && resizeBarY != null
                          && my >= resizeBarY && my <= resizeBarY + RESIZE_H;
      const inTransport = !collapsed && transportY != null
                          && my >= transportY && my <= transportY + TRANSPORT_H;
      const inRuler     = rulerY != null && my >= rulerY  && my < (stripY  ?? rulerY + RULER_H);
      const inStrip     = stripY != null && my >= stripY  && my < (actY    ?? stripY + STRIP_H);
      const inAct       = actY   != null && my >= actY    && my < actY + ACTIVITY_H;
      const inLoopRow   = loopBarY != null && my >= loopBarY && my <= loopBarY + LOOP_H;
      const inTimeline  = (inRuler || inStrip || inAct || inLoopRow);

      // Single hit-test helper for transport buttons
      function hitBtn() {
        for (const [id, r] of Object.entries(widget._btnRects))
          if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h) return id;
        return null;
      }

      // ── Pointer down ────────────────────────────────────────────────
      if (event.type === "pointerdown") {
        if (inCollapse) {
          collapsed = !collapsed;
          node.setSize([node.size[0], node.computeSize()[1]]);
          node.setDirtyCanvas(true, true);
          return true;
        }
        if (inResize) {
          resizeDrag = true;
          resizeDragStartY = my;
          resizeDragStartH = previewH;
          setCursor("ns-resize");
          return true;
        }
        if (inTransport) {
          const id = hitBtn();
          if (id === "btnPlayPause") { isPlaying() ? pause() : play(); return true; }
          if (id === "btnPrev")      { stepFrame(-1); return true; }
          if (id === "btnNext")      { stepFrame(+1); return true; }
          return false;
        }
        if (inTimeline) {
          drag = detectTarget(mx, my, iX, iW, loopBarY);
          if (drag) { setCursor(cursorFor(drag.type, true)); return true; }
        }
        return false;
      }

      // ── Pointer move ────────────────────────────────────────────────
      if (event.type === "pointermove") {
        // Active drag takes priority
        if (resizeDrag) {
          const delta = my - resizeDragStartY;
          previewH = clamp(resizeDragStartH + delta, PREVIEW_H_MIN, PREVIEW_H_MAX);
          node.setSize([node.size[0], node.computeSize()[1]]);
          node.setDirtyCanvas(true, true);
          widget._hover = "resize";
          setCursor("ns-resize");
          return true;
        }
        if (drag) {
          applyDrag(mx, iX, iW);
          setCursor(cursorFor(drag.type, true));
          widget._hover = drag.type;
          node.setDirtyCanvas(true, false);
          return true;
        }

        // Hover detection — exactly one zone wins
        let hov = null;
        let cur = "default";
        if (inCollapse) {
          hov = "collapse"; cur = "pointer";
        } else if (inResize) {
          hov = "resize";   cur = "ns-resize";
        } else if (inTransport) {
          hov = hitBtn();   cur = hov ? "pointer" : "default";
        } else if (inLoopRow) {
          const t = detectTarget(mx, my, iX, iW, loopBarY);
          hov = t?.type ?? null;
          cur = cursorFor(hov, false);
        } else if (inRuler) {
          hov = "ruler";    cur = "crosshair";
        } else if (inStrip || inAct) {
          hov = "filmstrip"; cur = "default";
        }

        widget._hover = hov;
        setCursor(cur);
        node.setDirtyCanvas(true, false);
        return false;
      }

      // ── Pointer up ──────────────────────────────────────────────────
      if (event.type === "pointerup") {
        resizeDrag = false;
        drag       = null;
        // Re-evaluate hover at rest position
        let hov = null;
        if (inCollapse)  hov = "collapse";
        else if (inResize)    hov = "resize";
        else if (inTransport) hov = hitBtn();
        else if (inLoopRow)   hov = detectTarget(mx, my, iX, iW, loopBarY)?.type ?? null;
        else if (inRuler)     hov = "ruler";
        else if (inStrip || inAct) hov = "filmstrip";
        widget._hover = hov;
        setCursor(hov ? cursorFor(hov, false) : "default");
        return false;
      }

      return false;
    },

  };

  // ─── Drag targeting ──────────────────────────────────────────────────────
  function detectTarget(mx, my, tX, tW, loopBarY) {
    if (!totalFrames) return null;
    const lx = frameToX(loopIn,  tX, tW);
    const rx = frameToX(loopOut, tX, tW);

    // Loop bar row only
    const inLoopRow = my >= loopBarY && my <= loopBarY + LOOP_H;
    if (inLoopRow) {
      if (Math.abs(mx - lx) <= HANDLE_W + 4)
        return { type: "loopIn",   startX: mx, startIn: loopIn,  startOut: loopOut };
      if (Math.abs(mx - rx) <= HANDLE_W + 4)
        return { type: "loopOut",  startX: mx, startIn: loopIn,  startOut: loopOut };
      if (mx > lx + HANDLE_W && mx < rx - HANDLE_W)
        return { type: "loopBody", startX: mx, startIn: loopIn,  startOut: loopOut };
    }
    return null;
  }

  function applyDrag(mx, tX, tW) {
    if (!drag) return;
    const frame = xToFrame(mx, tX, tW);
    const dxFr  = Math.round((mx - drag.startX) / tW * (effectiveViewEnd() - viewStart));
    switch (drag.type) {
      case "loopIn":
        loopIn = clamp(frame, 0, loopOut - 1);
        break;
      case "loopOut":
        loopOut = clamp(frame, loopIn + 1, totalFrames - 1);
        break;
      case "loopBody": {
        const span = drag.startOut - drag.startIn;
        loopIn  = clamp(drag.startIn + dxFr, 0, totalFrames - 1 - span);
        loopOut = loopIn + span;
        break;
      }
    }
    // Always pause and seek preview to loop start when the region changes
    cancelAnimationFrame(rafId);
    rafId = null;
    playState     = "paused";
    currentFrame  = loopIn;
    if (videoEl) {
      videoEl.pause();
      videoEl.currentTime = loopIn / fps;
    }
    syncWidgets();
  }

  function handleWheel(event, mx) {
    if (!totalFrames) return;
    const { iX, iW } = layout;
    const vS = viewStart, vE = effectiveViewEnd(), vis = vE - vS;
    if (event.shiftKey) {
      const pan = Math.round(vis * 0.08 * Math.sign(event.deltaY));
      viewStart = clamp(vS + pan, 0, totalFrames - MIN_VIEW);
      viewEnd   = clamp(vE + pan, viewStart + MIN_VIEW, totalFrames);
    } else {
      const cursorFrame = xToFrame(mx, iX, iW);
      const factor = event.deltaY > 0 ? 1.15 : 0.87;
      let ns = 0, ne = 0;
      let newSpan = clamp(Math.round(vis * factor), MIN_VIEW, totalFrames);
      const ratio = clamp((cursorFrame - vS) / vis, 0, 1);
      ns = Math.round(cursorFrame - ratio * newSpan);
      ne = ns + newSpan;
      if (ns < 0)           { ns = 0; ne = newSpan; }
      if (ne > totalFrames) { ne = totalFrames; ns = totalFrames - newSpan; }
      viewStart = clamp(ns, 0, totalFrames);
      viewEnd   = clamp(ne, viewStart + MIN_VIEW, totalFrames);
    }
    event.preventDefault?.();
    event.stopPropagation?.();
  }

  // ─── Poll for video widget changes ───────────────────────────────────────
  let lastVideo = null;
  setInterval(() => {
    const vw = getWidget(videoWidgetName);
    if (vw?.value && vw.value !== lastVideo) { lastVideo = vw.value; fetchVideoInfo(vw.value); }
  }, 600);
  const vw0 = getWidget(videoWidgetName);
  if (vw0?.value) fetchVideoInfo(vw0.value);

  return widget;
}

// ─── Register ─────────────────────────────────────────────────────────────────
app.registerExtension({
  name: "Comfy.VideoFrameExtractor.v3",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "VideoFrameExtractor") return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onCreated?.apply(this, arguments);
      const tl = createVideoTimelineWidget(this, "video");
      if (this.widgets?.length) this.widgets.splice(1, 0, tl);
      else { this.widgets = this.widgets || []; this.widgets.push(tl); }

      // Fix widget label and upload button text
      const vw = this.widgets?.find(w => w.name === "video");
      if (vw) {
        vw.label = "Choose Video to Upload";
      }

      // num_frames: read-only, auto-computed
      const nf = this.widgets?.find(w => w.name === "num_frames");
      if (nf) {
        nf.disabled  = true;
        nf.read_only = true;
        const _orig  = nf.draw?.bind(nf);
        nf.draw = function(ctx, node, widget_width, y, H) {
          ctx.save(); ctx.globalAlpha = 0.45;
          _orig?.(ctx, node, widget_width, y, H);
          ctx.restore();
          ctx.fillStyle = "#6366f1"; ctx.font = "9px 'Courier New', monospace";
          ctx.textAlign = "right";
          ctx.fillText("AUTO", widget_width - 8, y + H / 2 + 4);
        };
        nf.mouse = () => false;
      }

      // Watch start_frame and end_frame spinners — sync loop region when changed
      const tlWidget = this.widgets?.find(w => w.name === "video_timeline_widget");
      const sfWidget = this.widgets?.find(w => w.name === "start_frame");
      const efWidget = this.widgets?.find(w => w.name === "end_frame");
      if (tlWidget && sfWidget && efWidget) {
        let lastSf = sfWidget.value;
        let lastEf = efWidget.value;
        setInterval(() => {
          const sf = sfWidget.value;
          const ef = efWidget.value;
          if (sf !== lastSf || ef !== lastEf) {
            lastSf = sf; lastEf = ef;
            // Clamp: start can't exceed end and vice-versa
            const newIn  = Math.min(sf, ef);
            const newOut = Math.max(sf, ef);
            tlWidget.setLoop(newIn, newOut);
          }
        }, 100);
      }

      this.setSize([520, this.computeSize()[1]]);
    };
  },
});
