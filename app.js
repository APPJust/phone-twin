// app.js：本題的規則和畫面。只透過 Sensor 拿數值，不直接監聽感測器事件。
(function () {
  "use strict";
  const C = window.CONFIG, $ = id => document.getElementById(id);
  const wrap180 = d => ((d + 540) % 360) - 180;
  const f1 = v => (v === null || v === undefined ? "—" : v.toFixed(1));
  document.querySelectorAll(".ver").forEach(e => { e.textContent = C.version; });

  // ---------- 音效與震動 ----------
  let ctx = null, muted = false;
  function beep(freq, ms) {
    if (muted || !ctx) return;
    const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime;
    o.type = "triangle"; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
    o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + ms / 1000 + 0.02);
  }
  function buzz(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (err) { /* iPhone 沒有震動，忽略 */ } }
  function success() { beep(880, 120); setTimeout(() => beep(1320, 160), 120); buzz(40); }

  // ---------- 開始與權限 ----------
  const STATUS = {
    waiting: ["正在等待感測器資料…", false],
    granted: ["感測器可以使用。", false],
    denied: ["沒有取得權限：可能按了「不允許」。iPhone 請把 Safari 完全關掉（從多工畫面滑掉），重新打開這個網址，按開始後選「允許」。也可以先改用模擬模式。", true],
    nosensor: ["這台裝置沒有送出感測器資料（例如電腦），已切到模擬模式。", false],
    sim: ["已切到模擬模式。", false]
  };
  function onStatus(s) {
    const [msg, bad] = STATUS[s] || ["", false];
    $("status").textContent = msg; $("status").classList.toggle("bad", bad);
    $("simBtn").hidden = s !== "denied";
    if (s === "granted" || s === "nosensor" || s === "sim") showMain();
  }
  function initAudio() {
    try { const AC = window.AudioContext || window.webkitAudioContext; if (AC && !ctx) ctx = new AC(); if (ctx && ctx.state === "suspended") ctx.resume(); } catch (err) { ctx = null; }
  }
  Sensor.init(r => onReading(r), onStatus);
  $("startBtn").addEventListener("click", () => { initAudio(); Sensor.start(); }); // 權限在這次點擊裡要
  $("simBtn").addEventListener("click", () => { initAudio(); Sensor.useSimulation("sim"); });
  function showMain() {
    $("startScreen").hidden = true; $("mainScreen").hidden = false;
    const sim = Sensor.mode === "sim";
    $("simPanel").hidden = !sim;
    $("modeTag").textContent = sim ? "模擬模式" : "感測器";
    $("modeTag").classList.toggle("sim", sim);
    sizeCanvases(); renderTour();
  }

  // ---------- 工具列 ----------
  $("calBtn").addEventListener("click", () => {
    if ($("calBtn").dataset.on) { Sensor.clearCalibration(); delete $("calBtn").dataset.on; $("calBtn").textContent = "校正"; $("calibTag").hidden = true; }
    else { Sensor.calibrate(); $("calBtn").dataset.on = "1"; $("calBtn").textContent = "取消校正"; $("calibTag").hidden = false; beep(660, 120); }
  });
  $("muteBtn").addEventListener("click", () => { muted = !muted; $("muteBtn").setAttribute("aria-pressed", String(muted)); $("muteBtn").textContent = muted ? "音效：關" : "音效：開"; });
  $("dbgBtn").addEventListener("click", () => { const open = $("debug").hidden; $("debug").hidden = !open; $("dbgBtn").setAttribute("aria-expanded", String(open)); });

  // ---------- 模擬模式的控制 ----------
  const sliders = { sA: "alpha", sB: "beta", sG: "gamma" }, outs = { sA: "oA", sB: "oB", sG: "oG" };
  Object.keys(sliders).forEach(id => {
    const el = $(id), upd = () => { Sensor.sim.set({ [sliders[id]]: el.value }); $(outs[id]).textContent = el.value + "°"; };
    el.addEventListener("input", upd); upd();
  });
  $("shakeBtn").addEventListener("click", () => Sensor.sim.shake());

  // ---------- 認識數值導覽 ----------
  const TOUR = [
    { name: "平放", ask: "把手機螢幕朝上平放在桌上。", ok: r => Math.abs(r.smooth.beta) < C.flatDeg && Math.abs(r.smooth.gamma) < C.flatDeg,
      why: "看除錯面板的「含重力加速度」：z 約 ±9.8，x、y 接近 0，因為重力全部落在 z 軸；方向的 β、γ 都接近 0°。" },
    { name: "立起", ask: "把手機立起來，螢幕朝向自己。", ok: r => r.smooth.beta > C.uprightDeg,
      why: "β 變成接近 90°：重力從 z 軸移到 y 軸，含重力加速度的 y 約 9.8。" },
    { name: "向左傾", ask: "先平放，再把手機左邊往下壓。", ok: r => r.smooth.gamma < C.tiltLeftDeg && Math.abs(r.smooth.beta) < 45,
      why: "γ 變成負的：γ 是左右傾，右邊往下是正、左邊往下是負；重力有一部分跑到 x 軸。" },
    { name: "搖一下", ask: "握緊手機，快速搖一下（電腦請按「搖一下」）。", ok: r => r.smooth.accMag > C.shakeMs2, instant: true,
      why: "「去掉重力的加速度」出現尖峰：它只看手機被推動的力道，靜止時接近 0，所以拿來偵測搖晃和敲擊。" },
    { name: "平放轉一圈", ask: "平放在桌上，原地水平轉一整圈（電腦請把 α 從 0 拉到最右邊）。", turn: true,
      why: "α 從 0° 一路走到 360° 再回到 0°；轉動時陀螺儀的轉速（rotationRate.alpha）不是 0。α 不一定對準北方，要知道方位要看指南針。" }
  ];
  let step = 0, holdStart = 0, coolUntil = 0, turnSum = 0, lastAlpha = null, lastWhy = "";
  function renderTour() {
    $("steps").innerHTML = TOUR.map((s, i) => `<li class="${i < step ? "done" : i === step ? "on" : ""}">${i + 1}. ${s.name}</li>`).join("");
    if (step >= TOUR.length) { $("tourNow").innerHTML = `<b>導覽完成</b>五個動作都看過了。打開除錯面板，自己試試看其他動作會讓哪些數字改變。<span class="why">${lastWhy}</span>`; return; }
    const s = TOUR[step];
    $("tourNow").innerHTML = `<b>${step + 1}. ${s.name}</b>${s.ask}<span class="hold"><i id="holdBar"></i></span>${lastWhy ? `<span class="why">上一步：${lastWhy}</span>` : ""}`;
  }
  $("tourRestart").addEventListener("click", () => { step = 0; holdStart = 0; turnSum = 0; lastWhy = ""; renderTour(); });
  function tourUpdate(r) {
    if (step >= TOUR.length || r.t < coolUntil) return;
    const s = TOUR[step]; let prog = 0, done = false;
    if (s.turn) {
      const flat = Math.abs(r.smooth.beta) < C.flatDeg && Math.abs(r.smooth.gamma) < C.flatDeg;
      if (flat && lastAlpha !== null) turnSum += wrap180(r.smooth.alpha - lastAlpha); else if (!flat) turnSum = 0;
      lastAlpha = r.smooth.alpha;
      prog = Math.min(1, Math.abs(turnSum) / C.turnDeg); done = prog >= 1;
    } else if (s.ok(r)) {
      if (s.instant) done = true;
      else { if (!holdStart) holdStart = r.t; prog = Math.min(1, (r.t - holdStart) / C.holdMs); done = prog >= 1; }
    } else holdStart = 0;
    const bar = $("holdBar"); if (bar) bar.style.width = (prog * 100).toFixed(0) + "%";
    if (done) {
      lastWhy = s.why; step++; holdStart = 0; turnSum = 0; coolUntil = r.t + C.cooldownMs;
      success(); renderTour();
    }
  }

  // ---------- 3D 模型 ----------
  // R 把手機座標換成地面座標；畫面座標 y 朝下，所以用 T = S·R·S（S = diag(1, −1, 1)），鏡頭從上方往下看
  function applyModel(R) {
    const T = [[R[0][0], -R[0][1], R[0][2]], [-R[1][0], R[1][1], -R[1][2]], [R[2][0], -R[2][1], R[2][2]]];
    $("model").style.transform = `matrix3d(${T[0][0]},${T[1][0]},${T[2][0]},0,${T[0][1]},${T[1][1]},${T[2][1]},0,${T[0][2]},${T[1][2]},${T[2][2]},0,0,0,0,1)`;
  }

  // ---------- 小圖表 ----------
  const hist = [];
  const cvs = ["cAcc", "cRot", "cOri"].map(id => $(id));
  function sizeCanvases() { const dpr = window.devicePixelRatio || 1; cvs.forEach(c => { c.width = Math.max(1, Math.round(c.clientWidth * dpr)); c.height = Math.round(60 * dpr); }); }
  window.addEventListener("resize", sizeCanvases);
  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function plot(c, series, min, max, now) {
    const g = c.getContext("2d"), w = c.width, h = c.height, span = C.chartSeconds * 1000;
    g.clearRect(0, 0, w, h);
    g.strokeStyle = css("--line"); g.lineWidth = 1; g.beginPath(); const y0 = h - (0 - min) / (max - min) * h; g.moveTo(0, y0); g.lineTo(w, y0); g.stroke();
    series.forEach(([key, color, width]) => {
      g.strokeStyle = color; g.lineWidth = width * (window.devicePixelRatio || 1); g.beginPath();
      hist.forEach((p, i) => { const x = w - (now - p.t) / span * w, v = Math.max(min, Math.min(max, p[key])), y = h - (v - min) / (max - min) * h; i ? g.lineTo(x, y) : g.moveTo(x, y); });
      g.stroke();
    });
  }

  // ---------- 除錯面板 ----------
  function debugRows(r) {
    const R = r.raw, S = r.smooth;
    return [
      ["模式", r.mode === "sim" ? "模擬" : "感測器", ""], ["更新頻率", r.hz + " Hz", ""],
      ["加速度 x / y / z（去掉重力）", `${f1(R.ax)} / ${f1(R.ay)} / ${f1(R.az)}`, "m/s²"],
      ["含重力加速度 x / y / z", `${f1(R.gx)} / ${f1(R.gy)} / ${f1(R.gz)}`, "m/s²"],
      ["轉速 α / β / γ", `${f1(R.ra)} / ${f1(R.rb)} / ${f1(R.rg)}`, "°/s"],
      ["方向 α / β / γ（原始）", `${f1(R.alpha)} / ${f1(R.beta)} / ${f1(R.gamma)}`, "°"],
      ["方向 α / β / γ（平滑後）", `${f1(S.alpha)} / ${f1(S.beta)} / ${f1(S.gamma)}`, "°"],
      ["加速度大小（平滑後）", f1(S.accMag), "m/s²"], ["轉速大小（平滑後）", f1(S.rotMag), "°/s"],
      ["方位角（指南針）", f1(R.heading), "°"]
    ].map(([a, b, u]) => `<tr><td>${a}</td><td>${b}</td><td>${u}</td></tr>`).join("");
  }

  // ---------- 每一幀 ----------
  let lastDraw = 0;
  function onReading(r) {
    applyModel(r.R);
    tourUpdate(r);
    hist.push({ t: r.t, acc: r.smooth.accMag, rot: r.smooth.rotMag, beta: r.smooth.beta, gamma: r.smooth.gamma });
    while (hist.length && r.t - hist[0].t > C.chartSeconds * 1000) hist.shift();
    if (r.t - lastDraw < 50) return; // 數字和圖表每秒更新 20 次就夠了
    lastDraw = r.t;
    $("vAcc").textContent = r.smooth.accMag.toFixed(1);
    $("vRot").textContent = Math.round(r.smooth.rotMag);
    $("vOri").textContent = `β ${Math.round(r.smooth.beta)}°　γ ${Math.round(r.smooth.gamma)}°`;
    $("vAlpha").textContent = Math.round(r.smooth.alpha) + "°";
    $("vHead").textContent = r.raw.heading === null ? "—" : Math.round(r.raw.heading) + "°";
    plot(cvs[0], [["acc", css("--z"), 2]], 0, 25, r.t);
    plot(cvs[1], [["rot", css("--accent"), 2]], 0, 400, r.t);
    plot(cvs[2], [["beta", css("--y"), 2], ["gamma", css("--x"), 2]], -180, 180, r.t);
    if (!$("debug").hidden) $("dbgBody").innerHTML = debugRows(r);
  }
})();
