// 摘要柔光 + 波浪背景（C6 runtime 拆分）。
// ── 卡片柔光：把鼠标位置写进 --mx/--my（CSS radial-gradient 使用）──
// 基础摘要卡、插件摘要卡、插件管理卡片共用；按容器事件委托，卡片重建后无需重绑。
function attachCardGloss(container) {
  if (!container) return;
  let raf = 0;
  let pending = null;
  container.addEventListener('pointermove', (e) => {
    const card = e.target.closest?.('.summary-card, .plugin-manage-card');
    if (!card) return;
    pending = { card, x: e.clientX, y: e.clientY };
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const p = pending;
      pending = null;
      if (!p) return;
      const r = p.card.getBoundingClientRect();
      p.card.style.setProperty('--mx', `${Math.round(p.x - r.left)}px`);
      p.card.style.setProperty('--my', `${Math.round(p.y - r.top)}px`);
    });
  }, { passive: true });
}

function initSummaryGloss() {
  attachCardGloss(document.getElementById('summaryGrid'));
  attachCardGloss(document.getElementById('pluginSummaryGrid'));
  attachCardGloss(document.getElementById('pluginManageView'));
}

// ── 交互波浪背景：像一块被风吹动的布（对齐 SnowLuma 登录页的质感）──
//
// 每条竖线按 y 采样成一条"纤维"，每个采样点有横向位移 u 与速度 v：
//   · 静止：两组低频正弦沿 y 叠加，形成**宽而缓的斜向折痕**；
//     相位随竖线的 x 缓慢变化，所以相邻线一起起伏（布面连续），不是各扭各的。
//   · 鼠标经过：半径内的点获得速度冲量（像手指拨过布料），
//     再靠"弹簧拉回折痕目标 + 相邻点耦合"把波动沿线传开、慢慢回弹。
//   · 每列透明度随折痕相位变化 → 出现明暗相间的折痕带，更像布料而不是等高线。
//
// 性能：只画竖线（约 70~80 列 × 60~75 点），DPR 上限 2；
// 每帧只是若干次三角函数与一次 path 描边，6000 个点的弹簧计算开销很小。
function initWaveField() {
  const canvas = document.getElementById('waveCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const R = 190;              // 鼠标影响半径（像素）
  const R2 = R * R;
  let W = 0, H = 0, DPR = 1, raf = 0, cols = [];
  let lastNow = 0;
  let paused = false;          // 整页详情打开时暂停：页面不透明，没必要继续画
  const pointer = { x: -9999, y: -9999, tx: -9999, ty: -9999, vx: 0, vy: 0, active: false };

  function layout() {
    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = Math.max(320, window.innerWidth);
    H = Math.max(240, window.innerHeight);
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    // 列距 18~24px：太密会糊成一片，太疏看不出"布"。
    const stepX = Math.max(18, Math.min(26, Math.round(W / 72)));
    const stepY = Math.max(12, Math.round(H / 62));
    cols = [];
    for (let x = -stepX; x <= W + stepX; x += stepX) {
      const pts = [];
      for (let y = -stepY; y <= H + stepY; y += stepY) {
        // u = 当前横向位移，v = 速度；初始直接落在折痕上，避免开场"弹一下"
        pts.push({ y, u: 0, v: 0 });
      }
      cols.push({ base: x, pts });
    }
  }

  // 折痕目标位移：三组低频波沿 y 叠加（约 1.6 / 2.7 / 5 道折痕）。
  // 相位里的 base 项**必须够大**：它决定"相邻竖线错开多少"，
  // 也就是布面会不会真的堆出折痕（u 对 x 的导数太小，线就只是各自平移，
  // 看起来像一排直尺在晃，而不是布）。
  function foldAt(base, y, t) {
    return 14.0 * Math.sin(y * 0.0110 + t * 0.30 + base * 0.0120)
         + 7.0 * Math.sin(y * 0.0190 - t * 0.42 + base * 0.0200)
         + 3.0 * Math.sin(y * 0.0350 + t * 0.65 + base * 0.0080)
         + 2.0 * Math.sin(base * 0.0038 + t * 0.15);
  }

  function draw(tSec, animate, dt) {
    ctx.clearRect(0, 0, W, H);
    ctx.lineWidth = 1;
    ctx.lineCap = 'round';

    // 指针平滑 + 速度（用于"拨动"的冲量）
    if (animate && pointer.active) {
      const prevX = pointer.x, prevY = pointer.y;
      pointer.x += (pointer.tx - pointer.x) * 0.22;
      pointer.y += (pointer.ty - pointer.y) * 0.22;
      if (dt > 0) {
        pointer.vx = (pointer.x - prevX) / dt;
        pointer.vy = (pointer.y - prevY) / dt;
      }
    }

    for (const col of cols) {
      const pts = col.pts;
      const n = pts.length;
      const base = col.base;

      // 每列一个相位：决定明暗（折痕带在缓慢横向移动）
      const band = 0.5 + 0.5 * Math.sin(base * 0.0052 + tSec * 0.22);
      const hue = 208 + Math.sin(base * 0.0031 + tSec * 0.11) * 12;
      // 明暗带：折痕隆起处亮、凹处暗 → 看起来像布料的受光面，而不是一堆等高线
      ctx.strokeStyle = 'hsla(' + hue.toFixed(0) + ', 78%, 55%, ' + (0.10 + band * 0.11).toFixed(3) + ')';

      for (let i = 0; i < n; i++) {
        const p = pts[i];
        if (!animate) {
          p.u = foldAt(base, p.y, tSec);
          continue;
        }

        // 1) 弹簧拉回折痕目标
        const target = foldAt(base, p.y, tSec);
        p.v += (target - p.u) * 52 * dt;
        // 2) 相邻点耦合：拨动会沿纤维传开（像布料波纹）
        const up = i > 0 ? pts[i - 1].u : p.u;
        const dn = i < n - 1 ? pts[i + 1].u : p.u;
        p.v += ((up + dn) * 0.5 - p.u) * 34 * dt;
        // 3) 鼠标：推开 + 沿指针运动方向带动
        if (pointer.active) {
          const px = base + p.u;
          const dx = px - pointer.x;
          const dy = p.y - pointer.y;
          const d2 = dx * dx + dy * dy;
          if (d2 < R2) {
            const d = Math.sqrt(d2) || 1;
            const f = 1 - d / R;
            const push = dx / d;
            p.v += (push * 300 * f * f + pointer.vx * 0.55 * f) * dt;
          }
        }
        // 4) 阻尼 + 积分（速度上限防止极端抖动）
        p.v *= Math.exp(-2.4 * dt);
        if (p.v > 520) p.v = 520; else if (p.v < -520) p.v = -520;
        p.u += p.v * dt;
      }

      ctx.beginPath();
      const y0 = pts[0];
      ctx.moveTo(base + y0.u, y0.y);
      for (let i = 1; i < n - 1; i++) {
        const mx = (base + pts[i].u + base + pts[i + 1].u) / 2;
        const my = (pts[i].y + pts[i + 1].y) / 2;
        ctx.quadraticCurveTo(base + pts[i].u, pts[i].y, mx, my);
      }
      const last = pts[n - 1];
      ctx.lineTo(base + last.u, last.y);
      ctx.stroke();
    }
  }

  function frame(now) {
    if (document.hidden || paused) { raf = 0; return; }
    const dt = lastNow ? Math.min(0.033, (now - lastNow) / 1000) : 0.016;
    lastNow = now;
    draw(now * 0.001, true, dt);
    raf = requestAnimationFrame(frame);
  }

  function start() {
    layout();
    lastNow = 0;
    if (paused) {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      return;
    }
    if (reduce.matches) {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      draw(0, false, 0);
      return;
    }
    if (!raf) raf = requestAnimationFrame(frame);
  }

  let resizeRaf = 0;
  window.addEventListener('resize', () => {
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => { resizeRaf = 0; start(); });
  }, { passive: true });

  window.addEventListener('pointermove', (e) => {
    pointer.active = true;
    pointer.tx = e.clientX;
    pointer.ty = e.clientY;
    if (pointer.x < -1000) { pointer.x = e.clientX; pointer.y = e.clientY; }
  }, { passive: true });
  window.addEventListener('pointerleave', () => { pointer.active = false; }, { passive: true });
  // 整页详情打开/关闭：暂停/恢复波浪 rAF（页面不透明时它完全看不见）
  document.addEventListener('detailpagechange', (e) => {
    paused = !!e.detail?.open;
    if (paused) {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
      return;
    }
    lastNow = 0;
    if (!document.hidden && !reduce.matches && !raf) raf = requestAnimationFrame(frame);
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !paused && !reduce.matches && !raf) { lastNow = 0; raf = requestAnimationFrame(frame); }
  });
  reduce.addEventListener?.('change', start);
  start();
}

