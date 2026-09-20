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
const COOP_DURATIONS = [180,210,240,270,300,330,360];
const COOP_INITIAL_IRRATIONAL_OPTIONS = [30,35,40,45,50];
const COOP_INITIAL_RATIONAL_OPTIONS = [60,65,70,75,80,85,90,95,100];
// v2.10: cooperative tabletop is 80% of the former width/height, centered in the same area.
const COOP_TABLE = { left:0.113, right:0.777, top:0.128, bottom:0.872 };
const COOP_CARD_HALF_W = 0.043;
const COOP_CARD_HALF_H = 0.052;

let gameDurationSeconds = DEFAULT_GAME_SECONDS;
let targetLifetimeMs = DEFAULT_TARGET_SECONDS * 1000;
let rationalTargetCount = DEFAULT_RATIONAL_COUNT;
let irrationalTargetCount = DEFAULT_IRRATIONAL_COUNT;
let visualTheme = 'classic';
let gameMode = 'single';
let lastSingleDuration = 60;
let lastCoopDuration = 240;
let soundEnabled = true;
let coopInitialIrrationalCount = 30;
let coopInitialRationalCount = 60;
let coopFinalizedRoundId = null;

function mathItem(key, html = null) {
  return { key, label: key, html: html ?? safeText(key) };
}

function fractionHtml(numerator, denominator) {
  return `<span class="math-frac"><span class="math-num">${numerator}</span><span class="math-den">${denominator}</span></span>`;
}

function radicalHtml(radicand) {
  return `<span class="math-radical"><span class="root-symbol">√</span><span class="radicand">${radicand}</span></span>`;
}

function repeatingHtml(integerPart, repetend) {
  return `${integerPart}.<span class="repetend">${repetend}</span>`;
}

function buildRationalPool() {
  const out = [];
  const seen = new Set();
  const add = (key, html = null) => {
    if (!seen.has(key)) { seen.add(key); out.push(mathItem(key, html)); }
  };
  // 固定 200 個有理數；完全平方根最大 √1024 = √(32²)。
  for (let n = -20; n <= 19; n++) {
    const label = String(n).replace('-', '−');
    add(label);
  }                                                                            // 40
  for (let n = 20; n <= 69; n++) add(`${n}.25`);                               // +50 = 90
  for (let n = 2; n <= 41; n++) add(`1/${n}`, fractionHtml('1', String(n)));    // +40 = 130
  for (let n = 2; n <= 32; n++) {
    const square = n * n;
    add(`√${square}`, radicalHtml(String(square)));
  }                                                                            // +31 = 161
  for (let n = 1; n <= 20; n++) {
    add(`−${n}/${n + 1}`, `−${fractionHtml(String(n), String(n + 1))}`);
  }                                                                            // +20 = 181
  for (let n = 1; n <= 19; n++) {
    const pair = String(n).padStart(2, '0');
    add(`2.${pair}${pair}${pair}…`, repeatingHtml('2', pair));
  }                                                                            // +19 = 200
  return out.slice(0, 200);
}

function buildIrrationalPool() {
  const out = [];
  const nonSquares = [];
  for (let n = 2; nonSquares.length < 160; n++) {
    if (!Number.isInteger(Math.sqrt(n))) nonSquares.push(n);
  }
  for (let i = 0; i < 100; i++) {
    const n = nonSquares[i];
    out.push(mathItem(`√${n}`, radicalHtml(String(n))));
  }
  for (let i = 100; i < 140; i++) {
    const k = i - 99;
    const n = nonSquares[i];
    out.push(mathItem(`${k}+√${n}`, `${k}+${radicalHtml(String(n))}`));
  }
  // 高一尚未學自然底數 e，因此只使用 π、根式等無理數形式。
  for (let k = 1; k <= 20; k++) {
    out.push(mathItem(k === 1 ? 'π+1' : `π+${k}`, k === 1 ? 'π+1' : `π+${k}`));
  }
  for (let k = 1; k <= 20; k++) {
    out.push(mathItem(k === 1 ? 'π' : `${k}π`, k === 1 ? 'π' : `${k}π`));
  }
  for (let i = 140; i < 160; i++) {
    const n = nonSquares[i];
    out.push(mathItem(`√${n}/2`, fractionHtml(radicalHtml(String(n)), '2')));
  }
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
let rosterViewMode = 'normal';
let groupSize = 4;
let randomizedGroupOrder = null;
let round = {
  status: 'waiting', roundId: null, startedAt: 0, endsAt: 0, remainingMs: DEFAULT_GAME_SECONDS * 1000
};
let engineTimer = null;
let uiTimer = null;
let shotSeqSeen = new Map();
let hitTargetsByPlayer = new Map();
let coopCards = new Map();
let coopPassCards = [];
let coopBombs = [];
let coopTeamScore = 0;
let coopRationalHits = 0;
let coopOverlayBucket = 0;
let coopSuccess = false;
let coopRationalBag = [];
let coopIrrationalBag = [];
let coopCardSeq = 0;
let audioCtx = null;
let lastGroupSignature = '';
let coopPenaltyUntil = new Map();

function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function safeText(s) { return String(s ?? '').replace(/[&<>\'\"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
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
  const activeKeys = new Set(Array.from(targets.values()).map(t => t.key));
  let chosen = null;
  for (let i = 0; i < pool.length; i++) {
    const candidate = bag.shift();
    if (!activeKeys.has(candidate.key)) { chosen = candidate; break; }
    bag.push(candidate);
  }
  if (!chosen) chosen = pool[randInt(0, pool.length - 1)];
  if (kind === 'rational') rationalBag = bag;
  else irrationalBag = bag;
  return chosen;
}

function drawCoopItem(kind) {
  const pool = kind === 'rational' ? rationalPool : irrationalPool;
  let bag = kind === 'rational' ? coopRationalBag : coopIrrationalBag;
  if (!bag.length) bag = shuffle(pool);
  const item = bag.shift() || pool[randInt(0, pool.length - 1)];
  if (kind === 'rational') coopRationalBag = bag;
  else coopIrrationalBag = bag;
  return item;
}

function coopActiveUids() {
  return Object.keys(players).filter(uid => isPlayerActive(uid));
}

function buildDurationOptions() {
  const select = $('gameDurationSelect');
  const values = gameMode === 'coop' ? COOP_DURATIONS : [60,90,120,150];
  const preferred = gameMode === 'coop' ? lastCoopDuration : lastSingleDuration;
  select.replaceChildren();
  for (const sec of values) {
    const opt = document.createElement('option');
    opt.value = String(sec);
    opt.textContent = `${sec} 秒`;
    if (sec === preferred) opt.selected = true;
    select.appendChild(opt);
  }
  gameDurationSeconds = Number(select.value || values[0]);
}

function setGameMode(mode, {force=false} = {}) {
  const inRound = ['running','paused'].includes(round.status);
  if (inRound && !force) return;
  gameMode = mode === 'coop' ? 'coop' : 'single';
  $('singleModeBtn').classList.toggle('active', gameMode === 'single');
  $('coopModeBtn').classList.toggle('active', gameMode === 'coop');
  $('singleModeBtn').setAttribute('aria-pressed', String(gameMode === 'single'));
  $('coopModeBtn').setAttribute('aria-pressed', String(gameMode === 'coop'));
  document.querySelectorAll('.single-only').forEach(el => el.classList.toggle('hidden', gameMode !== 'single'));
  document.querySelectorAll('.coop-only').forEach(el => el.classList.toggle('hidden', gameMode !== 'coop'));
  $('gameStage').classList.toggle('coop-mode', gameMode === 'coop');
  $('coopBoardLayer').classList.toggle('hidden', gameMode !== 'coop');
  $('coopBoardLayer').setAttribute('aria-hidden', String(gameMode !== 'coop'));
  $('targetsLayer').classList.toggle('hidden', gameMode === 'coop');
  $('scorePanelTitle').textContent = gameMode === 'coop' ? '團隊進度' : '即時排行榜';
  $('modeGoalLabel').textContent = gameMode === 'coop' ? '合作揭開「過」「關」' : '射擊有理數 +1';
  buildDurationOptions();
  applySelectedSettings();
  if (!inRound) {
    clearTargets();
    clearCoopBoard();
    $('startOverlay').classList.remove('hidden');
    $('startOverlay').querySelector('strong').textContent = gameMode === 'coop' ? '合作模式：找出「過」「關」' : '射擊畫面上的有理數';
    $('startOverlay').querySelector('span').textContent = gameMode === 'coop'
      ? `團隊合作｜${gameDurationSeconds} 秒｜每 5 次正確命中可獲得炸彈`
      : `每個數字停留 ${Math.round(targetLifetimeMs/1000)} 秒｜有理數 ${rationalTargetCount} 個｜無理數 ${irrationalTargetCount} 個｜${gameDurationSeconds} 秒挑戰`;
  }
  renderLeaderboard();
  updateControlState();
}

function ensureAudio() {
  if (!soundEnabled) return null;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  } catch { return null; }
}

function playTone(freq=760, duration=.08, type='sine', volume=.06) {
  const ctx = ensureAudio();
  if (!ctx || !soundEnabled) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type; osc.frequency.value = freq;
  gain.gain.setValueAtTime(volume, ctx.currentTime);
  gain.gain.exponentialRampToValueAtTime(.0001, ctx.currentTime + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(); osc.stop(ctx.currentTime + duration);
}

function playHitSound() { playTone(920,.08,'triangle',.07); }
function playWrongSound() { playTone(170,.16,'sawtooth',.055); }
function playSuccessSound() {
  const ctx = ensureAudio();
  if (!ctx || !soundEnabled) return;
  [660,880,1100].forEach((f,i) => setTimeout(() => playTone(f,.16,'triangle',.06), i*90));
}
function playExplosionSound() {
  const ctx = ensureAudio();
  if (!ctx || !soundEnabled) return;
  const duration=.38, buffer=ctx.createBuffer(1, Math.floor(ctx.sampleRate*duration), ctx.sampleRate);
  const data=buffer.getChannelData(0);
  for (let i=0;i<data.length;i++) data[i]=(Math.random()*2-1)*(1-i/data.length);
  const src=ctx.createBufferSource(), gain=ctx.createGain();
  src.buffer=buffer; gain.gain.setValueAtTime(.18,ctx.currentTime); gain.gain.exponentialRampToValueAtTime(.0001,ctx.currentTime+duration);
  src.connect(gain).connect(ctx.destination); src.start();
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
    setGameMode('single', {force:true});
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
  buildDurationOptions();
  try { visualTheme = localStorage.getItem('classroomGameVisualTheme') === 'tech' ? 'tech' : 'classic'; } catch {}
  $('themeSelect').value = visualTheme;
  applyVisualTheme();
  $('soundToggle').checked = true;
  soundEnabled = true;
  applySelectedSettings();
  ['gameDurationSelect','targetLifetimeSelect','rationalCountSelect','irrationalCountSelect','coopInitialIrrationalSelect','coopInitialRationalSelect']
    .forEach(id => $(id).addEventListener('change', applySelectedSettings));
  $('themeSelect').addEventListener('change', () => {
    visualTheme = $('themeSelect').value === 'tech' ? 'tech' : 'classic';
    try { localStorage.setItem('classroomGameVisualTheme', visualTheme); } catch {}
    applyVisualTheme();
  });
  $('soundToggle').addEventListener('change', () => { soundEnabled = $('soundToggle').checked; if (soundEnabled) ensureAudio(); });
}

function applyVisualTheme() {
  $('gameStage').classList.toggle('theme-tech', visualTheme === 'tech');
}

function applySelectedSettings() {
  const sec = Number($('gameDurationSelect').value);
  const life = Number($('targetLifetimeSelect').value);
  const rCount = Number($('rationalCountSelect').value);
  const iCount = Number($('irrationalCountSelect').value);
  const coopInitialIrr = Number($('coopInitialIrrationalSelect').value);
  const coopInitialRat = Number($('coopInitialRationalSelect').value);
  const allowed = gameMode === 'coop' ? COOP_DURATIONS : [60,90,120,150];
  if (allowed.includes(sec)) {
    gameDurationSeconds = sec;
    if (gameMode === 'coop') lastCoopDuration = sec; else lastSingleDuration = sec;
  }
  if (Number.isFinite(life) && life >= 1 && life <= 15) targetLifetimeMs = life * 1000;
  if (Number.isInteger(rCount) && rCount >= 3 && rCount <= 10) rationalTargetCount = rCount;
  if (Number.isInteger(iCount) && iCount >= 3 && iCount <= 10) irrationalTargetCount = iCount;
  if (COOP_INITIAL_IRRATIONAL_OPTIONS.includes(coopInitialIrr)) coopInitialIrrationalCount = coopInitialIrr;
  if (COOP_INITIAL_RATIONAL_OPTIONS.includes(coopInitialRat)) coopInitialRationalCount = coopInitialRat;
  if (round.status === 'waiting' || round.status === 'finished') {
    round.remainingMs = gameDurationSeconds * 1000;
    $('timer').textContent = String(gameDurationSeconds);
  }
  $('startBtn').textContent = gameMode === 'coop' ? `開始合作 ${gameDurationSeconds} 秒` : `開始 ${gameDurationSeconds} 秒`;
  $('gameRuleSummary').textContent = gameMode === 'coop'
    ? `團隊合作｜${gameDurationSeconds} 秒｜開局 ${coopInitialIrrationalCount} 無理 + ${coopInitialRationalCount} 有理｜每 15 秒追加 1 無理 + 4 有理｜每 5 次正確命中獲得炸彈`
    : `停留 ${Math.round(targetLifetimeMs/1000)} 秒｜有理數 ${rationalTargetCount} 個｜無理數 ${irrationalTargetCount} 個｜${gameDurationSeconds} 秒挑戰`;
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
  $('singleModeBtn').addEventListener('click', () => setGameMode('single'));
  $('coopModeBtn').addEventListener('click', () => setGameMode('coop'));
  $('startBtn').addEventListener('click', () => startRound(false));
  $('restartBtn').addEventListener('click', () => {
    if (confirm(gameMode === 'coop' ? `確定重新開始合作模式？本局參加學生分數會歸零，並重新計時 ${gameDurationSeconds} 秒。` : `確定重新開始？所有已加入學生分數會歸零，並重新計時 ${gameDurationSeconds} 秒。`)) startRound(true);
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
  $('rosterNormalTab').addEventListener('click', () => setRosterViewMode('normal'));
  $('rosterGroupTab').addEventListener('click', () => setRosterViewMode('group'));
  $('groupSizeSelect').addEventListener('change', () => {
    groupSize = Math.max(2, Math.min(12, Number($('groupSizeSelect').value) || 4));
    renderPlayerRoster();
  });
  $('randomGroupBtn').addEventListener('click', () => {
    randomizeGroups();
    setRosterViewMode('group');
    $('randomGroupBtn').textContent = '再次亂數分組';
  });
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
  ['startBtn','restartBtn','pauseBtn','resumeBtn','fsStartBtn','fsPauseResumeBtn','fsStopBtn','selectAllBtn','selectNoneBtn','resetAllScoresBtn','singleModeBtn','coopModeBtn','soundToggle'].forEach(id => $(id).disabled = true);
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
    if ((state.mode === 'coop' || state.mode === 'single') && state.mode !== gameMode && !['running','paused'].includes(round.status)) {
      setGameMode(state.mode, {force:true});
    }
    if (typeof state.soundEnabled === 'boolean') {
      soundEnabled = state.soundEnabled;
      $('soundToggle').checked = soundEnabled;
    }
    if (Number.isFinite(state.teamScore) && gameMode === 'coop') {
      coopTeamScore = Number(state.teamScore) || 0;
      renderCoopTeamHud();
    }
    if (typeof state.coopSuccess === 'boolean') coopSuccess = state.coopSuccess;
    if (Number.isFinite(state.durationMs)) {
      gameDurationSeconds = Math.max(1, Math.round(state.durationMs / 1000));
      const allowed = gameMode === 'coop' ? COOP_DURATIONS : [60,90,120,150];
      if (allowed.includes(gameDurationSeconds)) $('gameDurationSelect').value = String(gameDurationSeconds);
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
    if (COOP_INITIAL_IRRATIONAL_OPTIONS.includes(Number(state.coopInitialIrrationalCount))) {
      coopInitialIrrationalCount = Number(state.coopInitialIrrationalCount);
      $('coopInitialIrrationalSelect').value = String(coopInitialIrrationalCount);
    }
    if (COOP_INITIAL_RATIONAL_OPTIONS.includes(Number(state.coopInitialRationalCount))) {
      coopInitialRationalCount = Number(state.coopInitialRationalCount);
      $('coopInitialRationalSelect').value = String(coopInitialRationalCount);
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
  const activeCount = activePlayerCount();
  if (!activeCount) {
    const ok = confirm('目前尚未勾選任何「本局參加」學生。仍要開始遊戲嗎？');
    if (!ok) return;
  }
  stopEngine();
  clearTargets();
  clearEffects();
  clearCoopBoard();
  hitTargetsByPlayer = new Map();
  shotSeqSeen = new Map();
  coopPenaltyUntil = new Map();
  coopFinalizedRoundId = null;
  soundEnabled = $('soundToggle').checked;
  if (gameMode === 'coop' && soundEnabled) ensureAudio();

  const now = Date.now();
  round = {
    status: 'running',
    roundId: crypto.randomUUID ? crypto.randomUUID() : `${now}-${Math.random()}`,
    startedAt: now,
    endsAt: now + gameDurationSeconds * 1000,
    remainingMs: gameDurationSeconds * 1000
  };

  if (gameMode === 'coop') {
    await resetActiveScoresForCoop();
    setupCoopBoard();
  } else if (resetScores) {
    await resetAllScores(false);
  }

  await writeGameState();
  $('startOverlay').classList.add('hidden');
  $('roundMessage').textContent = gameMode === 'coop'
    ? `合作模式進行中：${activeCount} 位同學共同找出「過」「關」。`
    : `遊戲進行中：本局 ${activeCount} 人參加。`;
  updateControlState();
  if (gameMode === 'single') ensureTargetCounts();
  engineTimer = setInterval(engineTick, 120);
}

async function pauseRound() {
  if (round.status !== 'running') return;
  round.remainingMs = Math.max(0, round.endsAt - Date.now());
  round.status = 'paused';
  stopEngine(false);
  if (gameMode === 'single') clearTargets();
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
  $('roundMessage').textContent = gameMode === 'coop'
    ? `合作模式繼續：團隊分數 ${coopTeamScore}。`
    : `遊戲繼續：本局 ${activePlayerCount()} 人參加。`;
  updateControlState();
  if (gameMode === 'single') ensureTargetCounts();
  engineTimer = setInterval(engineTick, 120);
}

async function stopRound() {
  if (!['running','paused'].includes(round.status)) return;
  round.status = 'finished';
  round.remainingMs = 0;
  stopEngine(false);
  clearTargets();
  clearEffects();
  let coopAward = null;
  if (gameMode === 'coop') coopAward = await distributeCoopFinalScores({ success:false, remainingSec:0 });
  await writeGameState();
  $('roundMessage').textContent = gameMode === 'coop'
    ? `本局已由老師停止。團隊分數 ${coopTeamScore}，${coopAward?.teamSize || 0} 位隊員每人獲得 ${coopAward?.teamShare || 0} 分。`
    : '本局已由老師停止；分數已保留。';
  $('startOverlay').classList.remove('hidden');
  $('startOverlay').querySelector('strong').textContent = '本局已停止';
  $('startOverlay').querySelector('span').textContent = gameMode === 'coop'
    ? `團隊分數已均分：每位隊員 ${coopAward?.teamShare || 0} 分。`
    : '可調整參賽學生或設定後，再開始下一局。';
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
  let coopAward = null;
  if (gameMode === 'coop') coopAward = await distributeCoopFinalScores({ success:false, remainingSec:0 });
  await writeGameState();
  if (gameMode === 'coop') {
    $('roundMessage').textContent = `${gameDurationSeconds} 秒結束。團隊分數 ${coopTeamScore}，${coopAward?.teamSize || 0} 位隊員每人獲得 ${coopAward?.teamShare || 0} 分。`;
    $('startOverlay').classList.remove('hidden');
    $('startOverlay').querySelector('strong').textContent = '時間到！';
    $('startOverlay').querySelector('span').textContent = `未過關仍會均分團隊分數：每位隊員 ${coopAward?.teamShare || 0} 分。`;
  } else {
    $('roundMessage').textContent = `${gameDurationSeconds} 秒結束！排行榜已保留。`;
    $('startOverlay').classList.remove('hidden');
    $('startOverlay').querySelector('strong').textContent = '時間到！';
    $('startOverlay').querySelector('span').textContent = '可查看排行榜、調整本局學生，或重新開始。';
  }
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
    mode: gameMode,
    soundEnabled,
    teamScore: gameMode === 'coop' ? coopTeamScore : null,
    coopSuccess: gameMode === 'coop' ? coopSuccess : null,
    coopInitialIrrationalCount: gameMode === 'coop' ? coopInitialIrrationalCount : null,
    coopInitialRationalCount: gameMode === 'coop' ? coopInitialRationalCount : null,
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
  if (gameMode === 'coop') {
    const elapsedMs = Math.max(0, gameDurationSeconds * 1000 - round.remainingMs);
    const bucket = Math.floor(elapsedMs / 15000);
    while (coopOverlayBucket < bucket) {
      coopOverlayBucket += 1;
      addCoopWave();
    }
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
  const item = drawLabel(kind);
  const now = Date.now();
  const target = {
    id, kind, key: item.key, label: item.label, html: item.html,
    x, y, spawnedAt: now, expiresAt: now + targetLifetimeMs
  };
  targets.set(id, target);

  const el = document.createElement('div');
  el.className = `number-target ${kind}`;
  el.dataset.targetId = id;
  el.style.left = `${x * 100}%`;
  el.style.top = `${y * 100}%`;
  el.innerHTML = item.html;
  el.setAttribute('aria-label', item.label);
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


function coopRect(card) {
  const hw = card.halfW ?? COOP_CARD_HALF_W;
  const hh = card.halfH ?? COOP_CARD_HALF_H;
  return { left:card.x-hw, right:card.x+hw, top:card.y-hh, bottom:card.y+hh };
}

function rectsOverlap(a,b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function randomCoopPosition() {
  return {
    x: COOP_TABLE.left + COOP_CARD_HALF_W + Math.random() * (COOP_TABLE.right - COOP_TABLE.left - COOP_CARD_HALF_W*2),
    y: COOP_TABLE.top + COOP_CARD_HALF_H + Math.random() * (COOP_TABLE.bottom - COOP_TABLE.top - COOP_CARD_HALF_H*2)
  };
}

function buildCoopOpeningKinds(irrationalCount, rationalCount) {
  const kinds=[];
  let usedI=0, usedR=0;
  // Evenly interleave the two kinds. With the default 30/60 this is exactly I,R,R repeated.
  while (usedI < irrationalCount || usedR < rationalCount) {
    if (usedI < irrationalCount) {
      kinds.push('irrational');
      usedI += 1;
    }
    const targetR = irrationalCount > 0
      ? Math.min(rationalCount, Math.round(usedI * rationalCount / irrationalCount))
      : rationalCount;
    while (usedR < targetR) {
      kinds.push('rational');
      usedR += 1;
    }
  }
  while (usedR < rationalCount) { kinds.push('rational'); usedR += 1; }
  return kinds;
}

function setupCoopBoard() {
  clearCoopBoard();
  coopTeamScore = 0;
  coopRationalHits = 0;
  coopOverlayBucket = 0;
  coopSuccess = false;
  coopRationalBag = [];
  coopIrrationalBag = [];
  coopBombs = [];
  coopCardSeq = 0;

  const first = randomCoopPosition();
  let second = randomCoopPosition();
  for (let tries=0; tries<30 && Math.hypot(second.x-first.x, second.y-first.y)<0.18; tries++) second=randomCoopPosition();
  coopPassCards = [
    { id:'pass-guo', type:'pass', text:'過', x:first.x, y:first.y, halfW:.045, halfH:.058, z:2 },
    { id:'pass-guan', type:'pass', text:'關', x:second.x, y:second.y, halfW:.045, halfH:.058, z:3 }
  ];

  const layer = $('coopCardsLayer');
  const frag = document.createDocumentFragment();
  for (const passCard of coopPassCards) frag.appendChild(createPassCardElement(passCard));

  // 開場張數由老師選擇；兩類卡片會盡量平均交錯疊放。
  const openingKinds = buildCoopOpeningKinds(coopInitialIrrationalCount, coopInitialRationalCount);
  openingKinds.forEach((kind, i) => {
    const forced = i === 0 ? first : i === 1 ? second : null;
    const card = createCoopNumberCard(kind, forced);
    coopCards.set(card.id, card);
    frag.appendChild(createCoopCardElement(card));
  });
  layer.appendChild(frag);
  $('coopBoardLayer').classList.remove('hidden');
  $('coopBoardLayer').setAttribute('aria-hidden','false');
  $('coopSuccessStamp').classList.add('hidden');
  renderCoopBomb();
  renderCoopTeamHud();
  renderLeaderboard();
}

function createPassCardElement(card) {
  const el=document.createElement('div');
  el.className='coop-pass-card';
  el.dataset.passId=card.id;
  el.style.left=`${card.x*100}%`; el.style.top=`${card.y*100}%`; el.style.zIndex=String(card.z);
  el.textContent=card.text;
  return el;
}

function createCoopNumberCard(kind, forcedPosition=null) {
  const item=drawCoopItem(kind);
  const pos=forcedPosition || randomCoopPosition();
  coopCardSeq += 1;
  return {
    id:`coop-${coopCardSeq}-${Math.random().toString(36).slice(2,7)}`,
    type:'number', kind, key:item.key, label:item.label, html:item.html,
    x:pos.x, y:pos.y, halfW:COOP_CARD_HALF_W, halfH:COOP_CARD_HALF_H,
    z:20+coopCardSeq
  };
}

function createCoopCardElement(card) {
  const el=document.createElement('div');
  el.className=`coop-number-card ${card.kind}`;
  el.dataset.coopCardId=card.id;
  el.style.left=`${card.x*100}%`; el.style.top=`${card.y*100}%`; el.style.zIndex=String(card.z);
  el.innerHTML=card.html;
  el.setAttribute('aria-label',card.label);
  return el;
}

function addCoopCard(kind) {
  const card=createCoopNumberCard(kind);
  coopCards.set(card.id,card);
  $('coopCardsLayer').appendChild(createCoopCardElement(card));
}

function addCoopWave() {
  const irrationalCount=1;
  const rationalCount=4;
  for (let i=0;i<irrationalCount;i++) addCoopCard('irrational');
  for (let i=0;i<rationalCount;i++) addCoopCard('rational');
  showCoopNotice('追加 1 張無理數 + 4 張有理數');
}

function renderCoopBomb() {
  const layer=$('coopBombLayer');
  layer.replaceChildren();
  if (!coopBombs.length || gameMode!=='coop') return;
  const el=document.createElement('div');
  el.id='coopBombCard';
  el.className='coop-bomb-card';
  el.style.left='93%'; el.style.top='52%';
  el.innerHTML=`<span class="bomb-icon">💣</span><b>炸彈</b>${coopBombs.length>1?`<em>×${coopBombs.length}</em>`:''}`;
  layer.appendChild(el);
}

function earnCoopBomb() {
  coopBombs.push({id:`bomb-${Date.now()}-${Math.random()}`});
  renderCoopBomb();
  showCoopNotice('獲得炸彈！射擊右側炸彈可炸掉 3～4 張無理數');
}

function renderCoopTeamHud() {
  $('coopTeamScore').textContent=String(coopTeamScore);
  $('coopTeamHud').classList.toggle('hidden',gameMode!=='coop');
}

function showCoopNotice(text) {
  const el=document.createElement('div');
  el.className='coop-float-notice';
  el.textContent=text;
  $('effectsLayer').appendChild(el);
  setTimeout(()=>el.remove(),1400);
}

function pointInClientRect(px,py,r) { return px>=r.left && px<=r.right && py>=r.top && py<=r.bottom; }
function clientRectsOverlap(a,b) { return a.left<b.right && a.right>b.left && a.top<b.bottom && a.bottom>b.top; }

function findCoopHitTarget(x,y) {
  const fieldRect=$('gameField').getBoundingClientRect();
  const px=fieldRect.left+x*fieldRect.width, py=fieldRect.top+y*fieldRect.height;
  const bombEl=$('coopBombCard');
  if (coopBombs.length && bombEl && pointInClientRect(px,py,bombEl.getBoundingClientRect())) return {type:'bomb'};
  const cards=[...coopCards.values()].sort((a,b)=>b.z-a.z);
  for (const card of cards) {
    const el=$('coopCardsLayer').querySelector(`[data-coop-card-id="${CSS.escape(card.id)}"]`);
    if (el && pointInClientRect(px,py,el.getBoundingClientRect())) return card;
  }
  return null;
}

function removeCoopCard(card, {smoke=false}={}) {
  if (!card || !coopCards.has(card.id)) return;
  coopCards.delete(card.id);
  const el=$('coopCardsLayer').querySelector(`[data-coop-card-id="${CSS.escape(card.id)}"]`);
  if (el) {
    el.classList.add('coop-card-remove');
    setTimeout(()=>el.remove(),360);
  }
  if (smoke) showCoopSmoke(card.x,card.y);
}

function showCoopSmoke(x,y) {
  const puff=document.createElement('div');
  puff.className='coop-smoke';
  puff.style.left=`${x*100}%`; puff.style.top=`${y*100}%`;
  puff.innerHTML='<i></i><i></i><i></i>';
  $('effectsLayer').appendChild(puff);
  setTimeout(()=>puff.remove(),900);
}

function shakeCoopTable() {
  const board=$('coopBoardLayer');
  board.classList.remove('coop-shake');
  void board.offsetWidth;
  board.classList.add('coop-shake');
  setTimeout(()=>board.classList.remove('coop-shake'),620);
}

async function triggerCoopBomb(uid,x,y) {
  if (!coopBombs.length) return;
  coopBombs.shift();
  renderCoopBomb();
  const irr=shuffle([...coopCards.values()].filter(c=>c.kind==='irrational'));
  const count=Math.min(irr.length,randInt(3,4));
  const victims=irr.slice(0,count);
  for (const card of victims) removeCoopCard(card,{smoke:true});
  coopTeamScore += count;
  renderCoopTeamHud();
  renderLeaderboard();
  shakeCoopTable();
  playExplosionSound();
  showShotEffect(x,y,players[uid]?.seat||'?', 'bomb', String(count));
  await writeGameState();
  setTimeout(() => checkCoopSuccess(), 430);
}

async function handleCoopShot(uid,shot) {
  const p=players[uid];
  if (!p || !isPlayerActive(uid)) return;
  const oldScore=scores[uid] || {seat:Number(p.seat),score:0,hits:0,misses:0};
  const now=Date.now();
  if (Math.max(Number(oldScore.lockedUntil||0), Number(coopPenaltyUntil.get(uid)||0))>now) return;
  const x=clamp(Number(shot.x),0,1), y=clamp(Number(shot.y),0,1);
  const hit=findCoopHitTarget(x,y);
  const seat=Number(p.seat)||'?';
  if (!hit) { showShotEffect(x,y,seat,'miss',''); return; }
  if (hit.type==='bomb') { await triggerCoopBomb(uid,x,y); return; }
  if (hit.kind==='rational') {
    removeCoopCard(hit);
    coopTeamScore += 1;
    coopRationalHits += 1;
    const next={...oldScore,seat:Number(p.seat),hits:Number(oldScore.hits||0)+1,lockedUntil:0,updatedAt:Date.now()};
    await set(ref(db,`scores/${roomCode}/${uid}`),next);
    if (coopRationalHits%5===0) earnCoopBomb();
    renderCoopTeamHud(); renderLeaderboard();
    showShotEffect(x,y,seat,'correct',hit.label);
    playHitSound();
    await writeGameState();
    setTimeout(() => checkCoopSuccess(), 380);
    return;
  }
  const lockedUntil=Date.now()+3000;
  coopPenaltyUntil.set(uid,lockedUntil);
  const next={...oldScore,seat:Number(p.seat),misses:Number(oldScore.misses||0)+1,lockedUntil,updatedAt:Date.now()};
  await set(ref(db,`scores/${roomCode}/${uid}`),next);
  showShotEffect(x,y,seat,'wrong',hit.label);
  showCoopNotice(`${seat} 號誤射無理數：鎖定 3 秒`);
  playWrongSound();
}

function isPassCardClear(passCard) {
  const passEl=$('coopCardsLayer').querySelector(`[data-pass-id="${CSS.escape(passCard.id)}"]`);
  if (!passEl) return false;
  const pr=passEl.getBoundingClientRect();
  for (const card of coopCards.values()) {
    const el=$('coopCardsLayer').querySelector(`[data-coop-card-id="${CSS.escape(card.id)}"]`);
    if (el && clientRectsOverlap(pr,el.getBoundingClientRect())) return false;
  }
  return true;
}

async function distributeCoopFinalScores({ success=false, remainingSec=0 }={}) {
  const uids=coopActiveUids();
  const teamSize=uids.length;
  const teamShare=teamSize ? Math.ceil(coopTeamScore / teamSize) : 0;
  const timeShare=success && teamSize ? Math.ceil(Math.max(0, remainingSec) / teamSize) : 0;
  const totalShare=teamShare + timeShare;
  if (!teamSize) return { teamSize, teamShare, timeShare, totalShare };
  if (coopFinalizedRoundId === round.roundId) return { teamSize, teamShare, timeShare, totalShare };

  const writes={};
  const now=Date.now();
  for (const uid of uids) {
    const p=players[uid];
    const old=scores[uid] || {seat:Number(p?.seat||0),score:0,hits:0,misses:0};
    const next={...old,score:totalShare,lockedUntil:0,updatedAt:now};
    writes[`scores/${roomCode}/${uid}`]=next;
    scores[uid]=next;
  }
  await update(ref(db),writes);
  coopFinalizedRoundId = round.roundId;
  renderPlayerRoster();
  return { teamSize, teamShare, timeShare, totalShare };
}

async function checkCoopSuccess() {
  if (coopSuccess || gameMode!=='coop' || round.status!=='running') return;
  if (!coopPassCards.length || !coopPassCards.every(isPassCardClear)) return;
  coopSuccess=true;
  round.remainingMs=Math.max(0,round.endsAt-Date.now());
  round.status='finished';
  stopEngine(false);
  const remainingSec=Math.ceil(round.remainingMs/1000);
  const award=await distributeCoopFinalScores({ success:true, remainingSec });
  await writeGameState();
  const stamp=$('coopSuccessStamp');
  stamp.classList.remove('hidden','stamp-animate');
  void stamp.offsetWidth;
  stamp.classList.add('stamp-animate');
  $('roundMessage').textContent=`成功！團隊分數 ${coopTeamScore} → 每人 ${award.teamShare} 分；剩餘 ${remainingSec} 秒 → 每人 ${award.timeShare} 分；每位隊員共 ${award.totalShare} 分。`;
  $('startOverlay').classList.add('hidden');
  showCoopNotice(`過關！每位隊員共 +${award.totalShare} 分`);
  playSuccessSound();
  updateControlState();
}

function clearCoopBoard() {
  coopCards.clear(); coopPassCards=[]; coopBombs=[]; coopTeamScore=0; coopRationalHits=0; coopOverlayBucket=0; coopSuccess=false;
  for (const id of ['coopCardsLayer','coopBombLayer']) $(id)?.replaceChildren();
  $('coopSuccessStamp')?.classList.add('hidden');
  renderCoopTeamHud();
}

async function resetActiveScoresForCoop() {
  const writes={};
  const now=Date.now();
  for (const uid of coopActiveUids()) {
    const p=players[uid];
    const fresh={seat:Number(p?.seat||0),score:0,hits:0,misses:0,lockedUntil:0,updatedAt:now};
    writes[`scores/${roomCode}/${uid}`]=fresh;
    scores[uid]=fresh;
  }
  if (Object.keys(writes).length) await update(ref(db),writes);
  renderPlayerRoster();
}

async function handleShot(uid, shot) {
  if (!isPlayerActive(uid)) return;
  const p = players[uid];
  if (!p) return;
  if (gameMode === 'coop') {
    await handleCoopShot(uid, shot);
    return;
  }
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
  const msg = result === 'correct' ? `+1  #${seat}` : result === 'bomb' ? `炸彈 +${label}  #${seat}` : result === 'duplicate' ? `已計分  #${seat}` : result === 'wrong' ? `無理數  #${seat}` : `MISS  #${seat}`;
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

function setRosterViewMode(mode) {
  rosterViewMode = mode === 'group' ? 'group' : 'normal';
  $('rosterNormalTab').classList.toggle('active', rosterViewMode === 'normal');
  $('rosterGroupTab').classList.toggle('active', rosterViewMode === 'group');
  $('rosterNormalTab').setAttribute('aria-selected', String(rosterViewMode === 'normal'));
  $('rosterGroupTab').setAttribute('aria-selected', String(rosterViewMode === 'group'));
  $('groupControls').classList.toggle('hidden', rosterViewMode !== 'group');
  renderPlayerRoster();
}

function createPlayerRosterRow(uid, p) {
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
  return row;
}

function groupSignatureForOrder(order) {
  const byUid = new Map(Object.entries(players));
  const chunks=[];
  for (let i=0;i<order.length;i+=groupSize) {
    chunks.push(order.slice(i,i+groupSize).map(uid=>Number(byUid.get(uid)?.seat||0)).sort((a,b)=>a-b).join(','));
  }
  return chunks.join('|');
}

function randomizeGroups() {
  const uids=Object.keys(players);
  if (uids.length<=1) { randomizedGroupOrder=uids; return; }
  const previous=lastGroupSignature || (randomizedGroupOrder?groupSignatureForOrder(randomizedGroupOrder):'');
  let candidate=uids.slice(), sig='';
  for (let tries=0;tries<12;tries++) {
    candidate=shuffle(uids);
    sig=groupSignatureForOrder(candidate);
    if (!previous || sig!==previous) break;
  }
  randomizedGroupOrder=candidate;
  lastGroupSignature=sig;
  renderPlayerRoster();
}

function groupedPlayerEntries() {
  const byUid = new Map(Object.entries(players));
  const allUidsSorted = [...byUid.keys()].sort((a,b) => Number(byUid.get(a)?.seat) - Number(byUid.get(b)?.seat));
  let order = allUidsSorted;
  if (Array.isArray(randomizedGroupOrder) && randomizedGroupOrder.length) {
    const current = new Set(allUidsSorted);
    const kept = randomizedGroupOrder.filter(uid => current.has(uid));
    const keptSet = new Set(kept);
    const added = allUidsSorted.filter(uid => !keptSet.has(uid));
    order = [...kept, ...added];
  }
  const groups = [];
  for (let i = 0; i < order.length; i += groupSize) {
    const group = order.slice(i, i + groupSize)
      .map(uid => [uid, byUid.get(uid)])
      .filter(([,p]) => p)
      .sort((a,b) => Number(a[1].seat) - Number(b[1].seat));
    if (group.length) groups.push(group);
  }
  return groups;
}

function renderPlayerRoster() {
  const roster = $('playerRoster');
  const arr = Object.entries(players).sort((a,b) => Number(a[1].seat) - Number(b[1].seat));
  if (!arr.length) {
    roster.innerHTML = '<div class="muted">等待學生掃描 QR Code。</div>';
    return;
  }
  roster.replaceChildren();
  if (rosterViewMode === 'normal') {
    for (const [uid,p] of arr) roster.appendChild(createPlayerRosterRow(uid,p));
    return;
  }
  const groups = groupedPlayerEntries();
  groups.forEach((group, index) => {
    const block = document.createElement('section');
    block.className = 'player-group-block';
    const head = document.createElement('div');
    head.className = 'player-group-head';
    head.innerHTML = `<strong>第 ${index + 1} 組</strong><span>${group.length} 人</span>`;
    block.appendChild(head);
    const rows = document.createElement('div');
    rows.className = 'player-group-rows';
    for (const [uid,p] of group) rows.appendChild(createPlayerRosterRow(uid,p));
    block.appendChild(rows);
    roster.appendChild(block);
  });
}

function renderLeaderboard() {
  if (gameMode === 'coop') {
    const teamSize=activePlayerCount();
    $('leaderboard').innerHTML = `
      <div class="coop-progress-panel">
        <div><span>團隊分數</span><strong>${coopTeamScore}</strong></div>
        <div><span>正確命中</span><strong>${coopRationalHits}</strong></div>
        <div><span>炸彈</span><strong>${coopBombs.length}</strong></div>
        <div><span>隊員</span><strong>${teamSize}</strong></div>
      </div>`;
    return;
  }
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
  coopPenaltyUntil.delete(uid);
}

async function resetPlayerScore(uid) {
  const p = players[uid];
  if (!p) return;
  coopPenaltyUntil.delete(uid);
  await set(ref(db, `scores/${roomCode}/${uid}`), {
    seat: Number(p.seat), score: 0, hits: 0, misses: 0, lockedUntil: 0, updatedAt: Date.now()
  });
}

async function resetAllScores(ask = true) {
  if (ask && !confirm('確定將所有已加入學生的分數歸零？')) return;
  const now = Date.now();
  coopPenaltyUntil = new Map();
  const newScores = {};
  for (const [uid, p] of Object.entries(players)) {
    newScores[uid] = { seat: Number(p.seat), score: 0, hits: 0, misses: 0, lockedUntil: 0, updatedAt: now };
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
  $('singleModeBtn').disabled = inRound;
  $('coopModeBtn').disabled = inRound;
  $('gameDurationSelect').disabled = inRound;
  $('soundToggle').disabled = inRound;
  $('coopInitialIrrationalSelect').disabled = inRound;
  $('coopInitialRationalSelect').disabled = inRound;
  ['targetLifetimeSelect','rationalCountSelect','irrationalCountSelect']
    .forEach(id => $(id).disabled = inRound || gameMode === 'coop');
  $('gameStatusBadge').className = `badge ${running ? 'active' : paused ? 'scheduled' : 'closed'}`;
  $('gameStatusBadge').textContent = running ? '進行中' : paused ? '暫停' : round.status === 'finished' ? (coopSuccess ? '成功' : '已結束') : '等待';
  renderCoopTeamHud();
  updateFieldState();
}

function updateFieldState() {
  if (round.status === 'running') $('fieldState').textContent = `剩餘 ${Math.ceil(round.remainingMs/1000)} 秒`;
  else if (round.status === 'paused') $('fieldState').textContent = '暫停';
  else if (round.status === 'finished') $('fieldState').textContent = coopSuccess ? '成功' : '已結束';
  else $('fieldState').textContent = '等待開始';
}

boot();
