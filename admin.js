import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect,
  onAuthStateChanged, signOut
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  getDatabase, ref, get, update, onValue
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';
import { games } from './games.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({ prompt: 'select_account' });

const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60_000;
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
const historyCount = $('historyCount');
const historyRooms = $('historyRooms');
const clearHistoryBtn = $('clearHistoryBtn');

let currentUser = null;
let isAdmin = false;
let roomsUnsub = null;
let historyUnsub = null;
const archivingRooms = new Set();
const pruningHistory = new Set();
const hostPassBackfilled = new Set();

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
      setNotice('error', '目前網域尚未加入 Firebase Authentication 的 Authorized domains。請把 <b>你的帳號.github.io</b> 加入允許網域。');
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
refreshBtn.addEventListener('click', () => {
  subscribeRooms(true);
  subscribeHistory(true);
});
clearHistoryBtn.addEventListener('click', clearAllHistory);

onAuthStateChanged(auth, async (user) => {
  currentUser = user;
  isAdmin = false;
  if (roomsUnsub) { roomsUnsub(); roomsUnsub = null; }
  if (historyUnsub) { historyUnsub(); historyUnsub = null; }
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
      setNotice('ok', '管理員身分驗證成功。你可以建立、延長、關閉與清理遊戲房間。');
      createSection.classList.remove('hidden');
      roomsSection.classList.remove('hidden');
      subscribeRooms();
      subscribeHistory();
    } else {
      setNotice('warn', '已取得你的 UID，但這個帳號尚未列入管理員名單。');
    }
  } catch (err) {
    if (err?.code === 'PERMISSION_DENIED' || /permission/i.test(err?.message || '')) {
      setNotice('warn', '登入成功，但目前 Realtime Database 規則尚未允許管理中心讀取管理員資料。');
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
    const [roomSnap, histSnap] = await Promise.all([
      get(ref(db, `rooms/${code}`)),
      get(ref(db, `roomHistory/${code}`))
    ]);
    if (!roomSnap.exists() && !histSnap.exists()) return code;
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
    updates[`hostPasses/${hostToken}`] = { ...passBase, joinToken };
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
  roomsUnsub = onValue(ref(db, 'rooms'), snap => {
    const data = snap.val() || {};
    const allRooms = Object.values(data);
    const liveRooms = [];
    for (const room of allRooms) {
      const [state] = roomState(room);
      if (state === 'closed' || state === 'expired') {
        const reason = state === 'expired' ? 'expired' : 'closed';
        archiveAndCleanupRoom(room, reason, { silent: true }).catch(() => {});
      } else {
        liveRooms.push(room);
        ensureHostPassJoinToken(room).catch(() => {});
      }
    }
    renderRooms(liveRooms);
  }, err => {
    roomsEl.innerHTML = `<div class="notice error">讀取房間失敗：${safeText(err.message)}</div>`;
  });
}

function subscribeHistory(force = false) {
  if (!currentUser || !isAdmin) return;
  if (historyUnsub && !force) return;
  if (historyUnsub) { historyUnsub(); historyUnsub = null; }
  historyUnsub = onValue(ref(db, 'roomHistory'), snap => {
    const data = snap.val() || {};
    const records = Object.values(data);
    const cutoff = Date.now() - HISTORY_RETENTION_MS;
    for (const record of records) {
      const endedAt = Number(record.endedAt || record.archivedAt || 0);
      if (endedAt && endedAt < cutoff) {
        pruneHistoryRecord(record.roomCode).catch(() => {});
      }
    }
    const visible = records.filter(r => {
      const endedAt = Number(r.endedAt || r.archivedAt || 0);
      return !endedAt || endedAt >= cutoff;
    });
    renderHistory(visible);
  }, err => {
    historyRooms.innerHTML = `<div class="notice error">讀取歷史房間失敗：${safeText(err.message)}</div>`;
  });
}


async function ensureHostPassJoinToken(room) {
  if (!room?.hostToken || !room?.joinToken || hostPassBackfilled.has(room.hostToken)) return;
  hostPassBackfilled.add(room.hostToken);
  try {
    await update(ref(db, `hostPasses/${room.hostToken}`), { joinToken: room.joinToken });
  } catch (err) {
    hostPassBackfilled.delete(room.hostToken);
    throw err;
  }
}

function renderRooms(rooms) {
  if (!rooms.length) {
    roomsEl.innerHTML = '<div class="muted empty-state">目前沒有尚未開放或使用中的房間。</div>';
    return;
  }
  rooms.sort((a,b) => (b.createdAt || 0) - (a.createdAt || 0));
  roomsEl.innerHTML = '';
  for (const room of rooms) {
    const [stateClass, stateLabel] = roomState(room);
    const gameConfig = games.find(g => g.id === room.gameId) || games[0];
    const studentPage = gameConfig?.joinPage || './join.html';
    const hostPage = gameConfig?.hostPage || './host.html';
    const studentUrl = `${baseUrl(studentPage)}?t=${encodeURIComponent(room.joinToken)}`;
    const hostUrl = `${baseUrl(hostPage)}?t=${encodeURIComponent(room.hostToken)}`;
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
        <button class="btn success extend-btn">延長</button>
        <button class="btn danger close-btn">立即關閉</button>
      </div>`;
    const qr = el.querySelector('.qr');
    if (window.QRCode) new QRCode(qr, { text: studentUrl, width: 134, height: 134 });
    el.querySelector('.copy-student').addEventListener('click', e => copyText(studentUrl, e.currentTarget));
    el.querySelector('.copy-host').addEventListener('click', e => copyText(hostUrl, e.currentTarget));
    el.querySelector('.extend-btn').addEventListener('click', () => extendRoom(room, Number(el.querySelector('.extend-select').value)));
    el.querySelector('.close-btn').addEventListener('click', () => archiveAndCleanupRoom(room, 'closed'));
    roomsEl.appendChild(el);
  }
}

function renderHistory(records) {
  records.sort((a,b) => Number(b.endedAt || b.archivedAt || 0) - Number(a.endedAt || a.archivedAt || 0));
  historyCount.textContent = String(records.length);
  clearHistoryBtn.disabled = records.length === 0;
  if (!records.length) {
    historyRooms.innerHTML = '<div class="muted empty-state">尚無歷史房間。</div>';
    return;
  }
  historyRooms.innerHTML = '';
  for (const record of records) {
    const reasonText = record.reason === 'expired' ? '自動到期' : '已關閉';
    const el = document.createElement('article');
    el.className = 'history-room';
    el.innerHTML = `
      <div class="history-main">
        <div><b class="room-code">${safeText(record.roomCode)}</b><span>${safeText(record.gameName || record.gameId || '遊戲')}</span></div>
        <span class="badge closed">${reasonText}</span>
      </div>
      <div class="history-meta">
        <span>建立：${formatDate(record.createdAt)}</span>
        <span>開放：${formatDate(record.opensAt)}</span>
        <span>結束：${formatDate(record.endedAt || record.archivedAt)}</span>
      </div>
      <button class="btn ghost delete-history">刪除紀錄</button>`;
    el.querySelector('.delete-history').addEventListener('click', () => {
      if (confirm(`確定刪除歷史房間 ${record.roomCode} 的紀錄？`)) pruneHistoryRecord(record.roomCode);
    });
    historyRooms.appendChild(el);
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

async function archiveAndCleanupRoom(room, reason = 'closed', options = {}) {
  if (!room?.roomCode || archivingRooms.has(room.roomCode)) return;
  if (!options.silent && !confirm(`確定立即關閉房間 ${room.roomCode}？學生與教師連結會立刻失效，遊戲即時資料會被清除。`)) return;
  archivingRooms.add(room.roomCode);
  try {
    const endedAt = reason === 'expired' ? Number(room.expiresAt || Date.now()) : Date.now();
    const history = {
      roomCode: room.roomCode,
      gameId: room.gameId || '',
      gameName: room.gameName || '',
      status: 'history',
      reason,
      createdAt: Number(room.createdAt || 0),
      opensAt: Number(room.opensAt || 0),
      expiresAt: Number(room.expiresAt || 0),
      endedAt,
      archivedAt: Date.now()
    };
    const updates = {};
    updates[`roomHistory/${room.roomCode}`] = history;
    updates[`rooms/${room.roomCode}`] = null;
    if (room.joinToken) updates[`joinPasses/${room.joinToken}`] = null;
    if (room.hostToken) updates[`hostPasses/${room.hostToken}`] = null;
    updates[`roomHosts/${room.roomCode}`] = null;
    updates[`seatClaims/${room.roomCode}`] = null;
    updates[`playerAccess/${room.roomCode}`] = null;
    updates[`playerAim/${room.roomCode}`] = null;
    updates[`playerShots/${room.roomCode}`] = null;
    updates[`activePlayers/${room.roomCode}`] = null;
    updates[`gameState/${room.roomCode}`] = null;
    updates[`scores/${room.roomCode}`] = null;
    updates[`trigAssignments/${room.roomCode}`] = null;
    updates[`trigPrivate/${room.roomCode}`] = null;
    updates[`trigCandidates/${room.roomCode}`] = null;
    updates[`trigAnswers/${room.roomCode}`] = null;
    updates[`trigResults/${room.roomCode}`] = null;
    await update(ref(db), updates);
  } catch (err) {
    if (!options.silent) alert(`清理房間失敗：${err?.message || err}`);
  } finally {
    archivingRooms.delete(room.roomCode);
  }
}

async function pruneHistoryRecord(roomCode) {
  if (!roomCode || pruningHistory.has(roomCode)) return;
  pruningHistory.add(roomCode);
  try {
    await update(ref(db), { [`roomHistory/${roomCode}`]: null });
  } finally {
    pruningHistory.delete(roomCode);
  }
}

async function clearAllHistory() {
  if (!currentUser || !isAdmin) return;
  const snap = await get(ref(db, 'roomHistory'));
  if (!snap.exists()) return;
  if (!confirm('確定清除全部歷史房間紀錄？這不會影響目前使用中的房間。')) return;
  const updates = {};
  for (const roomCode of Object.keys(snap.val() || {})) updates[`roomHistory/${roomCode}`] = null;
  await update(ref(db), updates);
}
