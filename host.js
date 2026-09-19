import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  getDatabase, ref, get, set, update, onValue, onChildAdded, onChildChanged
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';

const app = initializeApp(firebaseConfig, 'host-control');
const auth = getAuth(app);
const db = getDatabase(app);
const $ = id => document.getElementById(id);
const token = new URLSearchParams(location.search).get('t');

const DEFAULT_GAME_SECONDS = 60;
const DEFAULT_TARGET_SECONDS = 8;
const DEFAULT_RATIONAL_COUNT = 8;
const DEFAULT_IRRATIONAL_COUNT = 8;
const HIT_RADIUS_PX = 58;

let gameDurationSeconds = DEFAULT_GAME_SECONDS;
let targetLifetimeMs = DEFAULT_TARGET_SECONDS * 1000;
let rationalTargetCount = DEFAULT_RATIONAL_COUNT;
let irrationalTargetCount = DEFAULT_IRRATIONAL_COUNT;
let visualTheme = 'classic';

function buildRationalPool() {
  const out = [];
  const seen = new Set();
  const add = value => {
    if (!seen.has(value)) { seen.add(value); out.push(value); }
  };
  // 固定 200 個有理數題目；完全平方根最大限制為 √1024 = √(32²)。
  for (let n = -20; n <= 19; n++) add(String(n).replace('-', '−'));           // 40
  for (let n = 20; n <= 69; n++) add(`${n}.25`);                              // +50 = 90
  for (let n = 2; n <= 41; n++) add(`1/${n}`);                                // +40 = 130
  for (let n = 2; n <= 32; n++) add(`√${n * n}`);                             // +31 = 161，最大 √1024
  for (let n = 1; n <= 20; n++) add(`−${n}/${n + 1}`);                        // +20 = 181
  for (let n = 1; n <= 19; n++) {                                             // +19 = 200
    const pair = String(n).padStart(2, '0');
    add(`2.${pair}${pair}${pair}…`);
  }
  return out.slice(0, 200);
}

function buildIrrationalPool() {
  const out = [];
  const nonSquares = [];
  for (let n = 2; nonSquares.length < 160; n++) {
    if (!Number.isInteger(Math.sqrt(n))) nonSquares.push(n);
  }
  for (let i = 0; i < 100; i++) out.push(`√${nonSquares[i]}`);
  for (let i = 100; i < 140; i++) out.push(`${i - 99}+√${nonSquares[i]}`);
  for (let k = 1; k <= 20; k++) out.push(k === 1 ? 'π+1' : `π+${k}`);
  for (let k = 1; k <= 20; k++) out.push(k === 1 ? 'e+1' : `e+${k}`);
  for (let i = 140; i < 160; i++) out.push(`√${nonSquares[i]}/2`);
  return out.slice(0, 200);
}

const rationalPool = buildRationalPool();
const irrationalPool = buildIrrationalPool();
let rationalBag = [];
let irrationalBag = [];

let pass = null;
let roomCode = null;
let hostUid = null;
let players = {};
let activePlayers = {};
let scores = {};
let aims = {};
let targets = new Map();
let round = {
  status: 'waiting', roundId: null, startedAt: 0, endsAt: 0, remainingMs: DEFAULT_GAME_SECONDS * 1000
};
let engineTimer = null;
let uiTimer = null;
let shotSeqSeen = new Map();
let hitTargetsByPlayer = new Map();

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function safeText(s) { return String(s ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function setFatal(type, text) { $('fatalNotice').className = `notice ${type} host-connection-notice`; $('fatalNotice').textContent = text; }
function activeHostPath() { return `roomHosts/${roomCode}/${hostUid}`; }
function isPlayerActive(uid) { return activePlayers[uid] === true; }
function activePlayerCount() { return Object.keys(players).filter(uid => isPlayerActive(uid)).length; }

function shuffle(array) {
  const a = [...array];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function drawLabel(kind) {
  const pool = kind === 'rational' ? rationalPool : irrationalPool;
  let bag = kind === 'rational' ? rationalBag : irrationalBag;
  if (!bag.length) bag = shuffle(pool);
  const activeLabels = new Set(Array.from(targets.values()).map(t => t.label));
  let chosen = null;
  for (let i = 0; i < pool.length; i++) {
    const candidate = bag.shift();
    if (!activeLabels.has(candidate)) { chosen = candidate; break; }
    bag.push(candidate);
  }
  if (!chosen) chosen = pool[randInt(0, pool.length - 1)];
  if (kind === 'rational') rationalBag = bag;
  else irrationalBag = bag;
  return chosen;
}

async function boot() {
  try {
    if (!token) throw new Error('網址中沒有教師控制通行證。');
    const cred = await signInAnonymously(auth);
    hostUid = cred.user.uid;
    const passSnap = await get(ref(db, `hostPasses/${token}`));
    if (!passSnap.exists()) throw new Error('教師控制連結不存在、已關閉或已到期。');
    pass = passSnap.val();
    roomCode = pass.roomCode;

    await set(ref(db, activeHostPath()), { hostToken: token, joinedAt: Date.now() });

    $('gameTitle').textContent = pass.gameName;
    $('roomCode').textContent = roomCode;
    $('qrRoomCode').textContent = roomCode;
    $('hostStatus').textContent = '控制連線有效';
    $('hostGame').classList.remove('hidden');
    setFatal('ok', '教師控制端已連線。');

    initGameSettings();
    await setupStudentQr();
    bindControls();
    subscribePlayers();
    subscribeActivePlayers();
    subscribeScores();
    subscribeAims();
    subscribeShots();
    subscribePassValidity();
    subscribeGameState();
    startUiClock();
  } catch (err) {
    setFatal('error', err?.message || '無法開啟教師控制頁。');
  }
}

function initGameSettings() {
  const lifetimeSelect = $('targetLifetimeSelect');
  lifetimeSelect.replaceChildren();
  for (let sec = 1; sec <= 15; sec++) {
    const opt = document.createElement('option');
    opt.value = String(sec);
    opt.textContent = `${sec} 秒`;
    if (sec === DEFAULT_TARGET_SECONDS) opt.selected = true;
    lifetimeSelect.appendChild(opt);
  }
  for (const id of ['rationalCountSelect','irrationalCountSelect']) {
    const select = $(id);
    select.replaceChildren();
    for (let count = 3; count <= 10; count++) {
      const opt = document.createElement('option');
      opt.value = String(count);
      opt.textContent = `${count} 個`;
      if (count === 8) opt.selected = true;
      select.appendChild(opt);
    }
  }
  $('gameDurationSelect').value = String(DEFAULT_GAME_SECONDS);
  try { visualTheme = localStorage.getItem('classroomGameVisualTheme') === 'tech' ? 'tech' : 'classic'; } catch {}
  $('themeSelect').value = visualTheme;
  applyVisualTheme();
  applySelectedSettings();
  ['gameDurationSelect','targetLifetimeSelect','rationalCountSelect','irrationalCountSelect']
    .forEach(id => $(id).addEventListener('change', applySelectedSettings));
  $('themeSelect').addEventListener('change', () => {
    visualTheme = $('themeSelect').value === 'tech' ? 'tech' : 'classic';
    try { localStorage.setItem('classroomGameVisualTheme', visualTheme); } catch {}
    applyVisualTheme();
  });
}

function applyVisualTheme() {
  $('gameStage').classList.toggle('theme-tech', visualTheme === 'tech');
}

function applySelectedSettings() {
  const sec = Number($('gameDurationSelect').value);
  const life = Number($('targetLifetimeSelect').value);
  const rCount = Number($('rationalCountSelect').value);
  const iCount = Number($('irrationalCountSelect').value);
  if ([60,90,120,150].includes(sec)) gameDurationSeconds = sec;
  if (Number.isFinite(life) && life >= 1 && life <= 15) targetLifetimeMs = life * 1000;
  if (Number.isInteger(rCount) && rCount >= 3 && rCount <= 10) rationalTargetCount = rCount;
  if (Number.isInteger(iCount) && iCount >= 3 && iCount <= 10) irrationalTargetCount = iCount;
  if (round.status === 'waiting' || round.status === 'finished') {
    round.remainingMs = gameDurationSeconds * 1000;
    $('timer').textContent = String(gameDurationSeconds);
  }
  $('startBtn').textContent = `開始 ${gameDurationSeconds} 秒`;
  $('gameRuleSummary').textContent = `停留 ${Math.round(targetLifetimeMs/1000)} 秒｜有理數 ${rationalTargetCount} 個｜無理數 ${irrationalTargetCount} 個｜${gameDurationSeconds} 秒挑戰`;
}

async function setupStudentQr() {
  const qrBtn = $('qrBtn');
  const hint = $('qrHint');
  let joinToken = pass?.joinToken || null;
  if (!joinToken) {
    try {
      const roomSnap = await get(ref(db, `rooms/${roomCode}`));
      joinToken = roomSnap.val()?.joinToken || null;
    } catch {}
  }
  if (!joinToken) {
    qrBtn.disabled = true;
    hint.textContent = '此房間尚未取得學生通行證。請管理員重新整理管理中心一次，或建立新房間。';
    return;
  }
  const joinUrl = new URL('./join.html', window.location.href);
  joinUrl.search = '';
  joinUrl.searchParams.set('t', joinToken);
  $('studentJoinUrl').value = joinUrl.href;
  const qrBox = $('hostQr');
  qrBox.replaceChildren();
  if (window.QRCode) new QRCode(qrBox, { text: joinUrl.href, width: 250, height: 250 });
}

function bindControls() {
  $('startBtn').addEventListener('click', () => startRound(false));
  $('restartBtn').addEventListener('click', () => {
    if (confirm(`確定重新開始？所有已加入學生分數會歸零，並重新計時 ${gameDurationSeconds} 秒。`)) startRound(true);
  });
  $('pauseBtn').addEventListener('click', pauseRound);
  $('resumeBtn').addEventListener('click', resumeRound);
  $('fullscreenBtn').addEventListener('click', toggleGameFullscreen);
  $('fsStartBtn').addEventListener('click', () => startRound(false));
  $('fsPauseResumeBtn').addEventListener('click', () => {
    if (round.status === 'running') pauseRound();
    else if (round.status === 'paused') resumeRound();
  });
  $('fsStopBtn').addEventListener('click', stopRound);
  $('crosshairToggle').addEventListener('change', renderCrosshairs);
  $('selectAllBtn').addEventListener('click', () => setAllPlayersActive(true));
  $('selectNoneBtn').addEventListener('click', () => setAllPlayersActive(false));
  $('resetAllScoresBtn').addEventListener('click', () => {
    if (confirm('確定將所有已加入學生的分數歸零？')) resetAllScores();
  });
  $('qrBtn').addEventListener('click', () => {
    if ($('qrDialog').showModal) $('qrDialog').showModal();
    else $('qrDialog').setAttribute('open','');
  });
  $('closeQrBtn').addEventListener('click', () => $('qrDialog').close?.());
  $('copyJoinUrlBtn').addEventListener('click', async () => {
    const value = $('studentJoinUrl').value;
    if (!value) return;
    await navigator.clipboard.writeText(value);
    const old = $('copyJoinUrlBtn').textContent;
    $('copyJoinUrlBtn').textContent = '已複製';
    setTimeout(() => $('copyJoinUrlBtn').textContent = old, 1000);
  });
}

async function toggleGameFullscreen() {
  const stage = $('gameStage');
  try {
    if (!document.fullscreenElement) {
      if (stage.requestFullscreen) await stage.requestFullscreen();
      else if (stage.webkitRequestFullscreen) stage.webkitRequestFullscreen();
    } else if (document.exitFullscreen) {
      await document.exitFullscreen();
    }
  } catch {}
}

function subscribePassValidity() {
  onValue(ref(db, `hostPasses/${token}`), snap => {
    if (!snap.exists()) {
      setFatal('error', '房間已關閉或教師控制通行證已失效。');
      disableGameControls();
      stopEngine();
    }
  }, () => {
    setFatal('error', '房間已關閉或教師控制通行證已失效。');
    disableGameControls();
    stopEngine();
  });
}

function disableGameControls() {
  ['startBtn','restartBtn','pauseBtn','resumeBtn','fsStartBtn','fsPauseResumeBtn','fsStopBtn','selectAllBtn','selectNoneBtn','resetAllScoresBtn'].forEach(id => $(id).disabled = true);
}

function subscribePlayers() {
  onValue(ref(db, `playerAccess/${roomCode}`), snap => {
    players = snap.val() || {};
    updatePlayerCounters();
    renderPlayerRoster();
    renderLeaderboard();
    renderCrosshairs();
  });
}

function subscribeActivePlayers() {
  onValue(ref(db, `activePlayers/${roomCode}`), snap => {
    activePlayers = snap.val() || {};
    updatePlayerCounters();
    renderPlayerRoster();
    renderLeaderboard();
    renderCrosshairs();
  });
}

function subscribeScores() {
  onValue(ref(db, `scores/${roomCode}`), snap => {
    scores = snap.val() || {};
    renderLeaderboard();
    renderPlayerRoster();
  });
}

function subscribeAims() {
  onValue(ref(db, `playerAim/${roomCode}`), snap => {
    aims = snap.val() || {};
    renderCrosshairs();
  });
}

function subscribeShots() {
  const shotsRef = ref(db, `playerShots/${roomCode}`);
  const handle = snap => {
    const uid = snap.key;
    const shot = snap.val();
    if (!uid || !shot || !Number.isFinite(shot.seq)) return;
    const last = shotSeqSeen.get(uid) || 0;
    if (shot.seq <= last) return;
    shotSeqSeen.set(uid, shot.seq);
    if (round.status !== 'running' || !isPlayerActive(uid)) return;
    if (!Number.isFinite(shot.shotAt) || shot.shotAt < round.startedAt - 1000) return;
    handleShot(uid, shot);
  };
  onChildAdded(shotsRef, handle);
  onChildChanged(shotsRef, handle);
}

function subscribeGameState() {
  onValue(ref(db, `gameState/${roomCode}`), snap => {
    const state = snap.val();
    if (!state) return;
    if (state.controllerUid === hostUid) return;
    if (Number.isFinite(state.durationMs)) {
      gameDurationSeconds = Math.max(1, Math.round(state.durationMs / 1000));
      if ([60,90,120,150].includes(gameDurationSeconds)) $('gameDurationSelect').value = String(gameDurationSeconds);
    }
    if (Number.isFinite(state.targetLifetimeMs)) {
      targetLifetimeMs = state.targetLifetimeMs;
      const sec = Math.round(targetLifetimeMs / 1000);
      if (sec >= 1 && sec <= 15) $('targetLifetimeSelect').value = String(sec);
    }
    if (Number.isInteger(state.rationalTargetCount) && state.rationalTargetCount >= 3 && state.rationalTargetCount <= 10) {
      rationalTargetCount = state.rationalTargetCount;
      $('rationalCountSelect').value = String(rationalTargetCount);
    }
    if (Number.isInteger(state.irrationalTargetCount) && state.irrationalTargetCount >= 3 && state.irrationalTargetCount <= 10) {
      irrationalTargetCount = state.irrationalTargetCount;
      $('irrationalCountSelect').value = String(irrationalTargetCount);
    }
    if (state.visualTheme === 'tech' || state.visualTheme === 'classic') {
      visualTheme = state.visualTheme;
      $('themeSelect').value = visualTheme;
      applyVisualTheme();
    }
    applySelectedSettings();
    if (['waiting','paused','finished','closed'].includes(state.status)) {
      round.status = state.status;
      round.remainingMs = state.remainingMs ?? round.remainingMs;
      updateControlState();
    }
  });
}

async function startRound(resetScores) {
  if (!activePlayerCount()) {
    const ok = confirm('目前尚未勾選任何「本局參加」學生。仍要開始遊戲嗎？');
    if (!ok) return;
  }
  stopEngine();
  clearTargets();
  clearEffects();
  hitTargetsByPlayer = new Map();
  shotSeqSeen = new Map();

  const now = Date.now();
  round = {
    status: 'running',
    roundId: crypto.randomUUID ? crypto.randomUUID() : `${now}-${Math.random()}`,
    startedAt: now,
    endsAt: now + gameDurationSeconds * 1000,
    remainingMs: gameDurationSeconds * 1000
  };

  if (resetScores) await resetAllScores(false);
  await writeGameState();
  $('startOverlay').classList.add('hidden');
  $('roundMessage').textContent = `遊戲進行中：本局 ${activePlayerCount()} 人參加。`;
  updateControlState();
  ensureTargetCounts();
  engineTimer = setInterval(engineTick, 120);
}

async function pauseRound() {
  if (round.status !== 'running') return;
  round.remainingMs = Math.max(0, round.endsAt - Date.now());
  round.status = 'paused';
  stopEngine(false);
  clearTargets();
  await writeGameState();
  $('roundMessage').textContent = '遊戲已暫停。';
  updateControlState();
}

async function resumeRound() {
  if (round.status !== 'paused') return;
  round.status = 'running';
  round.startedAt = Date.now();
  round.endsAt = Date.now() + Math.max(1000, round.remainingMs);
  await writeGameState();
  $('roundMessage').textContent = `遊戲繼續：本局 ${activePlayerCount()} 人參加。`;
  updateControlState();
  ensureTargetCounts();
  engineTimer = setInterval(engineTick, 120);
}

async function stopRound() {
  if (!['running','paused'].includes(round.status)) return;
  round.status = 'finished';
  round.remainingMs = 0;
  stopEngine(false);
  clearTargets();
  clearEffects();
  await writeGameState();
  $('roundMessage').textContent = '本局已由老師停止；分數與排行榜已保留。';
  $('startOverlay').classList.remove('hidden');
  $('startOverlay').querySelector('strong').textContent = '本局已停止';
  $('startOverlay').querySelector('span').textContent = '可調整參賽學生、分數或設定後，再開始下一局。';
  updateControlState();
}

function stopEngine(updateRemaining = true) {
  if (engineTimer) clearInterval(engineTimer);
  engineTimer = null;
  if (updateRemaining) round.remainingMs = Math.max(0, round.endsAt ? round.endsAt - Date.now() : round.remainingMs);
}

async function finishRound() {
  if (round.status !== 'running') return;
  round.status = 'finished';
  round.remainingMs = 0;
  stopEngine(false);
  clearTargets();
  await writeGameState();
  $('roundMessage').textContent = `${gameDurationSeconds} 秒結束！排行榜已保留。`;
  $('startOverlay').classList.remove('hidden');
  $('startOverlay').querySelector('strong').textContent = '時間到！';
  $('startOverlay').querySelector('span').textContent = '可查看排行榜、調整本局學生，或重新開始。';
  updateControlState();
}

async function writeGameState() {
  await set(ref(db, `gameState/${roomCode}`), {
    status: round.status,
    roundId: round.roundId,
    startedAt: round.startedAt || null,
    endsAt: round.endsAt || null,
    remainingMs: Math.max(0, Math.round(round.remainingMs)),
    durationMs: gameDurationSeconds * 1000,
    targetLifetimeMs,
    rationalTargetCount,
    irrationalTargetCount,
    visualTheme,
    controllerUid: hostUid,
    updatedAt: Date.now()
  });
}

function engineTick() {
  if (round.status !== 'running') return;
  round.remainingMs = Math.max(0, round.endsAt - Date.now());
  if (round.remainingMs <= 0) {
    finishRound();
    return;
  }
  const now = Date.now();
  for (const [id, t] of targets) {
    if (now >= t.expiresAt) removeTarget(id);
  }
  ensureTargetCounts();
}

function ensureTargetCounts() {
  if (round.status !== 'running') return;
  let rCount = 0, iCount = 0;
  for (const t of targets.values()) t.kind === 'rational' ? rCount++ : iCount++;
  while (rCount < rationalTargetCount) { spawnTarget('rational'); rCount++; }
  while (iCount < irrationalTargetCount) { spawnTarget('irrational'); iCount++; }
}

function findSpawnPosition() {
  let best = { x: .5, y: .5, d: -1 };
  for (let i = 0; i < 120; i++) {
    const x = 0.075 + Math.random() * 0.85;
    const y = 0.11 + Math.random() * 0.80;
    let minD = 99;
    for (const t of targets.values()) {
      minD = Math.min(minD, Math.hypot(x - t.x, y - t.y));
    }
    if (minD > best.d) best = { x, y, d: minD };
    if (minD > 0.09) return { x, y };
  }
  return { x: best.x, y: best.y };
}

function spawnTarget(kind) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
  const { x, y } = findSpawnPosition();
  const label = drawLabel(kind);
  const now = Date.now();
  const target = { id, kind, label, x, y, spawnedAt: now, expiresAt: now + targetLifetimeMs };
  targets.set(id, target);

  const el = document.createElement('div');
  el.className = `number-target ${kind}`;
  el.dataset.targetId = id;
  el.style.left = `${x * 100}%`;
  el.style.top = `${y * 100}%`;
  el.textContent = label;
  $('targetsLayer').appendChild(el);
}

function removeTarget(id) {
  targets.delete(id);
  const el = $('targetsLayer').querySelector(`[data-target-id="${CSS.escape(id)}"]`);
  if (el) el.remove();
}

function clearTargets() {
  targets.clear();
  $('targetsLayer').replaceChildren();
}

function clearEffects() { $('effectsLayer').replaceChildren(); }

async function handleShot(uid, shot) {
  if (!isPlayerActive(uid)) return;
  const p = players[uid];
  if (!p) return;
  const x = clamp(Number(shot.x), 0, 1);
  const y = clamp(Number(shot.y), 0, 1);
  const target = findHitTarget(x, y);
  const seat = Number(p.seat) || '?';
  let result = 'miss';
  let delta = 0;

  if (target) {
    if (!hitTargetsByPlayer.has(uid)) hitTargetsByPlayer.set(uid, new Set());
    const hitSet = hitTargetsByPlayer.get(uid);
    if (hitSet.has(target.id)) {
      result = 'duplicate';
    } else {
      hitSet.add(target.id);
      if (target.kind === 'rational') { result = 'correct'; delta = 1; }
      else result = 'wrong';
    }
  }

  const old = scores[uid] || { seat, score: 0, hits: 0, misses: 0 };
  const next = {
    seat,
    score: Math.max(0, Number(old.score || 0) + delta),
    hits: Number(old.hits || 0) + (result === 'correct' ? 1 : 0),
    misses: Number(old.misses || 0) + (['wrong','miss'].includes(result) ? 1 : 0),
    updatedAt: Date.now()
  };
  if (target) next.lastTarget = target.label;
  await set(ref(db, `scores/${roomCode}/${uid}`), next);
  showShotEffect(x, y, seat, result, target?.label || '');
}

function findHitTarget(x, y) {
  const field = $('gameField');
  const w = field.clientWidth || 1, h = field.clientHeight || 1;
  let best = null, bestD = Infinity;
  for (const t of targets.values()) {
    const d = Math.hypot((x - t.x) * w, (y - t.y) * h);
    if (d <= HIT_RADIUS_PX && d < bestD) { best = t; bestD = d; }
  }
  return best;
}

function showShotEffect(x, y, seat, result, label) {
  const el = document.createElement('div');
  el.className = `shot-effect ${result}`;
  el.style.left = `${x * 100}%`;
  el.style.top = `${y * 100}%`;
  const msg = result === 'correct' ? `+1  #${seat}` : result === 'duplicate' ? `已計分  #${seat}` : result === 'wrong' ? `無理數  #${seat}` : `MISS  #${seat}`;
  el.textContent = msg;
  if (label) el.title = label;
  $('effectsLayer').appendChild(el);
  setTimeout(() => el.remove(), 850);
}

function renderCrosshairs() {
  const layer = $('crosshairsLayer');
  layer.replaceChildren();
  if (!$('crosshairToggle').checked) return;
  const now = Date.now();
  for (const [uid, a] of Object.entries(aims)) {
    if (!players[uid] || !isPlayerActive(uid)) continue;
    if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) continue;
    if (Number.isFinite(a.updatedAt) && now - a.updatedAt > 15000) continue;
    const el = document.createElement('div');
    el.className = 'player-crosshair';
    el.style.left = `${clamp(a.x,0,1) * 100}%`;
    el.style.top = `${clamp(a.y,0,1) * 100}%`;
    el.style.setProperty('--seat-hue', String(((Number(players[uid].seat) || 1) * 47) % 360));
    el.innerHTML = `<span>＋</span><b>${safeText(players[uid].seat)}</b>`;
    layer.appendChild(el);
  }
}

function updatePlayerCounters() {
  const joined = Object.keys(players).length;
  const active = activePlayerCount();
  $('playerCount').textContent = `${active}/${joined}`;
  $('joinedCount').textContent = `${joined} 人`;
  $('activeCount').textContent = `本局 ${active} 人`;
}

async function setPlayerActive(uid, active) {
  if (!players[uid]) return;
  await set(ref(db, `activePlayers/${roomCode}/${uid}`), active ? true : null);
}

async function setAllPlayersActive(active) {
  const writes = {};
  for (const uid of Object.keys(players)) writes[uid] = active ? true : null;
  await update(ref(db, `activePlayers/${roomCode}`), writes);
}

function renderPlayerRoster() {
  const roster = $('playerRoster');
  const arr = Object.entries(players).sort((a,b) => Number(a[1].seat) - Number(b[1].seat));
  if (!arr.length) {
    roster.innerHTML = '<div class="muted">等待學生掃描 QR Code。</div>';
    return;
  }
  roster.replaceChildren();
  for (const [uid, p] of arr) {
    const row = document.createElement('div');
    row.className = `player-roster-row ${isPlayerActive(uid) ? 'active' : ''}`;
    row.innerHTML = `
      <label class="player-check"><input type="checkbox" ${isPlayerActive(uid) ? 'checked' : ''}><span>${safeText(p.seat)}號</span></label>
      <strong>${Number(scores[uid]?.score || 0)}</strong>
      <button class="btn ghost tiny-btn reset-one">歸零</button>
      <button class="btn danger tiny-btn release-seat">釋放座號</button>`;
    row.querySelector('input').addEventListener('change', e => setPlayerActive(uid, e.target.checked));
    row.querySelector('.reset-one').addEventListener('click', () => resetPlayerScore(uid));
    row.querySelector('.release-seat').addEventListener('click', () => releasePlayerSeat(uid));
    roster.appendChild(row);
  }
}

function renderLeaderboard() {
  const arr = Object.entries(players)
    .filter(([uid]) => isPlayerActive(uid))
    .map(([uid,p]) => ({ uid, seat:Number(p.seat), score:Number(scores[uid]?.score || 0) }));
  arr.sort((a,b) => b.score - a.score || a.seat - b.seat);
  $('leaderboard').innerHTML = arr.length ? arr.slice(0,27).map((p,i) => `
    <div class="leader-row ${i < 3 ? 'top-rank' : ''}"><span>${i+1}</span><b>${safeText(p.seat)}號</b><strong>${p.score}</strong></div>`).join('') : '<div class="muted">尚未勾選本局參加學生。</div>';
}

async function releasePlayerSeat(uid) {
  const p = players[uid];
  if (!p) return;
  const seatNumber = Number(p.seat);
  if (!confirm(`確定釋放 ${seatNumber} 號座位？目前使用這個座號的手機會被移除，必須重新掃描 QR Code 才能再次加入。`)) return;
  const writes = {};
  writes[`seatClaims/${roomCode}/${seatNumber}`] = null;
  writes[`playerAccess/${roomCode}/${uid}`] = null;
  writes[`activePlayers/${roomCode}/${uid}`] = null;
  writes[`playerAim/${roomCode}/${uid}`] = null;
  writes[`playerShots/${roomCode}/${uid}`] = null;
  writes[`scores/${roomCode}/${uid}`] = null;
  await update(ref(db), writes);
  shotSeqSeen.delete(uid);
  hitTargetsByPlayer.delete(uid);
}

async function resetPlayerScore(uid) {
  const p = players[uid];
  if (!p) return;
  await set(ref(db, `scores/${roomCode}/${uid}`), {
    seat: Number(p.seat), score: 0, hits: 0, misses: 0, updatedAt: Date.now()
  });
}

async function resetAllScores(ask = true) {
  if (ask && !confirm('確定將所有已加入學生的分數歸零？')) return;
  const now = Date.now();
  const newScores = {};
  for (const [uid, p] of Object.entries(players)) {
    newScores[uid] = { seat: Number(p.seat), score: 0, hits: 0, misses: 0, updatedAt: now };
  }
  await set(ref(db, `scores/${roomCode}`), Object.keys(newScores).length ? newScores : null);
}

function startUiClock() {
  if (uiTimer) clearInterval(uiTimer);
  uiTimer = setInterval(() => {
    if (round.status === 'running') round.remainingMs = Math.max(0, round.endsAt - Date.now());
    $('timer').textContent = Math.ceil(Math.max(0, round.remainingMs) / 1000);
    updateFieldState();
  }, 120);
}

function updateControlState() {
  const running = round.status === 'running';
  const paused = round.status === 'paused';
  const inRound = running || paused;
  $('pauseBtn').disabled = !running;
  $('resumeBtn').classList.toggle('hidden', !paused);
  $('startBtn').disabled = inRound;
  $('fsStartBtn').disabled = inRound;
  $('fsPauseResumeBtn').disabled = !inRound;
  $('fsPauseResumeBtn').textContent = paused ? '繼續' : '暫停';
  $('fsPauseResumeBtn').classList.toggle('success', paused);
  $('fsPauseResumeBtn').classList.toggle('ghost', !paused);
  $('fsStopBtn').disabled = !inRound;
  ['gameDurationSelect','targetLifetimeSelect','rationalCountSelect','irrationalCountSelect']
    .forEach(id => $(id).disabled = inRound);
  $('gameStatusBadge').className = `badge ${running ? 'active' : paused ? 'scheduled' : 'closed'}`;
  $('gameStatusBadge').textContent = running ? '進行中' : paused ? '暫停' : round.status === 'finished' ? '已結束' : '等待';
  updateFieldState();
}

function updateFieldState() {
  $('fieldState').textContent = round.status === 'running' ? `剩餘 ${Math.ceil(round.remainingMs/1000)} 秒` : round.status === 'paused' ? '暫停' : round.status === 'finished' ? '已結束' : '等待開始';
}

boot();
