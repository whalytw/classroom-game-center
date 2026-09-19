import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  getDatabase, ref, get, set, update, onValue, onChildAdded, onChildChanged
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);
const $ = id => document.getElementById(id);
const token = new URLSearchParams(location.search).get('t');

const GAME_SECONDS = 60;
const TARGET_LIFETIME = 5000;
const MIN_TARGETS = 8;
const MAX_TARGETS = 12;
const HIT_RADIUS_PX = 58;

const rationalPool = [
  '−7','0','12','3/4','−5/2','0.25','−1.6','2.75','0.125','√49','−√81','14/7',
  '22/11','1/3','−7/8','4.2','0.04','100/25','−9/3','√0.25','2.333…','0.121212…',
  '5/10','−0.75','16/4','√100','1.05','−12/6','7/20','0.875','−2.4','45/9'
];
const irrationalPool = [
  '√2','√3','√5','√7','√10','√11','√13','√17','π','−π','π/2','2π','1+√2','3−√5',
  '√8','√12','√18','√20','√24','√27','√50','e','√6/2','π+1','√15','√19','3π','√21','√30','2−√3'
];

let pass = null;
let roomCode = null;
let hostUid = null;
let players = {};
let scores = {};
let aims = {};
let targets = new Map();
let desiredR = randInt(MIN_TARGETS, MAX_TARGETS);
let desiredI = randInt(MIN_TARGETS, MAX_TARGETS);
let round = {
  status: 'waiting', roundId: null, startedAt: 0, endsAt: 0, remainingMs: GAME_SECONDS * 1000
};
let engineTimer = null;
let uiTimer = null;
let desiredTimer = null;
let shotSeqSeen = new Map();
let hitTargetsByPlayer = new Map();

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function safeText(s) { return String(s ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function setFatal(type, text) { $('fatalNotice').className = `notice ${type}`; $('fatalNotice').textContent = text; }
function activeHostPath() { return `roomHosts/${roomCode}/${hostUid}`; }

async function boot() {
  try {
    if (!token) throw new Error('網址中沒有教師控制通行證。');
    const cred = await signInAnonymously(auth);
    hostUid = cred.user.uid;
    const passSnap = await get(ref(db, `hostPasses/${token}`));
    if (!passSnap.exists()) throw new Error('教師控制連結不存在、已關閉或已到期。');
    pass = passSnap.val();
    roomCode = pass.roomCode;

    await set(ref(db, activeHostPath()), {
      hostToken: token,
      joinedAt: Date.now()
    });

    $('gameTitle').textContent = pass.gameName;
    $('roomCode').textContent = roomCode;
    $('hostStatus').textContent = '教師控制通行證有效';
    $('hostGame').classList.remove('hidden');
    setFatal('ok', '教師控制端已連線。學生現在可以掃 QR Code 加入。');

    bindControls();
    subscribePlayers();
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

function bindControls() {
  $('startBtn').addEventListener('click', () => startRound(true));
  $('restartBtn').addEventListener('click', () => {
    if (confirm('確定重新開始？目前分數會歸零並重新計時 60 秒。')) startRound(true);
  });
  $('pauseBtn').addEventListener('click', pauseRound);
  $('resumeBtn').addEventListener('click', resumeRound);
  $('fullscreenBtn').addEventListener('click', async () => {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      else await document.exitFullscreen();
    } catch {}
  });
  $('crosshairToggle').addEventListener('change', renderCrosshairs);
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
  ['startBtn','restartBtn','pauseBtn','resumeBtn'].forEach(id => $(id).disabled = true);
  $('fireBtn')?.setAttribute('disabled','');
}

function subscribePlayers() {
  onValue(ref(db, `playerAccess/${roomCode}`), snap => {
    players = snap.val() || {};
    $('playerCount').textContent = Object.keys(players).length;
    $('joinedCount').textContent = `${Object.keys(players).length} 人`;
    renderPlayerList();
    renderLeaderboard();
  });
}

function subscribeScores() {
  onValue(ref(db, `scores/${roomCode}`), snap => {
    scores = snap.val() || {};
    renderLeaderboard();
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
    if (round.status !== 'running') return;
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
    // 若另一個教師控制頁接手，讓本頁同步狀態但不重新建立目標。
    if (['waiting','paused','finished','closed'].includes(state.status)) {
      round.status = state.status;
      round.remainingMs = state.remainingMs ?? round.remainingMs;
      updateControlState();
    }
  });
}

async function startRound(resetScores) {
  stopEngine();
  clearTargets();
  clearEffects();
  hitTargetsByPlayer = new Map();
  shotSeqSeen = new Map();
  desiredR = randInt(MIN_TARGETS, MAX_TARGETS);
  desiredI = randInt(MIN_TARGETS, MAX_TARGETS);

  const now = Date.now();
  round = {
    status: 'running',
    roundId: crypto.randomUUID ? crypto.randomUUID() : `${now}-${Math.random()}`,
    startedAt: now,
    endsAt: now + GAME_SECONDS * 1000,
    remainingMs: GAME_SECONDS * 1000
  };

  if (resetScores) {
    const newScores = {};
    for (const [uid, p] of Object.entries(players)) {
      newScores[uid] = { seat: Number(p.seat), score: 0, hits: 0, misses: 0, updatedAt: now };
    }
    await set(ref(db, `scores/${roomCode}`), newScores);
  }

  await writeGameState();
  $('startOverlay').classList.add('hidden');
  $('roundMessage').textContent = '遊戲進行中：請學生射擊有理數。';
  updateControlState();
  ensureTargetCounts();

  engineTimer = setInterval(engineTick, 120);
  desiredTimer = setInterval(() => {
    desiredR = randInt(MIN_TARGETS, MAX_TARGETS);
    desiredI = randInt(MIN_TARGETS, MAX_TARGETS);
  }, 2500);
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
  round.startedAt = Date.now(); // 僅供忽略暫停期間舊射擊；分數不重設
  round.endsAt = Date.now() + Math.max(1000, round.remainingMs);
  await writeGameState();
  $('roundMessage').textContent = '遊戲繼續。';
  updateControlState();
  ensureTargetCounts();
  engineTimer = setInterval(engineTick, 120);
  desiredTimer = setInterval(() => {
    desiredR = randInt(MIN_TARGETS, MAX_TARGETS);
    desiredI = randInt(MIN_TARGETS, MAX_TARGETS);
  }, 2500);
}

function stopEngine(clearIntervals = true) {
  if (engineTimer) clearInterval(engineTimer);
  if (desiredTimer) clearInterval(desiredTimer);
  engineTimer = null;
  desiredTimer = null;
  if (clearIntervals) round.remainingMs = Math.max(0, round.endsAt ? round.endsAt - Date.now() : round.remainingMs);
}

async function finishRound() {
  if (round.status !== 'running') return;
  round.status = 'finished';
  round.remainingMs = 0;
  stopEngine(false);
  clearTargets();
  await writeGameState();
  $('roundMessage').textContent = '60 秒結束！排行榜已保留。';
  $('startOverlay').classList.remove('hidden');
  $('startOverlay').querySelector('strong').textContent = '時間到！';
  $('startOverlay').querySelector('span').textContent = '可查看排行榜，或按「重新開始」再玩一局。';
  updateControlState();
}

async function writeGameState() {
  await set(ref(db, `gameState/${roomCode}`), {
    status: round.status,
    roundId: round.roundId,
    startedAt: round.startedAt || null,
    endsAt: round.endsAt || null,
    remainingMs: Math.max(0, Math.round(round.remainingMs)),
    durationMs: GAME_SECONDS * 1000,
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
  while (rCount < desiredR && rCount < MAX_TARGETS) { spawnTarget('rational'); rCount++; }
  while (iCount < desiredI && iCount < MAX_TARGETS) { spawnTarget('irrational'); iCount++; }
  // 即使 desired 暫時降低，也不提早移除，讓所有目標完整停留 5 秒。
  while (rCount < MIN_TARGETS) { spawnTarget('rational'); rCount++; }
  while (iCount < MIN_TARGETS) { spawnTarget('irrational'); iCount++; }
}

function pickUniqueLabel(pool) {
  const active = new Set(Array.from(targets.values()).map(t => t.label));
  const choices = pool.filter(x => !active.has(x));
  const source = choices.length ? choices : pool;
  return source[randInt(0, source.length - 1)];
}

function findSpawnPosition() {
  let best = { x: .5, y: .5, d: -1 };
  for (let i = 0; i < 80; i++) {
    const x = 0.08 + Math.random() * 0.84;
    const y = 0.13 + Math.random() * 0.78;
    let minD = 99;
    for (const t of targets.values()) {
      const dx = x - t.x, dy = y - t.y;
      minD = Math.min(minD, Math.hypot(dx, dy));
    }
    if (minD > best.d) best = { x, y, d: minD };
    if (minD > 0.082) return { x, y };
  }
  return { x: best.x, y: best.y };
}

function spawnTarget(kind) {
  const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
  const { x, y } = findSpawnPosition();
  const label = pickUniqueLabel(kind === 'rational' ? rationalPool : irrationalPool);
  const now = Date.now();
  const target = { id, kind, label, x, y, spawnedAt: now, expiresAt: now + TARGET_LIFETIME };
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
    if (!players[uid]) continue;
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

function renderPlayerList() {
  const arr = Object.entries(players).sort((a,b) => Number(a[1].seat) - Number(b[1].seat));
  $('playerList').innerHTML = arr.length ? arr.map(([uid,p]) => `<span class="player-chip">${safeText(p.seat)}號</span>`).join('') : '<div class="muted">等待學生掃描 QR Code。</div>';
}

function renderLeaderboard() {
  const arr = Object.entries(players).map(([uid,p]) => ({ uid, seat:Number(p.seat), score:Number(scores[uid]?.score || 0) }));
  arr.sort((a,b) => b.score - a.score || a.seat - b.seat);
  $('leaderboard').innerHTML = arr.length ? arr.slice(0,27).map((p,i) => `
    <div class="leader-row ${i < 3 ? 'top-rank' : ''}"><span>${i+1}</span><b>${safeText(p.seat)}號</b><strong>${p.score}</strong></div>`).join('') : '<div class="muted">尚無玩家。</div>';
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
  $('pauseBtn').disabled = !running;
  $('resumeBtn').classList.toggle('hidden', !paused);
  $('startBtn').disabled = running || paused;
  $('gameStatusBadge').className = `badge ${running ? 'active' : paused ? 'scheduled' : 'closed'}`;
  $('gameStatusBadge').textContent = running ? '進行中' : paused ? '暫停' : round.status === 'finished' ? '已結束' : '等待';
  updateFieldState();
}

function updateFieldState() {
  $('fieldState').textContent = round.status === 'running' ? `剩餘 ${Math.ceil(round.remainingMs/1000)} 秒` : round.status === 'paused' ? '暫停' : round.status === 'finished' ? '時間到' : '等待開始';
}

boot();
