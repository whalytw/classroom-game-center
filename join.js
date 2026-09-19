import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  getDatabase, ref, get, update, set, onValue, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';

const app = initializeApp(firebaseConfig);
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
let lastFireLocal = 0;
let aimWriteTimer = null;
let lastAimWrite = 0;
let pointerActive = false;
let lastPointer = null;
let tiltEnabled = false;
let tiltBase = null;
let lastTiltUpdate = 0;

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
    await set(ref(db, `playerAim/${room}/${uid}`), { x:.5, y:.5, updatedAt:Date.now() });

    $('status').className='notice ok';
    $('status').textContent=`座號 ${seat} 已加入。請看前方大螢幕。`;
    $('seatBox').classList.add('hidden');
    $('controller').classList.remove('hidden');
    $('seatLabel').textContent = seat;
    bindController();
    subscribeGame();
    subscribeScore();
  } catch (e) {
    const message = /permission/i.test(e?.message || '') ? `座號 ${seat} 可能已被其他同學使用，請確認座號後再試。` : (e?.message || '加入失敗。');
    $('status').className='notice error';
    $('status').textContent=message;
    $('continueBtn').disabled = false;
  }
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
    $('scoreLabel').textContent = Number(snap.val()?.score || 0);
  });
}

function updateControllerState() {
  let remaining = Number(gameState.remainingMs ?? 60000);
  if (gameState.status === 'running' && Number.isFinite(gameState.endsAt)) remaining = Math.max(0, gameState.endsAt - Date.now());
  $('timeLabel').textContent = Math.ceil(remaining / 1000);
  const running = gameState.status === 'running' && remaining > 0;
  $('fireBtn').disabled = !running || Date.now() - lastFireLocal < 1000;
  if (running) {
    $('gameMessage').className='notice ok';
    $('gameMessage').textContent='遊戲進行中：瞄準大螢幕上的有理數，按 FIRE！';
  } else if (gameState.status === 'paused') {
    $('gameMessage').className='notice info'; $('gameMessage').textContent='遊戲暫停。';
  } else if (gameState.status === 'finished') {
    $('gameMessage').className='notice warn'; $('gameMessage').textContent='時間到！請看大螢幕排行榜。';
  } else {
    $('gameMessage').className='notice info'; $('gameMessage').textContent='等待老師開始遊戲。';
  }
  const cooldown = Math.max(0, 1000 - (Date.now() - lastFireLocal));
  $('cooldownLabel').textContent = !running ? '等待遊戲' : cooldown > 0 ? `${(cooldown/1000).toFixed(1)} 秒` : '可以射擊';
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
  $('tiltBtn').addEventListener('click', enableTilt);
}

function setAim(x,y,force=false) {
  aim.x = clamp(x,.02,.98); aim.y=clamp(y,.02,.98);
  renderAimDot(); scheduleAimWrite(force);
}
function renderAimDot() { $('aimDot').style.left=`${aim.x*100}%`; $('aimDot').style.top=`${aim.y*100}%`; }
function scheduleAimWrite(force=false) {
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
  if (gameState.status !== 'running') return;
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

async function enableTilt() {
  try {
    if (typeof DeviceOrientationEvent === 'undefined') throw new Error('此手機瀏覽器沒有提供方向感測器。');
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r !== 'granted') throw new Error('未取得方向感測器權限。');
    }
    tiltBase=null; tiltEnabled=true;
    window.addEventListener('deviceorientation', onOrientation, { passive:true });
    $('tiltBtn').textContent='傾斜瞄準已啟用';
    $('tiltBtn').disabled=true;
  } catch (e) {
    $('controllerHint').textContent=`傾斜瞄準無法啟用：${e?.message || '不支援'}。仍可使用拖曳瞄準。`;
  }
}
function onOrientation(e) {
  if (!tiltEnabled || !Number.isFinite(e.gamma) || !Number.isFinite(e.beta)) return;
  const now=Date.now(); if (now-lastTiltUpdate<70) return; lastTiltUpdate=now;
  if (!tiltBase) { tiltBase={gamma:e.gamma,beta:e.beta}; return; }
  const dg = angleDelta(e.gamma,tiltBase.gamma), db = angleDelta(e.beta,tiltBase.beta);
  setAim(.5 + dg/52, .5 + db/52);
}
function angleDelta(a,b) { let d=a-b; while(d>180)d-=360; while(d<-180)d+=360; return d; }

boot();
