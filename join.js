import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  getDatabase, ref, get, update, set, onValue, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';

const app = initializeApp(firebaseConfig, 'student-controller');
const auth = getAuth(app);
const db = getDatabase(app);
const $ = id => document.getElementById(id);
const token = new URLSearchParams(location.search).get('t');
const fmt = ms => new Intl.DateTimeFormat('zh-TW',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(ms));
const clamp = (v,min,max) => Math.max(min,Math.min(max,v));

let pass = null;
let uid = null;
let room = null;
let seat = null;
let aim = { x:.5, y:.5 };
let seq = 0;
let gameState = { status:'waiting', remainingMs:60000 };
let isActivePlayer = false;
let lastFireLocal = 0;
let aimWriteTimer = null;
let lastAimWrite = 0;
let pointerActive = false;
let lastPointer = null;
let tiltEnabled = false;
let tiltBase = null;
let lastTiltUpdate = 0;
let tiltInvertX = false;
let tiltInvertY = false;
let sensorMode = 'yaw';
let removedByTeacher = false;
let penaltyUntil = 0;
let gripMode = 'portrait';
let fireSide = 'right';

async function boot() {
  try {
    if (!token) throw new Error('網址中沒有房間通行證。');
    const cred = await signInAnonymously(auth);
    uid = cred.user.uid;
    const snap = await get(ref(db, `joinPasses/${token}`));
    if (!snap.exists()) throw new Error('通行證不存在、已關閉或已到期。');
    pass = snap.val();
    room = pass.roomCode;
    $('roomInfo').classList.remove('hidden');
    $('gameName').textContent = pass.gameName;
    $('roomCode').textContent = room;
    $('timeInfo').textContent = `開放：${fmt(pass.opensAt)}　到期：${fmt(pass.expiresAt)}`;
    const now = Date.now();
    if (now < pass.opensAt) {
      $('status').className='notice info';
      $('status').textContent=`房間尚未開放，請於 ${fmt(pass.opensAt)} 後再加入。`;
      return;
    }
    $('status').className='notice ok';
    $('status').textContent='通行證有效。請輸入座號加入。';
    $('seatBox').classList.remove('hidden');
    $('continueBtn').addEventListener('click', joinGame);
  } catch (e) {
    $('status').className='notice error';
    $('status').textContent=e?.message || '無法加入房間。';
  }
}

async function joinGame() {
  seat = Number($('seat').value);
  if (!Number.isInteger(seat) || seat < 1 || seat > 99) {
    $('status').className='notice error';
    $('status').textContent='請輸入 1～99 的有效座號。';
    return;
  }
  $('continueBtn').disabled = true;
  try {
    const now = Date.now();
    const claim = { uid, joinToken:token, joinedAt:now };
    const access = { seat, joinToken:token, joinedAt:now };
    const writes = {};
    writes[`seatClaims/${room}/${seat}`] = claim;
    writes[`playerAccess/${room}/${uid}`] = access;
    await update(ref(db), writes);
    const oldShot = await get(ref(db, `playerShots/${room}/${uid}`));
    seq = Number(oldShot.val()?.seq || 0);

    $('status').className='notice ok';
    $('status').textContent=`座號 ${seat} 已加入。請看前方大螢幕。`;
    $('seatBox').classList.add('hidden');
    $('controller').classList.remove('hidden');
    $('seatLabel').textContent = seat;
    bindController();
    subscribeOwnAccess();
    subscribeParticipation();
    subscribeGame();
    subscribeScore();
  } catch (e) {
    const message = /permission/i.test(e?.message || '') ? `座號 ${seat} 可能已被其他同學使用，請確認座號後再試。` : (e?.message || '加入失敗。');
    $('status').className='notice error';
    $('status').textContent=message;
    $('continueBtn').disabled = false;
  }
}


function subscribeOwnAccess() {
  onValue(ref(db, `playerAccess/${room}/${uid}`), snap => {
    if (snap.exists() || removedByTeacher) return;
    removedByTeacher = true;
    isActivePlayer = false;
    $('fireBtn').disabled = true;
    $('controller').classList.add('hidden');
    $('seatBox').classList.add('hidden');
    $('status').className = 'notice error';
    $('status').textContent = `座號 ${seat} 已由教師釋放。請重新掃描教室 QR Code，再輸入正確座號加入。`;
    try {
      const cleanUrl = new URL('./join.html', window.location.href);
      cleanUrl.search = '';
      history.replaceState({}, '', cleanUrl.href);
    } catch {}
  });
}


function subscribeParticipation() {
  onValue(ref(db, `activePlayers/${room}/${uid}`), snap => {
    const wasActive = isActivePlayer;
    isActivePlayer = snap.val() === true;
    if (isActivePlayer && !wasActive) scheduleAimWrite(true);
    updateControllerState();
  }, () => {
    isActivePlayer = false;
    updateControllerState();
  });
}

function subscribeGame() {
  onValue(ref(db, `gameState/${room}`), snap => {
    gameState = snap.val() || { status:'waiting', remainingMs:60000 };
    updateControllerState();
  }, () => {
    $('gameMessage').className='notice error';
    $('gameMessage').textContent='房間已關閉或通行證已失效。';
    $('fireBtn').disabled = true;
  });
  setInterval(updateControllerState, 200);
}

function subscribeScore() {
  onValue(ref(db, `scores/${room}/${uid}`), snap => {
    const data=snap.val() || {};
    $('scoreLabel').textContent = Number(data.score || 0);
    penaltyUntil = Number(data.lockedUntil || 0);
    updateControllerState();
  });
}

function updateControllerState() {
  if (removedByTeacher) {
    $('fireBtn').disabled = true;
    return;
  }
  let remaining = Number(gameState.remainingMs ?? 60000);
  if (gameState.status === 'running' && Number.isFinite(gameState.endsAt)) remaining = Math.max(0, gameState.endsAt - Date.now());
  $('timeLabel').textContent = Math.ceil(remaining / 1000);
  const running = gameState.status === 'running' && remaining > 0;
  const canPlay = running && isActivePlayer;
  const now=Date.now();
  const penaltyRemaining=Math.max(0, penaltyUntil-now);
  $('fireBtn').disabled = !canPlay || now - lastFireLocal < 1000 || penaltyRemaining > 0;
  if (running && !isActivePlayer) {
    $('gameMessage').className='notice info';
    $('gameMessage').textContent='本局待命中：等待老師勾選你參加。這一局不會顯示你的準星，也不會計分。';
  } else if (penaltyRemaining > 0) {
    $('gameMessage').className='notice error';
    $('gameMessage').textContent=`誤射無理數，光線槍鎖定中：${(penaltyRemaining/1000).toFixed(1)} 秒。`;
  } else if (running) {
    $('gameMessage').className='notice ok';
    $('gameMessage').textContent=gameState.mode === 'coop'
      ? '合作模式：一起清除有理數，找出「過」「關」！'
      : '本局已上場：瞄準大螢幕上的有理數，按 FIRE！';
  } else if (gameState.status === 'paused') {
    $('gameMessage').className='notice info'; $('gameMessage').textContent='遊戲暫停。';
  } else if (gameState.status === 'finished') {
    $('gameMessage').className=gameState.mode === 'coop' && gameState.coopSuccess ? 'notice ok' : 'notice warn';
    $('gameMessage').textContent=gameState.mode === 'coop' && gameState.coopSuccess ? '合作成功！請看前方大螢幕。' : '時間到！請看大螢幕排行榜。';
  } else {
    $('gameMessage').className='notice info'; $('gameMessage').textContent='等待老師開始遊戲。';
  }
  const cooldown = Math.max(0, 1000 - (Date.now() - lastFireLocal));
  $('cooldownLabel').textContent = !running ? '等待遊戲' : !isActivePlayer ? '本局待命' : penaltyRemaining > 0 ? `鎖定 ${(penaltyRemaining/1000).toFixed(1)} 秒` : cooldown > 0 ? `${(cooldown/1000).toFixed(1)} 秒` : '可以射擊';
}

function bindController() {
  renderAimDot();
  const pad = $('aimPad');
  pad.addEventListener('pointerdown', e => {
    pointerActive = true; lastPointer = {x:e.clientX,y:e.clientY}; pad.setPointerCapture?.(e.pointerId); e.preventDefault();
  });
  pad.addEventListener('pointermove', e => {
    if (!pointerActive || !lastPointer) return;
    const rect = pad.getBoundingClientRect();
    const dx = (e.clientX-lastPointer.x) / Math.max(1,rect.width);
    const dy = (e.clientY-lastPointer.y) / Math.max(1,rect.height);
    lastPointer = {x:e.clientX,y:e.clientY};
    setAim(aim.x + dx*1.55, aim.y + dy*1.55);
    e.preventDefault();
  });
  const endPointer = () => { pointerActive=false; lastPointer=null; };
  pad.addEventListener('pointerup', endPointer); pad.addEventListener('pointercancel', endPointer); pad.addEventListener('pointerleave', e => { if (e.buttons===0) endPointer(); });
  $('centerBtn').addEventListener('click', () => setAim(.5,.5,true));
  $('fireBtn').addEventListener('click', fire);
  $('tiltBtn').addEventListener('click', toggleTilt);

  // 每支手機保留握持方式、FIRE 左右位置與感應反轉偏好。
  try {
    tiltInvertX = localStorage.getItem('classroomGameTiltInvertX') === '1';
    tiltInvertY = localStorage.getItem('classroomGameTiltInvertY') === '1';
    gripMode = localStorage.getItem('classroomGameGripMode') === 'landscape' ? 'landscape' : 'portrait';
    fireSide = localStorage.getItem('classroomGameFireSide') === 'left' ? 'left' : 'right';
  } catch {}
  applyGripMode(false);
  $('portraitModeBtn').addEventListener('click', () => setGripMode('portrait'));
  $('landscapeModeBtn').addEventListener('click', () => setGripMode('landscape'));
  $('fireLeftBtn').addEventListener('click', () => setFireSide('left'));
  $('fireRightBtn').addEventListener('click', () => setFireSide('right'));
  $('invertXToggle').checked = tiltInvertX;
  $('invertYToggle').checked = tiltInvertY;
  $('invertXToggle').addEventListener('change', () => {
    tiltInvertX = $('invertXToggle').checked;
    try { localStorage.setItem('classroomGameTiltInvertX', tiltInvertX ? '1' : '0'); } catch {}
    if (tiltEnabled) {
      recalibrateTilt();
      $('controllerHint').textContent = `左右方向已${tiltInvertX ? '反轉' : '恢復正常'}，並重新校正準星中心。`;
    }
  });
  $('invertYToggle').addEventListener('change', () => {
    tiltInvertY = $('invertYToggle').checked;
    try { localStorage.setItem('classroomGameTiltInvertY', tiltInvertY ? '1' : '0'); } catch {}
    if (tiltEnabled) {
      recalibrateTilt();
      $('controllerHint').textContent = `上下方向已${tiltInvertY ? '反轉' : '恢復正常'}，並重新校正準星中心。`;
    }
  });
  $('recenterTiltBtn').addEventListener('click', () => {
    if (!tiltEnabled) return;
    recalibrateTilt();
    $('controllerHint').textContent = '光線槍感應已重新校正：請把手機朝向螢幕中央，再開始左右旋轉與上下瞄準。';
  });
}

function setAim(x,y,force=false) {
  aim.x = clamp(x,.02,.98); aim.y=clamp(y,.02,.98);
  renderAimDot(); scheduleAimWrite(force);
}
function renderAimDot() { $('aimDot').style.left=`${aim.x*100}%`; $('aimDot').style.top=`${aim.y*100}%`; }
function scheduleAimWrite(force=false) {
  if (!isActivePlayer) return;
  const now = Date.now();
  const due = force ? 0 : Math.max(0, 100 - (now-lastAimWrite));
  if (aimWriteTimer) clearTimeout(aimWriteTimer);
  aimWriteTimer=setTimeout(async()=>{
    lastAimWrite=Date.now();
    try { await set(ref(db,`playerAim/${room}/${uid}`),{x:aim.x,y:aim.y,updatedAt:Date.now()}); } catch {}
  },due);
}

async function fire() {
  const now=Date.now();
  if (gameState.status !== 'running' || !isActivePlayer) return;
  if (now < penaltyUntil) return;
  if (now-lastFireLocal < 1000) return;
  lastFireLocal=now;
  seq += 1;
  $('fireBtn').disabled=true;
  if (navigator.vibrate) navigator.vibrate(35);
  try {
    await set(ref(db,`playerShots/${room}/${uid}`),{ seq, x:aim.x, y:aim.y, shotAt:serverTimestamp() });
  } catch (e) {
    $('gameMessage').className='notice error';
    $('gameMessage').textContent='射擊送出失敗，請稍後再試。';
  }
  updateControllerState();
}

async function toggleTilt() {
  if (tiltEnabled) {
    disableTilt();
    return;
  }
  await enableTilt();
}

async function enableTilt() {
  try {
    if (typeof DeviceOrientationEvent === 'undefined') throw new Error('此手機瀏覽器沒有提供方向感測器。');
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r !== 'granted') throw new Error('未取得方向感測器權限。');
    }
    tiltBase = null;
    tiltEnabled = true;
    sensorMode = 'yaw';
    window.removeEventListener('deviceorientation', onOrientation);
    window.addEventListener('deviceorientation', onOrientation, { passive:true });
    $('tiltBtn').textContent = '關閉光線槍感應';
    $('tiltBtn').classList.add('sensor-active');
    $('recenterTiltBtn').disabled = false;
    $('controllerHint').textContent = sensorInstruction('尚未校正：請先把手機朝向螢幕中央並保持自然握姿。');
  } catch (e) {
    tiltEnabled = false;
    $('tiltBtn').textContent = '啟用光線槍感應';
    $('tiltBtn').classList.remove('sensor-active');
    $('recenterTiltBtn').disabled = true;
    $('controllerHint').textContent=`光線槍感應無法啟用：${e?.message || '不支援'}。仍可使用拖曳瞄準。`;
  }
}

function disableTilt() {
  tiltEnabled = false;
  tiltBase = null;
  sensorMode = 'yaw';
  window.removeEventListener('deviceorientation', onOrientation);
  $('tiltBtn').textContent = '啟用光線槍感應';
  $('tiltBtn').classList.remove('sensor-active');
  $('recenterTiltBtn').disabled = true;
  $('controllerHint').textContent = '光線槍感應已關閉；目前可使用觸控區拖曳準星。';
}

function sensorInstruction(prefix = '已校正。') {
  return gripMode === 'landscape'
    ? `${prefix} 橫式握持：左右旋轉手機控制左右；上下抬壓手機控制上下。`
    : `${prefix} 直式握持：左右旋轉手機控制左右；上下抬壓手機控制上下。`;
}

function onOrientation(e) {
  if (!tiltEnabled) return;
  const now=Date.now(); if (now-lastTiltUpdate<70) return; lastTiltUpdate=now;

  const hasAlpha = Number.isFinite(e.alpha);
  const hasBeta = Number.isFinite(e.beta);
  const hasGamma = Number.isFinite(e.gamma);
  if (!hasBeta && !hasGamma) return;
  if (!hasAlpha && !hasBeta && !hasGamma) return;

  if (!tiltBase) {
    sensorMode = hasAlpha ? 'yaw' : 'fallback';
    tiltBase = {
      alpha: hasAlpha ? e.alpha : null,
      beta: hasBeta ? e.beta : null,
      gamma: hasGamma ? e.gamma : null
    };
    setAim(.5,.5,true);
    $('controllerHint').textContent = sensorMode === 'yaw'
      ? sensorInstruction('已校正。')
      : `此手機未提供方位角，已改用傾斜備援模式。${gripMode === 'landscape' ? '橫式握持可用上下／左右傾斜控制。' : '直式握持可用左右／上下傾斜控制。'}`;
    return;
  }

  let horizontalDelta = 0;
  if (sensorMode === 'yaw' && hasAlpha && Number.isFinite(tiltBase.alpha)) {
    horizontalDelta = -angleDelta(e.alpha, tiltBase.alpha);
  } else if (gripMode === 'landscape' && hasBeta && Number.isFinite(tiltBase.beta)) {
    horizontalDelta = angleDelta(e.beta, tiltBase.beta);
  } else if (hasGamma && Number.isFinite(tiltBase.gamma)) {
    horizontalDelta = angleDelta(e.gamma, tiltBase.gamma);
  } else {
    return;
  }

  let verticalDelta = 0;
  if (gripMode === 'landscape' && hasGamma && Number.isFinite(tiltBase.gamma)) {
    verticalDelta = angleDelta(e.gamma, tiltBase.gamma);
  } else if (hasBeta && Number.isFinite(tiltBase.beta)) {
    verticalDelta = angleDelta(e.beta, tiltBase.beta);
  } else {
    return;
  }

  const xDirection = tiltInvertX ? -1 : 1;
  const yDirection = tiltInvertY ? 1 : -1;
  setAim(.5 + xDirection * horizontalDelta / 70, .5 + yDirection * verticalDelta / 50);
}

function recalibrateTilt() {
  tiltBase = null;
  setAim(.5,.5,true);
}

function setGripMode(mode) {
  gripMode = mode === 'landscape' ? 'landscape' : 'portrait';
  try { localStorage.setItem('classroomGameGripMode', gripMode); } catch {}
  applyGripMode(true);
}

function setFireSide(side) {
  fireSide = side === 'left' ? 'left' : 'right';
  try { localStorage.setItem('classroomGameFireSide', fireSide); } catch {}
  applyGripMode(false);
}

function applyGripMode(recalibrate = true) {
  const landscape = gripMode === 'landscape';
  const core = $('controllerCore');
  core.classList.toggle('portrait-layout', !landscape);
  core.classList.toggle('landscape-layout', landscape);
  core.classList.toggle('fire-left', landscape && fireSide === 'left');
  core.classList.toggle('fire-right', !landscape || fireSide === 'right');
  document.body.classList.toggle('controller-landscape-mode', landscape);
  $('fireSideChooser').classList.toggle('hidden', !landscape);

  $('portraitModeBtn').classList.toggle('active', !landscape);
  $('landscapeModeBtn').classList.toggle('active', landscape);
  $('portraitModeBtn').setAttribute('aria-pressed', String(!landscape));
  $('landscapeModeBtn').setAttribute('aria-pressed', String(landscape));
  $('fireLeftBtn').classList.toggle('active', fireSide === 'left');
  $('fireRightBtn').classList.toggle('active', fireSide === 'right');
  $('fireLeftBtn').setAttribute('aria-pressed', String(fireSide === 'left'));
  $('fireRightBtn').setAttribute('aria-pressed', String(fireSide === 'right'));

  if (tiltEnabled && recalibrate) {
    recalibrateTilt();
    $('controllerHint').textContent = sensorInstruction('握持方式已切換，感應中心已重新校正。');
  }
}
function angleDelta(a,b) { let d=a-b; while(d>180)d-=360; while(d<-180)d+=360; return d; }

boot();
