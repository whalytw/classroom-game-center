import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import { getDatabase, ref, get } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';
const app=initializeApp(firebaseConfig), auth=getAuth(app), db=getDatabase(app);
const status=document.getElementById('status'), info=document.getElementById('roomInfo'), gameName=document.getElementById('gameName'), roomCode=document.getElementById('roomCode'), timeInfo=document.getElementById('timeInfo'), seatBox=document.getElementById('seatBox');
const token=new URLSearchParams(location.search).get('t');
const fmt=ms=>new Intl.DateTimeFormat('zh-TW',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(ms));
(async()=>{
 try{
   if(!token) throw new Error('網址中沒有房間通行證。');
   await signInAnonymously(auth);
   const snap=await get(ref(db,`joinPasses/${token}`));
   if(!snap.exists()) throw new Error('通行證不存在、已關閉或已到期。');
   const p=snap.val(), now=Date.now();
   info.classList.remove('hidden'); gameName.textContent=p.gameName; roomCode.textContent=p.roomCode;
   timeInfo.textContent=`開放：${fmt(p.opensAt)}　到期：${fmt(p.expiresAt)}`;
   if(now < p.opensAt){ status.className='notice info'; status.textContent=`房間尚未開放，請於 ${fmt(p.opensAt)} 後再加入。`; }
   else { status.className='notice ok'; status.textContent='通行證有效。'; seatBox.classList.remove('hidden'); }
   document.getElementById('continueBtn').addEventListener('click',()=>{
     const seat=Number(document.getElementById('seat').value);
     if(!Number.isInteger(seat)||seat<1||seat>99){ alert('請輸入有效座號。'); return; }
     status.className='notice ok'; status.textContent=`座號 ${seat} 已確認。下一版會在此直接進入「${p.gameName}」。`;
   });
 }catch(e){ status.className='notice error'; status.textContent=e.message||'無法加入房間。'; }
})();
