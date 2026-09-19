import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { getDatabase, ref, get } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';
const app=initializeApp(firebaseConfig),auth=getAuth(app),db=getDatabase(app);
const status=document.getElementById('status'),info=document.getElementById('info');
const token=new URLSearchParams(location.search).get('t');
const fmt=ms=>new Intl.DateTimeFormat('zh-TW',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(ms));
(async()=>{try{if(!token)throw new Error('網址中沒有教師控制通行證。');await signInAnonymously(auth);const snap=await get(ref(db,`hostPasses/${token}`));if(!snap.exists())throw new Error('教師控制連結不存在、已關閉或已到期。');const p=snap.val();document.getElementById('game').textContent=p.gameName;document.getElementById('code').textContent=p.roomCode;document.getElementById('time').textContent=`開放：${fmt(p.opensAt)}　到期：${fmt(p.expiresAt)}`;info.classList.remove('hidden');status.className='notice ok';status.textContent='教師控制通行證有效。';}catch(e){status.className='notice error';status.textContent=e.message||'無法開啟教師控制頁。';}})();
