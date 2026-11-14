// sensor.js：讀感測器、校正、平滑，再用同一個介面交給 app.js。
// 沒有感測器時改用模擬資料（滑桿、按鈕），app.js 分不出資料是真的還是模擬的。
// 介面：Sensor.init(onReading, onStatus)、Sensor.start()、Sensor.useSimulation(reason)、Sensor.calibrate()、Sensor.clearCalibration()、
//      Sensor.sim.set({alpha, beta, gamma})、Sensor.sim.shake()
(function () {
  "use strict";
  const C = window.CONFIG, D2R = Math.PI / 180;
  const wrap180 = d => ((d + 540) % 360) - 180;
  const num = v => (typeof v === "number" && isFinite(v) ? v : null);

  // 旋轉矩陣：依規格 R = Rz(α)·Rx(β)·Ry(γ)，把手機座標換成地面座標
  function matrix(a, b, g) {
    const ca = Math.cos(a * D2R), sa = Math.sin(a * D2R), cb = Math.cos(b * D2R), sb = Math.sin(b * D2R), cg = Math.cos(g * D2R), sg = Math.sin(g * D2R);
    return [
      [ca * cg - sa * sb * sg, -sa * cb, ca * sg + sa * sb * cg],
      [sa * cg + ca * sb * sg, ca * cb, sa * sg - ca * sb * cg],
      [-cb * sg, sb, cb * cg]
    ];
  }
  const mulTA = (A, B) => A.map((_, i) => B[0].map((__, j) => A[0][i] * B[0][j] + A[1][i] * B[1][j] + A[2][i] * B[2][j])); // Aᵀ·B

  // 目前的原始值（事件會分開來，各自更新）
  const raw = { ax: null, ay: null, az: null, gx: null, gy: null, gz: null, ra: null, rb: null, rg: null, alpha: null, beta: null, gamma: null, heading: null };
  const sm = { alpha: 0, beta: 0, gamma: 0, accMag: 0, rotMag: 0, ready: false };
  let calib = null, mode = "idle", onReading = null, onStatus = null, gotData = false, hasOrient = false, count = 0, hz = 0, hzT = 0, rafId = 0;

  function smoothStep() {
    const k = C.smoothing;
    if (raw.beta === null) return;
    if (!sm.ready) { sm.alpha = raw.alpha || 0; sm.beta = raw.beta; sm.gamma = raw.gamma; sm.ready = true; }
    sm.alpha = (sm.alpha + k * wrap180((raw.alpha || 0) - sm.alpha) + 360) % 360; // α 跨過 0° 時不能平均成 180°
    sm.beta += k * (raw.beta - sm.beta);
    sm.gamma += k * (raw.gamma - sm.gamma);
    let acc;
    if (raw.ax !== null) acc = Math.hypot(raw.ax, raw.ay, raw.az);
    else if (raw.gx !== null) acc = Math.abs(Math.hypot(raw.gx, raw.gy, raw.gz) - 9.81); // 有些 Android 沒有去掉重力的加速度
    else acc = 0;
    sm.accMag += k * (acc - sm.accMag);
    const rot = raw.ra !== null ? Math.hypot(raw.ra, raw.rb, raw.rg) : 0;
    sm.rotMag += k * (rot - sm.rotMag);
  }
  function tick(now) {
    if (now - hzT >= 1000) { hz = Math.round(count * 1000 / (now - hzT || 1000)); count = 0; hzT = now; }
    if (sm.ready && onReading) {
      const R = matrix(sm.alpha, sm.beta, sm.gamma);
      onReading({ mode, hz, t: now, raw: { ...raw }, smooth: { ...sm }, R: calib ? mulTA(calib, R) : R });
    }
    rafId = requestAnimationFrame(tick);
  }
  function startLoop() { if (!rafId) { hzT = performance.now(); rafId = requestAnimationFrame(tick); } }

  // ---------- 真實感測器 ----------
  function onMotion(e) {
    const a = e.acceleration || {}, g = e.accelerationIncludingGravity || {}, r = e.rotationRate || {};
    raw.ax = num(a.x); raw.ay = num(a.y); raw.az = num(a.z);
    raw.gx = num(g.x); raw.gy = num(g.y); raw.gz = num(g.z);
    raw.ra = num(r.alpha); raw.rb = num(r.beta); raw.rg = num(r.gamma);
    if (raw.gx !== null || raw.ax !== null) { gotData = true; count++; }
    if (!hasOrient && raw.gx !== null) { // 只有加速度、沒有方向事件時，用重力估計 β、γ
      raw.beta = Math.atan2(raw.gy, raw.gz) / D2R; raw.gamma = Math.atan2(-raw.gx, Math.hypot(raw.gy, raw.gz)) / D2R; raw.alpha = raw.alpha || 0;
    }
    smoothStep();
  }
  function onOrient(e) {
    const b = num(e.beta), g = num(e.gamma);
    if (b === null || g === null) return;
    hasOrient = true;
    raw.alpha = num(e.alpha) ?? 0; raw.beta = b; raw.gamma = g;
    if (num(e.webkitCompassHeading) !== null) raw.heading = e.webkitCompassHeading;   // iPhone
    gotData = true;
    if (raw.ax === null && raw.gx === null) count++;
    smoothStep();
  }
  function onAbsolute(e) { if (num(e.alpha) !== null) raw.heading = (360 - e.alpha) % 360; } // Android 的方位角

  function init(readingCb, statusCb) { onReading = readingCb; onStatus = statusCb; }
  // 新版 Chrome 在電腦上也有 requestPermission，沒有感測器時會回 denied：電腦直接進模擬模式，手機才請使用者重新允許
  const isComputer = () => !(window.matchMedia && matchMedia("(any-pointer: coarse)").matches) && !(navigator.maxTouchPoints > 0);
  function denied() { if (isComputer()) useSimulation("nosensor"); else onStatus("denied"); }
  async function start() {
    const needAsk = typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function";
    if (needAsk) {
      // iPhone：一定要在這次點擊裡要權限，兩個一起要，中間不能先 await
      try {
        const rs = await Promise.all([
          DeviceMotionEvent.requestPermission(),
          typeof DeviceOrientationEvent !== "undefined" && typeof DeviceOrientationEvent.requestPermission === "function" ? DeviceOrientationEvent.requestPermission() : "granted"
        ]);
        if (rs.some(r => r !== "granted")) { denied(); return; }
      } catch (err) { denied(); return; }
    }
    if (typeof DeviceMotionEvent === "undefined" && typeof DeviceOrientationEvent === "undefined") { useSimulation("nosensor"); return; }
    mode = "sensor";
    window.addEventListener("devicemotion", onMotion);
    window.addEventListener("deviceorientation", onOrient);
    window.addEventListener("deviceorientationabsolute", onAbsolute);
    startLoop();
    onStatus("waiting");
    setTimeout(() => { if (mode !== "sensor") return; if (!gotData) useSimulation("nosensor"); else onStatus("granted"); }, C.noDataMs);
  }

  // ---------- 模擬模式 ----------
  const sim = { alpha: 0, beta: 0, gamma: 0, shakeUntil: 0, timer: 0, last: null };
  function simStep() {
    const now = performance.now(), dt = sim.last ? (now - sim.last) / 1000 : 1 / 60, prev = sim.prev || { a: null, b: null, g: null };
    sim.last = now; sim.prev = { a: sim.alpha, b: sim.beta, g: sim.gamma }; // 轉速用滑桿本身的變化算，不含雜訊
    const n = () => (Math.random() - 0.5) * 0.6; // 小雜訊，讓平滑看得出效果
    raw.alpha = (sim.alpha + n() + 360) % 360; raw.beta = sim.beta + n(); raw.gamma = sim.gamma + n();
    const R = matrix(sim.alpha, sim.beta, sim.gamma);
    raw.gx = R[2][0] * 9.81; raw.gy = R[2][1] * 9.81; raw.gz = R[2][2] * 9.81; // 重力在手機座標的分量：Rᵀ·(0,0,9.81)
    const shaking = now < sim.shakeUntil, s = () => (Math.random() - 0.5) * 2 * C.simShakePeak;
    raw.ax = shaking ? s() : n() * 0.1; raw.ay = shaking ? s() : n() * 0.1; raw.az = shaking ? s() : n() * 0.1;
    raw.ra = prev.a === null ? 0 : wrap180(sim.alpha - prev.a) / dt; raw.rb = prev.b === null ? 0 : (sim.beta - prev.b) / dt; raw.rg = prev.g === null ? 0 : (sim.gamma - prev.g) / dt;
    raw.heading = (360 - raw.alpha) % 360;
    count++;
    smoothStep();
  }
  function useSimulation(reason) {
    window.removeEventListener("devicemotion", onMotion);
    window.removeEventListener("deviceorientation", onOrient);
    window.removeEventListener("deviceorientationabsolute", onAbsolute);
    mode = "sim";
    if (!sim.timer) sim.timer = setInterval(simStep, 1000 / 60);
    startLoop();
    if (onStatus) onStatus(reason || "sim");
  }

  window.Sensor = {
    init, start, useSimulation,
    calibrate() { if (sm.ready) calib = matrix(sm.alpha, sm.beta, sm.gamma); },
    clearCalibration() { calib = null; },
    get mode() { return mode; },
    sim: {
      set(v) { for (const k of ["alpha", "beta", "gamma"]) if (k in v) sim[k] = Number(v[k]); },
      shake() { sim.shakeUntil = performance.now() + C.simShakeMs; }
    }
  };
})();
