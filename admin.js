import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  onAuthStateChanged, signOut
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  getDatabase, ref, get, set, update, onValue
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';
import { games } from './games.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: 'select_account' });

const $ = (id) => document.getElementById(id);
const loginBtn = $('loginBtn');
const logoutBtn = $('logoutBtn');
const userLabel = $('userLabel');
const authMessage = $('authMessage');
const uidPanel = $('uidPanel');
const uidValue = $('uidValue');
const copyUidBtn = $('copyUidBtn');
const createSection = $('createSection');
const roomsSection = $('roomsSection');
const gameSelect = $('gameSelect');
const startMode = $('startMode');
const startTimeField = $('startTimeField');
const startTime = $('startTime');
const duration = $('duration');
const customExpiryField = $('customExpiryField');
const customExpiry = $('customExpiry');
const createRoomBtn = $('createRoomBtn');
const createMessage = $('createMessage');
const roomsEl = $('rooms');
const refreshBtn = $('refreshBtn');

let currentUser = null;
let isAdmin = false;
let roomsUnsub = null;

for (const game of games.filter(g => g.enabled)) {
  const option = document.createElement('option');
  option.value = game.id;
  option.textContent = game.name;
  gameSelect.appendChild(option);
}

function setNotice(type, html) {
  authMessage.className = `notice ${type}`;
  authMessage.innerHTML = html;
}

function safeText(s) {
  return String(s ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

function formatDate(ms) {
  if (!Number.isFinite(ms)) return '—';
  return new Intl.DateTimeFormat('zh-TW', {
    year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false
  }).format(new Date(ms));
}

function setDefaultDateTimes() {
  const now = new Date();
  const plus15 = new Date(now.getTime() + 15 * 60_000);
  const plus27 = new Date(now.getTime() + 27 * 60 * 60_000);
  const localInput = d => {
    const pad = n => String(n).padStart(2,'0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  startTime.value = localInput(plus15);
  customExpiry.value = localInput(plus27);
}
setDefaultDateTimes();

startMode.addEventListener('change', () => {
  startTimeField.classList.toggle('hidden', startMode.value !== 'custom');
});
duration.addEventListener('change', () => {
  customExpiryField.classList.toggle('hidden', duration.value !== 'custom');
});

loginBtn.addEventListener('click', async () => {
  try {
    await signInWithPopup(auth, provider);
  } catch (err) {
    if (['auth/popup-blocked','auth/cancelled-popup-request'].includes(err.code)) {
      await signInWithRedirect(auth, provider);
      return;
    }
    if (err.code === 'auth/unauthorized-domain') {
      setNotice('error', '目前網域尚未加入 Firebase Authentication 的 Authorized domains。部署到 GitHub Pages 後，把 <b>你的帳號.github.io</b> 加入允許網域即可。');
      return;
    }
    setNotice('error', `Google 登入失敗：${safeText(err.message)}`);
  }
});

logoutBtn.addEventListener('click', () => signOut(auth));
copyUidBtn.addEventListener('click', async () => {
  if (!currentUser) return;
  await navigator.clipboard.writeText(currentUser.uid);
  copyUidBtn.textContent = '已複製';
  setTimeout(() => copyUidBtn.textContent = '複製 UID', 1200);
});
refreshBtn.addEventListener('click', () => subscribeRooms(true));

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  isAdmin = false;
  if (roomsUnsub) { roomsUnsub(); roomsUnsub = null; }
  createSection.classList.add('hidden');
  roomsSection.classList.add('hidden');

  if (!user) {
    userLabel.textContent = '尚未登入';
    loginBtn.classList.remove('hidden');
    logoutBtn.classList.add('hidden');
    uidPanel.classList.add('hidden');
    setNotice('info', '請先使用你的 Google 帳號登入。第一次登入後，這裡會顯示 Firebase UID。');
    return;
  }

  userLabel.textContent = user.email || user.displayName || '已登入';
  loginBtn.classList.add('hidden');
  logoutBtn.classList.remove('hidden');
  uidPanel.classList.remove('hidden');
  uidValue.textContent = user.uid;

  try {
    const adminSnap = await get(ref(db, `admins/${user.uid}`));
    isAdmin = adminSnap.val() === true;
    if (isAdmin) {
      setNotice('ok', '管理員身分驗證成功。你可以建立、延長與關閉遊戲房間。');
      createSection.classList.remove('hidden');
      roomsSection.classList.remove('hidden');
      subscribeRooms();
    } else {
      setNotice('warn', '已取得你的 UID，但這個帳號尚未列入管理員名單。請把上方 UID 提供給我，完成 Firebase 管理員設定後，這裡會自動開啟房間管理功能。');
    }
  } catch (err) {
    if (err?.code === 'PERMISSION_DENIED' || /permission/i.test(err?.message || '')) {
      setNotice('warn', '登入成功，UID 已取得。目前 Realtime Database 仍是鎖定模式／尚未套用管理中心 Security Rules，所以房間功能暫時不會開啟。請把 UID 提供給我即可進行下一步。');
    } else {
      setNotice('error', `檢查管理員身分時發生錯誤：${safeText(err.message)}`);
    }
  }
});

function randomChars(length) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
}

function randomToken(bytesLength = 18) {
  const bytes = new Uint8Array(bytesLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2,'0')).join('');
}

async function generateRoomCode() {
  for (let i = 0; i < 12; i++) {
    const code = randomChars(4);
    const snap = await get(ref(db, `rooms/${code}`));
    if (!snap.exists()) return code;
  }
  throw new Error('無法產生唯一房間碼，請再試一次。');
}

function resolveTimes() {
  const now = Date.now();
  let opensAt = now;
  if (startMode.value === 'custom') {
    opensAt = new Date(startTime.value).getTime();
    if (!Number.isFinite(opensAt)) throw new Error('請設定有效的開始時間。');
  }
  if (opensAt < now - 60_000) throw new Error('開始時間不能早於目前時間。');

  let expiresAt;
  if (duration.value === 'custom') {
    expiresAt = new Date(customExpiry.value).getTime();
    if (!Number.isFinite(expiresAt)) throw new Error('請設定有效的到期時間。');
  } else {
    expiresAt = opensAt + Number(duration.value) * 60 * 60_000;
  }
  if (expiresAt <= opensAt) throw new Error('到期時間必須晚於開始時間。');
  return { opensAt, expiresAt };
}

createRoomBtn.addEventListener('click', async () => {
  if (!currentUser || !isAdmin) return;
  createRoomBtn.disabled = true;
  createMessage.innerHTML = '';
  try {
    const game = games.find(g => g.id === gameSelect.value);
    if (!game) throw new Error('找不到遊戲設定。');
    const { opensAt, expiresAt } = resolveTimes();
    const roomCode = await generateRoomCode();
    const joinToken = randomToken(18);
    const hostToken = randomToken(22);
    const createdAt = Date.now();
    const roomData = {
      roomCode,
      gameId: game.id,
      gameName: game.name,
      status: 'open',
      createdAt,
      opensAt,
      expiresAt,
      createdBy: currentUser.uid,
      joinToken,
      hostToken
    };
    const passBase = {
      roomCode,
      gameId: game.id,
      gameName: game.name,
      status: 'active',
      opensAt,
      expiresAt
    };
    const updates = {};
    updates[`rooms/${roomCode}`] = roomData;
    updates[`joinPasses/${joinToken}`] = passBase;
    updates[`hostPasses/${hostToken}`] = passBase;
    await update(ref(db), updates);
    createMessage.innerHTML = `<div class="notice ok">房間 <b>${roomCode}</b> 已建立。</div>`;
  } catch (err) {
    createMessage.innerHTML = `<div class="notice error">建立失敗：${safeText(err.message)}</div>`;
  } finally {
    createRoomBtn.disabled = false;
  }
});

function roomState(room) {
  const now = Date.now();
  if (room.status === 'closed') return ['closed', '已關閉'];
  if (now >= room.expiresAt) return ['expired', '已到期'];
  if (now < room.opensAt) return ['scheduled', '尚未開放'];
  return ['active', '使用中'];
}

function baseUrl(file) {
  return new URL(file, window.location.href).href;
}

function subscribeRooms(force = false) {
  if (!currentUser || !isAdmin) return;
  if (roomsUnsub && !force) return;
  if (roomsUnsub) { roomsUnsub(); roomsUnsub = null; }
  const roomsRef = ref(db, 'rooms');
  roomsUnsub = onValue(roomsRef, snap => {
    const data = snap.val() || {};
    renderRooms(Object.values(data));
  }, err => {
    roomsEl.innerHTML = `<div class="notice error">讀取房間失敗：${safeText(err.message)}</div>`;
  });
}

function renderRooms(rooms) {
  if (!rooms.length) {
    roomsEl.innerHTML = '<div class="muted">目前尚無房間。</div>';
    return;
  }
  rooms.sort((a,b) => (b.createdAt || 0) - (a.createdAt || 0));
  roomsEl.innerHTML = '';
  for (const room of rooms) {
    const [stateClass, stateLabel] = roomState(room);
    const studentUrl = `${baseUrl('./join.html')}?t=${encodeURIComponent(room.joinToken)}`;
    const hostUrl = `${baseUrl('./host.html')}?t=${encodeURIComponent(room.hostToken)}`;
    const el = document.createElement('article');
    el.className = 'room';
    el.innerHTML = `
      <div class="room-head">
        <div><div class="room-code">${safeText(room.roomCode)}</div><div>${safeText(room.gameName)}</div></div>
        <span class="badge ${stateClass}">${stateLabel}</span>
      </div>
      <div class="room-meta">
        <div><small>開放時間</small>${formatDate(room.opensAt)}</div>
        <div><small>到期時間</small>${formatDate(room.expiresAt)}</div>
        <div><small>建立時間</small>${formatDate(room.createdAt)}</div>
      </div>
      <div class="room-links">
        <div class="linkbox"><label>學生加入網址</label><div class="linkrow"><input readonly value="${safeText(studentUrl)}"><button class="btn copy-student">複製</button></div></div>
        <div class="linkbox"><label>教師控制網址</label><div class="linkrow"><input readonly value="${safeText(hostUrl)}"><button class="btn copy-host">複製</button></div></div>
      </div>
      <div class="qr-wrap"><div class="qr"></div><div class="muted">學生掃描此 QR Code 即可取得這個房間的通行證。</div></div>
      <div class="actions">
        <select class="extend-select" style="width:auto; min-width:150px">
          <option value="1">延長 1 小時</option><option value="3">延長 3 小時</option><option value="6">延長 6 小時</option><option value="12">延長 12 小時</option><option value="24">延長 24 小時</option><option value="27">延長 27 小時</option><option value="48">延長 48 小時</option>
        </select>
        <button class="btn success extend-btn" ${stateClass==='closed'?'disabled':''}>延長</button>
        <button class="btn danger close-btn" ${stateClass==='closed'?'disabled':''}>立即關閉</button>
      </div>`;
    const qr = el.querySelector('.qr');
    if (window.QRCode) new QRCode(qr, { text: studentUrl, width: 134, height: 134 });
    el.querySelector('.copy-student').addEventListener('click', e => copyText(studentUrl, e.currentTarget));
    el.querySelector('.copy-host').addEventListener('click', e => copyText(hostUrl, e.currentTarget));
    el.querySelector('.extend-btn').addEventListener('click', () => extendRoom(room, Number(el.querySelector('.extend-select').value)));
    el.querySelector('.close-btn').addEventListener('click', () => closeRoom(room));
    roomsEl.appendChild(el);
  }
}

async function copyText(text, btn) {
  await navigator.clipboard.writeText(text);
  const old = btn.textContent;
  btn.textContent = '已複製';
  setTimeout(() => btn.textContent = old, 1000);
}

async function extendRoom(room, hours) {
  if (!confirm(`要將房間 ${room.roomCode} 延長 ${hours} 小時嗎？`)) return;
  const newExpiry = Math.max(Date.now(), room.expiresAt || 0) + hours * 60 * 60_000;
  const updates = {};
  updates[`rooms/${room.roomCode}/expiresAt`] = newExpiry;
  updates[`joinPasses/${room.joinToken}/expiresAt`] = newExpiry;
  updates[`hostPasses/${room.hostToken}/expiresAt`] = newExpiry;
  await update(ref(db), updates);
}

async function closeRoom(room) {
  if (!confirm(`確定立即關閉房間 ${room.roomCode}？關閉後舊 QR Code 將失效。`)) return;
  const updates = {};
  updates[`rooms/${room.roomCode}/status`] = 'closed';
  updates[`rooms/${room.roomCode}/closedAt`] = Date.now();
  updates[`joinPasses/${room.joinToken}/status`] = 'closed';
  updates[`hostPasses/${room.hostToken}/status`] = 'closed';
  updates[`gameState/${room.roomCode}/status`] = 'closed';
  updates[`gameState/${room.roomCode}/updatedAt`] = Date.now();
  await update(ref(db), updates);
}
