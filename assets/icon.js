/*!
 * 时之交响 TimeSymphony — 图标动画引擎
 *
 * 两档画质共用同一套绘制逻辑，只在两处不同：
 *   hd     「高清」  1314 颗粒子 + 逐粒子高斯发光（ctx.shadowBlur）
 *   smooth 「流畅」   950 颗粒子 + 预渲染位图发光（径向渐变精灵，成本降到 drawImage）
 *
 * 其余元素（光弧 / 刻度 / 内轨网格 / 三根指针 / 声波频带 / 弧缘溅射 / 中心光点）完全一致。
 * 无构建步骤、无外链、file:// 直接打开即可跑。
 */
(function (global) {
  'use strict';

  var TAU = Math.PI * 2;

  var QUALITY = {
    hd: {
      label: '高清',
      hint: '1314 颗粒子 · 逐粒子高斯发光',
      orbiters: 1314,
      glow: 'blur'
    },
    smooth: {
      label: '流畅',
      hint: '950 颗粒子 · 位图发光',
      orbiters: 950,
      glow: 'sprite'
    }
  };

  var DEFAULT_QUALITY = 'smooth';

  var DUST_COUNT = 150;
  var EQ_BARS = 26;
  var SPARK_COUNT = 70;
  var STREAK_COUNT = 26;

  /* 色调 0..1 映射到 青 / 紫 / 金 / 白 四档 */
  var TONE_BANDS = [
    { limit: 0.45, rgb: '126,249,255' },
    { limit: 0.80, rgb: '181,123,255' },
    { limit: 0.93, rgb: '255,211,110' },
    { limit: 1.01, rgb: '255,255,255' }
  ];

  function toneRgba(tone, alpha) {
    for (var i = 0; i < TONE_BANDS.length; i++) {
      if (tone < TONE_BANDS[i].limit) return 'rgba(' + TONE_BANDS[i].rgb + ',' + alpha + ')';
    }
    return 'rgba(255,255,255,' + alpha + ')';
  }

  function makeGlowSprite(rgb) {
    var S = 64;
    var c = document.createElement('canvas');
    c.width = S;
    c.height = S;
    var g = c.getContext('2d');
    var half = S / 2;
    var grad = g.createRadialGradient(half, half, 0, half, half, half);
    grad.addColorStop(0, 'rgba(' + rgb + ',1)');
    grad.addColorStop(0.25, 'rgba(' + rgb + ',0.45)');
    grad.addColorStop(0.55, 'rgba(' + rgb + ',0.12)');
    grad.addColorStop(1, 'rgba(' + rgb + ',0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
    return c;
  }

  function create(canvas, options) {
    options = options || {};

    var ctx = canvas.getContext('2d');
    var stage = options.stage || canvas.parentElement || canvas;

    var qualityKey = QUALITY[options.quality] ? options.quality : DEFAULT_QUALITY;
    var tier = QUALITY[qualityKey];
    var isSprite = tier.glow === 'sprite';

    var size = 0;
    var dpr = Math.min(global.devicePixelRatio || 1, 2);

    var sprites = null;

    var dust = [];
    var orbiters = [];
    var eqBars = [];
    var sparks = [];
    var streaks = [];
    var arcs = [];
    var ticks = [];

    var startTime = 0;
    var rafId = 0;
    var destroyed = false;

    function cx() { return size / 2; }
    function cy() { return size / 2; }
    function R() { return size * 0.42; }

    /* ---------------- 发光原语 ---------------- */

    function drawGlow(x, y, radius, sprite, alpha) {
      if (radius <= 0 || alpha <= 0) return;
      ctx.globalAlpha = alpha > 1 ? 1 : alpha;
      ctx.drawImage(sprite, x - radius, y - radius, radius * 2, radius * 2);
      ctx.globalAlpha = 1;
    }

    function spriteFor(tone) {
      for (var i = 0; i < TONE_BANDS.length; i++) {
        if (tone < TONE_BANDS[i].limit) return sprites[TONE_BANDS[i].rgb];
      }
      return sprites['255,255,255'];
    }

    /*
     * 画一颗发光尘点。两档走不同实现：
     *   blur   —— 实心圆 + 高斯阴影，core 为半径
     *   sprite —— 直接把预渲染精灵按 glow 半径缩放贴上去
     */
    function dot(x, y, core, glow, tone, alpha, shadow, spriteAlphaScale) {
      if (isSprite) {
        drawGlow(x, y, glow, spriteFor(tone), alpha * (spriteAlphaScale || 0.9));
        return;
      }
      ctx.beginPath();
      ctx.arc(x, y, core, 0, TAU);
      ctx.fillStyle = toneRgba(tone, alpha);
      ctx.shadowBlur = shadow;
      ctx.shadowColor = ctx.fillStyle;
      ctx.fill();
    }

    /* ---------------- 静态骨架 ---------------- */

    var HANDS = [
      { ratio: 0.50, speed: 1 / 4500, phase: 0, color: '#7ef9ff', width: 1.6 }, // 时针
      { ratio: 0.72, speed: 1 / 1800, phase: 2.1, color: '#b57bff', width: 1.3 }, // 分针
      { ratio: 0.88, speed: 1 / 600, phase: 4.2, color: '#ffd36e', width: 1.0 }  // 秒针
    ];

    var ARCS = [
      { r: 0.70, color: 'rgba(126,249,255,0.75)', width: 1.4, speed: 0.00010, phase: 0, span: 1.15, glow: 22 },
      { r: 0.82, color: 'rgba(181,123,255,0.65)', width: 1.2, speed: -0.00016, phase: 2.1, span: 1.55, glow: 20 },
      { r: 0.94, color: 'rgba(255,211,110,0.55)', width: 1.0, speed: 0.00008, phase: 4.0, span: 0.95, glow: 18 },
      { r: 0.88, color: 'rgba(126,249,255,0.45)', width: 0.8, speed: -0.00006, phase: 1.0, span: 2.2, glow: 14 },
      { r: 0.76, color: 'rgba(181,123,255,0.40)', width: 0.7, speed: 0.00013, phase: 5.2, span: 1.7, glow: 14 },
      { r: 1.02, color: 'rgba(126,249,255,0.28)', width: 0.6, speed: -0.00005, phase: 3.0, span: 2.6, glow: 12 },
      { r: 0.98, color: 'rgba(255,211,110,0.22)', width: 0.5, speed: 0.00007, phase: 0.6, span: 2.0, glow: 10 },
      { r: 0.66, color: 'rgba(126,249,255,0.30)', width: 0.6, speed: -0.00009, phase: 4.6, span: 1.3, glow: 12 },
      { r: 1.06, color: 'rgba(181,123,255,0.18)', width: 0.5, speed: 0.00004, phase: 2.6, span: 2.9, glow: 8 }
    ];

    var INNER_GRID = [0.52, 0.58, 0.64];

    /*
     * 所有粒子尺寸都以 R() 的比例存储（frac），绘制时才乘回当前 R()。
     * 原始两版把绝对像素存进粒子对象，窗口缩放后粒子半径不再跟随 —— 这里改掉。
     */
    function randomSign() { return Math.random() < 0.5 ? -1 : 1; }

    function buildTicks() {
      ticks = [];
      for (var i = 0; i < 60; i++) {
        ticks.push({
          angle: (i / 60) * TAU,
          inner: 0.64,
          outer: i % 5 === 0 ? 0.78 : 0.73,
          alpha: i % 5 === 0 ? 0.62 : 0.30
        });
      }
    }

    function buildDust() {
      dust = [];
      for (var i = 0; i < DUST_COUNT; i++) {
        dust.push({
          angle: Math.random() * TAU,
          frac: 0.52 + Math.random() * 0.22,
          size: 0.4 + Math.random() * 1.1,
          speed: randomSign() * (0.0002 + Math.random() * 0.0004),
          alpha: 0.15 + Math.random() * 0.45,
          tw: Math.random() * TAU,
          twSpeed: 0.002 + Math.random() * 0.004,
          tone: Math.random()
        });
      }
    }

    function buildOrbiters() {
      orbiters = [];
      var n = tier.orbiters;
      for (var i = 0; i < n; i++) {
        var angle = Math.random() * TAU;
        var frac = 0.72 + Math.random() * 0.34;
        orbiters.push({
          angle: angle,
          frac: frac,
          x: cx() + Math.cos(angle) * R() * frac,
          y: cy() + Math.sin(angle) * R() * frac,
          vx: 0,
          vy: 0,
          drift: randomSign() * (0.0008 + Math.random() * 0.0018),
          wob: Math.random() * TAU,
          size: 0.3 + Math.random() * 0.55,
          alpha: 0.22 + Math.random() * 0.38,
          tone: Math.random(),
          tw: Math.random() * TAU,
          grabbed: 0
        });
      }
    }

    var eqPhase = [];

    function buildEqBars() {
      eqBars = [];
      for (var s = 0; s < 2; s++) {
        for (var i = 0; i < EQ_BARS; i++) {
          eqBars.push({
            side: s, // 0=左 1=右
            idx: i,
            base: 0.25 + Math.random() * 0.4,
            speed: 0.003 + Math.random() * 0.005,
            phase: Math.random() * TAU,
            particles: []
          });
        }
      }
      eqPhase = [Math.random() * TAU, Math.random() * TAU];
      eqBars.forEach(function (bar) {
        var n = 5 + Math.floor(Math.random() * 4);
        for (var i = 0; i < n; i++) {
          bar.particles.push({
            off: Math.random() * TAU,
            offSpeed: 0.004 + Math.random() * 0.006,
            size: 0.5 + Math.random() * 1.0,
            alpha: 0.3 + Math.random() * 0.6,
            jitter: Math.random() * TAU
          });
        }
      });
    }

    function resetSpark(p, atEdge) {
      var arc = Math.random() < 0.5 ? 0 : 1;
      p.arc = arc;
      p.angle = (arc === 0 ? 0.35 : 3.5) + (Math.random() - 0.5) * 1.6;
      p.radius = R() * (0.92 + Math.random() * 0.30);
      p.x = cx() + Math.cos(p.angle) * p.radius;
      p.y = cy() + Math.sin(p.angle) * p.radius;
      var spread = 0.25 + Math.random() * 0.9;
      p.vx = Math.cos(p.angle + (Math.random() - 0.5) * 2.4) * spread;
      p.vy = Math.sin(p.angle + (Math.random() - 0.5) * 2.4) * spread * 0.7;
      p.life = 0;
      p.maxLife = 40 + Math.random() * 90;
      p.size = 0.5 + Math.random() * 1.6;
      p.tone = Math.random();
      if (atEdge) p.life = Math.random() * p.maxLife * 0.5;
    }

    function buildSparks() {
      sparks = [];
      for (var i = 0; i < SPARK_COUNT; i++) {
        var p = {};
        resetSpark(p, true);
        sparks.push(p);
      }
    }

    function resetStreak(s, atEdge) {
      var arc = Math.random() < 0.5 ? 0 : 1;
      s.arc = arc;
      s.angle = (arc === 0 ? 0.35 : 3.5) + (Math.random() - 0.5) * 1.4;
      s.radius = R() * (0.96 + Math.random() * 0.22);
      s.x = cx() + Math.cos(s.angle) * s.radius;
      s.y = cy() + Math.sin(s.angle) * s.radius;
      var spread = 0.5 + Math.random() * 1.4;
      var dir = s.angle + (Math.random() - 0.5) * 1.8;
      s.vx = Math.cos(dir) * spread;
      s.vy = Math.sin(dir) * spread * 0.55;
      s.life = 0;
      s.maxLife = 30 + Math.random() * 70;
      s.tone = Math.random();
      s.width = 0.4 + Math.random() * 0.8;
      if (atEdge) s.life = Math.random() * s.maxLife * 0.5;
    }

    function buildStreaks() {
      streaks = [];
      for (var i = 0; i < STREAK_COUNT; i++) {
        var s = {};
        resetStreak(s, true);
        streaks.push(s);
      }
    }

    function buildAll() {
      buildTicks();
      buildDust();
      buildOrbiters();
      buildEqBars();
      buildSparks();
      buildStreaks();
    }

    /* ---------------- 尺寸 ---------------- */

    function resize() {
      var rect = stage.getBoundingClientRect();
      var next = Math.floor(rect.width) || 260;
      if (next === size) return;
      size = next;
      dpr = Math.min(global.devicePixelRatio || 1, 2);
      canvas.width = size * dpr;
      canvas.height = size * dpr;
      canvas.style.width = size + 'px';
      canvas.style.height = size + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    /* ---------------- 主循环 ---------------- */

    function draw(now) {
      if (destroyed) return;
      var t = now - startTime;

      ctx.clearRect(0, 0, size, size);

      // 中心暗晕
      var bg = ctx.createRadialGradient(cx(), cy(), size * 0.1, cx(), cy(), size * 0.45);
      bg.addColorStop(0, 'rgba(20,26,68,0.45)');
      bg.addColorStop(1, 'rgba(5,7,15,0)');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, size, size);

      // 旋转光弧
      for (var a = 0; a < ARCS.length; a++) {
        var arc = ARCS[a];
        var rot = t * arc.speed + arc.phase;
        var half = arc.span / 2;
        ctx.save();
        ctx.translate(cx(), cy());
        ctx.rotate(rot);
        ctx.beginPath();
        ctx.arc(0, 0, R() * arc.r, -half, half);
        ctx.strokeStyle = arc.color;
        ctx.lineWidth = arc.width;
        ctx.shadowBlur = arc.glow;
        ctx.shadowColor = arc.color;
        ctx.stroke();
        ctx.restore();
      }

      // 内轨细网格（先清掉光弧留下的发光态）
      ctx.shadowBlur = 0;
      ctx.save();
      ctx.translate(cx(), cy());
      for (var g = 0; g < INNER_GRID.length; g++) {
        ctx.beginPath();
        ctx.arc(0, 0, R() * INNER_GRID[g], 0, TAU);
        ctx.strokeStyle = 'rgba(126,249,255,' + (0.08 + g * 0.03) + ')';
        ctx.lineWidth = 0.5;
        ctx.stroke();
      }
      ctx.restore();

      // 时间刻度
      ctx.save();
      ctx.translate(cx(), cy());
      for (var k = 0; k < ticks.length; k++) {
        var tick = ticks[k];
        ctx.beginPath();
        ctx.moveTo(Math.cos(tick.angle) * R() * tick.inner, Math.sin(tick.angle) * R() * tick.inner);
        ctx.lineTo(Math.cos(tick.angle) * R() * tick.outer, Math.sin(tick.angle) * R() * tick.outer);
        ctx.strokeStyle = 'rgba(255,255,255,' + tick.alpha + ')';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.restore();

      // 三根指针
      var ends = [];
      for (var h = 0; h < HANDS.length; h++) {
        var hand = HANDS[h];
        var hAngle = t * hand.speed + hand.phase;
        var hLen = R() * hand.ratio;
        var ex = cx() + Math.cos(hAngle) * hLen;
        var ey = cy() + Math.sin(hAngle) * hLen;
        ends.push({ x: ex, y: ey, color: hand.color });

        ctx.save();
        ctx.beginPath();
        ctx.moveTo(cx(), cy());
        ctx.lineTo(ex, ey);
        ctx.strokeStyle = hand.color;
        ctx.lineWidth = hand.width;
        ctx.shadowBlur = 20;
        ctx.shadowColor = hand.color;
        ctx.stroke();
        ctx.restore();
      }

      // 1) 内轨闪尘
      for (var d = 0; d < dust.length; d++) {
        var p = dust[d];
        p.angle += p.speed;
        p.tw += p.twSpeed;
        var dr = p.frac * R();
        var px = cx() + Math.cos(p.angle) * dr;
        var py = cy() + Math.sin(p.angle) * dr;
        var da = p.alpha * (0.55 + 0.45 * Math.sin(p.tw));
        dot(px, py, p.size, p.size * 2.6, p.tone, da, 6, 0.85);
      }

      // 2) 环绕游走粒子：离哪根指针近就被哪根吸
      //    三针作用半径一致，只按距离衰减 —— 按时针长度缩放会让短针粘死、长针够不着。
      var ATTRACT_RANGE = R() * 0.40;
      var ATTRACT_FORCE = 0.25;

      for (var o = 0; o < orbiters.length; o++) {
        var q = orbiters[o];
        q.angle += q.drift;
        q.frac += Math.sin(t * 0.0006 + q.wob) * 0.0014;

        var baseX = cx() + Math.cos(q.angle) * q.frac * R();
        var baseY = cy() + Math.sin(q.angle) * q.frac * R();

        var best = null;
        var bestD = Infinity;
        for (var e = 0; e < ends.length; e++) {
          var dxA = ends[e].x - q.x;
          var dyA = ends[e].y - q.y;
          var dist = Math.sqrt(dxA * dxA + dyA * dyA);
          if (dist < bestD) { bestD = dist; best = ends[e]; }
        }

        if (best && bestD < ATTRACT_RANGE) {
          var kk = 1 - bestD / ATTRACT_RANGE;
          var pull = ATTRACT_FORCE * kk * kk;
          q.vx += ((best.x - q.x) / (bestD + 1)) * pull;
          q.vy += ((best.y - q.y) / (bestD + 1)) * pull;
          q.grabbed = Math.min(1, q.grabbed + 0.10);
        } else {
          q.grabbed *= 0.90;
        }

        // 回正力：防止粘在指针上不走
        q.vx += (baseX - q.x) * 0.012;
        q.vy += (baseY - q.y) * 0.012;
        q.vx *= 0.88;
        q.vy *= 0.88;
        q.x += q.vx;
        q.y += q.vy;

        var grab = q.grabbed;
        var qSize = q.size * (1 + grab * 0.8);
        var qa = q.alpha * (0.55 + 0.45 * Math.sin(q.tw + t * 0.003)) * (1 + grab * 1.1);
        q.tw += 0.01;

        var grabbed = grab > 0.4;
        dot(q.x, q.y, qSize, qSize * (2.4 + grab * 1.6), grabbed ? 0.1 : q.tone, Math.min(0.9, qa), 4 + grab * 8, 0.9);

        if (grab > 0.3) {
          ctx.beginPath();
          ctx.moveTo(q.x - q.vx * 1.8, q.y - q.vy * 1.8);
          ctx.lineTo(q.x, q.y);
          ctx.strokeStyle = 'rgba(126,249,255,' + grab * 0.35 + ')';
          ctx.lineWidth = qSize * 0.6;
          ctx.stroke();
        }
      }

      // 3) 声波粒子带
      ctx.save();
      ctx.strokeStyle = 'rgba(126,249,255,0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx() - R() * 1.05, cy());
      ctx.lineTo(cx() + R() * 1.05, cy());
      ctx.stroke();
      ctx.restore();

      for (var b = 0; b < eqBars.length; b++) {
        var bar = eqBars[b];
        var dir = bar.side === 0 ? -1 : 1;
        var fracPos = 0.28 + (bar.idx / (EQ_BARS - 1)) * 0.70;
        var baseX2 = cx() + dir * R() * fracPos;
        var hh = bar.base * (0.55
          + 0.25 * Math.sin(t * bar.speed + bar.phase)
          + 0.20 * Math.sin(t * bar.speed * 1.7 + bar.phase * 1.3 + eqPhase[bar.side]));
        var barH = hh * R() * 0.42;

        ctx.shadowBlur = 0;
        ctx.beginPath();
        ctx.moveTo(baseX2, cy() - barH);
        ctx.lineTo(baseX2, cy() + barH);
        ctx.strokeStyle = 'rgba(126,249,255,' + (0.10 + hh * 0.22) + ')';
        ctx.lineWidth = 1;
        ctx.stroke();

        for (var pi = 0; pi < bar.particles.length; pi++) {
          var pt = bar.particles[pi];
          pt.off += pt.offSpeed;
          pt.jitter += 0.02;
          var spreadF = Math.sin(pt.off) * 0.5 + 0.5;
          var pty = cy() + Math.sin(pt.off) * barH * (0.4 + spreadF * 0.6) + Math.sin(pt.jitter) * 1.2;
          var ptx = baseX2 + Math.sin(pt.jitter * 0.7) * 1.6;
          var pta = pt.alpha * (0.4 + 0.6 * spreadF);
          dot(ptx, pty, pt.size, pt.size * 2.4, bar.side === 0 ? 0.2 : 0.6, pta, 5, 0.85);
        }
      }

      // 4) 弧缘溅射：闪尘
      for (var sp = 0; sp < sparks.length; sp++) {
        var s = sparks[sp];
        s.life += 1;
        if (s.life > s.maxLife) { resetSpark(s, false); continue; }
        var sk = 1 - s.life / s.maxLife;
        s.x += s.vx;
        s.y += s.vy;
        s.vx *= 0.975;
        s.vy *= 0.975;
        var sdx = s.x - cx();
        var sdy = s.y - cy();
        var sd = Math.sqrt(sdx * sdx + sdy * sdy) + 1;
        s.vx += (sdx / sd) * 0.012;
        s.vy += (sdy / sd) * 0.012;

        var sa = 0.75 * sk * sk;
        var sTone = s.arc === 0 ? (s.tone < 0.5 ? 0.15 : 0.55) : (s.tone < 0.5 ? 0.55 : 0.75);
        var sCore = s.size * (0.5 + 0.5 * sk);
        dot(s.x, s.y, sCore, sCore * 2.8, sTone, sa, 8, 0.9);
      }

      // 4) 弧缘溅射：细丝拖尾
      for (var st = 0; st < streaks.length; st++) {
        var r = streaks[st];
        r.life += 1;
        if (r.life > r.maxLife) { resetStreak(r, false); continue; }
        var rk = 1 - r.life / r.maxLife;
        var lx = r.x;
        var ly = r.y;
        r.x += r.vx;
        r.y += r.vy;
        r.vx *= 0.982;
        r.vy *= 0.982;

        ctx.beginPath();
        ctx.moveTo(lx, ly);
        ctx.lineTo(r.x, r.y);
        ctx.strokeStyle = toneRgba(r.arc === 0 ? 0.2 : 0.7, 0.55 * rk);
        ctx.lineWidth = r.width * rk;
        if (!isSprite) {
          ctx.shadowBlur = 6;
          ctx.shadowColor = ctx.strokeStyle;
        }
        ctx.stroke();
        if (!isSprite) ctx.shadowBlur = 0;
      }

      // 中心光点
      ctx.save();
      var pulse = 0.85 + 0.15 * Math.sin(t * 0.004);
      var glow = ctx.createRadialGradient(cx(), cy(), 0, cx(), cy(), 14 * pulse);
      glow.addColorStop(0, 'rgba(255,255,255,1)');
      glow.addColorStop(0.35, 'rgba(126,249,255,0.9)');
      glow.addColorStop(0.7, 'rgba(181,123,255,0.5)');
      glow.addColorStop(1, 'rgba(181,123,255,0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cx(), cy(), 14 * pulse, 0, TAU);
      ctx.fill();

      ctx.beginPath();
      ctx.arc(cx(), cy(), 2.2, 0, TAU);
      ctx.fillStyle = '#ffffff';
      ctx.shadowBlur = 25;
      ctx.shadowColor = '#7ef9ff';
      ctx.fill();
      ctx.restore();

      rafId = global.requestAnimationFrame(draw);
    }

    /* ---------------- 对外 ---------------- */

    function setQuality(key) {
      if (!QUALITY[key] || key === qualityKey) return qualityKey;
      qualityKey = key;
      tier = QUALITY[key];
      isSprite = tier.glow === 'sprite';
      buildOrbiters();
      return qualityKey;
    }

    function destroy() {
      destroyed = true;
      if (rafId) global.cancelAnimationFrame(rafId);
      rafId = 0;
      global.removeEventListener('resize', onResize);
    }

    function onResize() {
      resize();
    }

    sprites = {};
    for (var i = 0; i < TONE_BANDS.length; i++) {
      if (!sprites[TONE_BANDS[i].rgb]) sprites[TONE_BANDS[i].rgb] = makeGlowSprite(TONE_BANDS[i].rgb);
    }

    resize();
    buildAll();
    startTime = global.performance ? performance.now() : Date.now();
    global.addEventListener('resize', onResize);
    rafId = global.requestAnimationFrame(draw);

    return {
      setQuality: setQuality,
      destroy: destroy,
      get quality() { return qualityKey; },
      get isSprite() { return isSprite; }
    };
  }

  global.TimeSymphonyIcon = {
    create: create,
    QUALITY: QUALITY,
    DEFAULT_QUALITY: DEFAULT_QUALITY
  };
})(typeof window !== 'undefined' ? window : globalThis);
