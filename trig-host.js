import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  getDatabase, ref, get, set, update, onValue, onChildAdded, onChildChanged
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';

const app = initializeApp(firebaseConfig, 'trig-host-control');
const auth = getAuth(app);
const db = getDatabase(app);
const $ = id => document.getElementById(id);
const token = new URLSearchParams(location.search).get('t');
const clamp = (v,min,max) => Math.max(min,Math.min(max,v));
const OPTION_IDS = ['A','B','C','D','E','F'];
const NORMAL_DURATIONS = [90,90,90,90,150,150,150];
const MIX_DURATION = 150;
const NORMAL_SKILLS = [
  ['horizontal-shift','左右平移'],
  ['vertical-shift','上下平移'],
  ['horizontal-scale','左右伸縮'],
  ['vertical-scale','上下伸縮'],
  ['horizontal-shift-scale','左右平移＋左右伸縮'],
  ['vertical-shift-horizontal-scale','上下平移＋左右伸縮'],
  ['all','左右平移＋左右伸縮＋上下平移＋上下伸縮']
];
const TYPE_LABEL = { sin:'sin', cos:'cos', tan:'tan' };
const H_CHOICES = [
  [-Math.PI,'−π'],[-3*Math.PI/4,'−3π/4'],[-2*Math.PI/3,'−2π/3'],[-Math.PI/2,'−π/2'],[-Math.PI/3,'−π/3'],[-Math.PI/4,'−π/4'],
  [Math.PI/4,'π/4'],[Math.PI/3,'π/3'],[Math.PI/2,'π/2'],[2*Math.PI/3,'2π/3'],[3*Math.PI/4,'3π/4'],[Math.PI,'π']
];
const A_CHOICES = [[0.5,'1/2'],[2/3,'2/3'],[1.5,'3/2'],[2,'2'],[2.5,'5/2'],[3,'3']];
const B_CHOICES = [[1/3,'1/3'],[0.5,'1/2'],[2/3,'2/3'],[1.5,'3/2'],[2,'2'],[3,'3']];
const K_CHOICES = [-3,-2,-1,1,2,3];

let pass = null;
let roomCode = null;
let hostUid = null;
let players = {};
let activePlayers = {};
let scores = {};
let aims = {};
let answers = {};
let shotSeqSeen = new Map();
let typeQueue = [];
let sessionMode = 'normal';
let totalRounds = 7;
let roundNumber = 0;
let round = { status:'waiting', roundId:null, startedAt:0, endsAt:0, remainingMs:0, functionType:null, skillKey:null, skillLabel:'—' };
let roundOptions = [];
let correctByUid = {};
let engineTimer = null;
let uiTimer = null;
let settling = false;
let soundEnabled = true;
let visualTheme = 'classic';
let audioCtx = null;

function safeText(s) { return String(s ?? '').replace(/[&<>\'\"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c])); }
function randInt(min,max) { return Math.floor(Math.random()*(max-min+1))+min; }
function choice(arr) { return arr[randInt(0,arr.length-1)]; }
function shuffle(arr) { const a=[...arr]; for(let i=a.length-1;i>0;i--){const j=randInt(0,i);[a[i],a[j]]=[a[j],a[i]];} return a; }
function activeUids() { return Object.keys(players).filter(uid => activePlayers[uid] === true); }
function activeCount() { return activeUids().length; }
function fmtScore(v) { return Number(v||0).toLocaleString('zh-TW'); }
function setFatal(type,text) { $('fatalNotice').className=`notice ${type} trig-notice`; $('fatalNotice').textContent=text; }
function isHostAuthorized() { return !!roomCode && !!hostUid; }

function hostAccessConditionPath() { return `roomHosts/${roomCode}/${hostUid}`; }

async function boot() {
  try {
    if (!token) throw new Error('網址中沒有教師控制通行證。');
    const cred = await signInAnonymously(auth);
    hostUid = cred.user.uid;
    const passSnap = await get(ref(db, `hostPasses/${token}`));
    if (!passSnap.exists()) throw new Error('教師控制連結不存在、已關閉或已到期。');
    pass = passSnap.val();
    if (pass.gameId !== 'trig-graph-shooter') throw new Error('這個教師連結不是「三角函數圖形射擊」房間。');
    roomCode = pass.roomCode;
    await set(ref(db, hostAccessConditionPath()), { hostToken:token, joinedAt:Date.now() });

    $('roomCode').textContent=roomCode;
    $('qrRoomCode').textContent=roomCode;
    $('hostStatus').textContent='控制連線有效';
    $('hostGame').classList.remove('hidden');
    setFatal('ok','教師控制端已連線。學生可掃 QR Code 加入。');

    loadLocalSettings();
    bindControls();
    await setupStudentQr();
    subscribePassValidity();
    subscribePlayers();
    subscribeActivePlayers();
    subscribeScores();
    subscribeAims();
    subscribeShots();
    subscribeAnswers();
    await restoreExistingSession();
    startUiClock();
    updateUI();
  } catch (e) {
    setFatal('error', e?.message || '無法開啟教師控制頁。');
  }
}

function loadLocalSettings() {
  try { visualTheme = localStorage.getItem('trigGraphTheme') === 'tech' ? 'tech' : 'classic'; } catch {}
  $('themeSelect').value = visualTheme;
  applyTheme();
}

function bindControls() {
  $('normalModeBtn').addEventListener('click',()=>setSessionMode('normal'));
  $('mixModeBtn').addEventListener('click',()=>setSessionMode('mix'));
  $('themeSelect').addEventListener('change',()=>{
    visualTheme=$('themeSelect').value==='tech'?'tech':'classic';
    try { localStorage.setItem('trigGraphTheme',visualTheme); } catch {}
    applyTheme();
  });
  $('soundToggle').addEventListener('change',()=>{soundEnabled=$('soundToggle').checked;if(soundEnabled)ensureAudio();});
  $('startGameBtn').addEventListener('click',startNewGame);
  $('pauseBtn').addEventListener('click',pauseRound);
  $('resumeBtn').addEventListener('click',resumeRound);
  $('settleBtn').addEventListener('click',()=>settleRound(false));
  $('nextRoundBtn').addEventListener('click',startNextRound);
  $('stopGameBtn').addEventListener('click',stopWholeGame);
  $('fullscreenBtn').addEventListener('click',toggleFullscreen);
  $('fsPauseResumeBtn').addEventListener('click',()=>round.status==='paused'?resumeRound():pauseRound());
  $('fsSettleBtn').addEventListener('click',()=>settleRound(false));
  $('fsNextBtn').addEventListener('click',startNextRound);
  $('crosshairToggle').addEventListener('change',renderCrosshairs);
  $('selectAllBtn').addEventListener('click',()=>setAllPlayersActive(true));
  $('selectNoneBtn').addEventListener('click',()=>setAllPlayersActive(false));
  $('resetAllScoresBtn').addEventListener('click',()=>{if(confirm('確定將所有已加入學生的總分歸零？'))resetAllScores();});
  $('qrBtn').addEventListener('click',()=>$('qrDialog').showModal?.());
  $('closeQrBtn').addEventListener('click',()=>$('qrDialog').close?.());
  $('copyJoinUrlBtn').addEventListener('click',async()=>{
    const value=$('studentJoinUrl').value;if(!value)return;
    await navigator.clipboard.writeText(value);const b=$('copyJoinUrlBtn'),old=b.textContent;b.textContent='已複製';setTimeout(()=>b.textContent=old,900);
  });
}

function applyTheme() { $('trigStage').classList.toggle('theme-tech',visualTheme==='tech'); }

function setSessionMode(mode) {
  if (['running','paused'].includes(round.status) || roundNumber>0 && round.status!=='finished') return;
  sessionMode = mode==='mix'?'mix':'normal';
  totalRounds = sessionMode==='mix'?5:7;
  $('normalModeBtn').classList.toggle('active',sessionMode==='normal');
  $('mixModeBtn').classList.toggle('active',sessionMode==='mix');
  $('modeBadge').textContent=sessionMode==='mix'?'混搭版':'普通版';
  $('startGameBtn').textContent='開始第 1 關';
  updateUI();
}

function selectedTypes() {
  const arr=[];
  if($('sinToggle').checked)arr.push('sin');
  if($('cosToggle').checked)arr.push('cos');
  if($('tanToggle').checked)arr.push('tan');
  return arr;
}

function buildBalancedTypeQueue(count, allowed) {
  const base=[];
  for(let i=0;i<count;i++)base.push(allowed[i%allowed.length]);
  return shuffle(base);
}

function roundSkillFor(n) {
  if(sessionMode==='mix') return ['all','平移＋伸縮綜合'];
  return NORMAL_SKILLS[n-1] || NORMAL_SKILLS[NORMAL_SKILLS.length-1];
}
function roundDurationFor(n) { return sessionMode==='mix'?MIX_DURATION:(NORMAL_DURATIONS[n-1]||150); }

async function setupStudentQr() {
  let joinToken=pass?.joinToken||null;
  if(!joinToken){
    try{const snap=await get(ref(db,`rooms/${roomCode}`));joinToken=snap.val()?.joinToken||null;}catch{}
  }
  if(!joinToken){$('qrBtn').disabled=true;$('qrHint').textContent='此房間尚未取得學生通行證。';return;}
  const url=new URL('./trig-join.html',window.location.href);url.search='';url.searchParams.set('t',joinToken);
  $('studentJoinUrl').value=url.href;
  $('hostQr').replaceChildren();
  if(window.QRCode)new QRCode($('hostQr'),{text:url.href,width:250,height:250});
}

function subscribePassValidity() {
  onValue(ref(db,`hostPasses/${token}`),snap=>{
    if(!snap.exists()){setFatal('error','房間已關閉或教師通行證已失效。');disableAllControls();}
  });
}
function subscribePlayers(){onValue(ref(db,`playerAccess/${roomCode}`),snap=>{players=snap.val()||{};renderRoster();renderLeaderboard();renderCrosshairs();updateUI();});}
function subscribeActivePlayers(){onValue(ref(db,`activePlayers/${roomCode}`),snap=>{activePlayers=snap.val()||{};renderRoster();renderLeaderboard();renderCrosshairs();updateUI();});}
function subscribeScores(){onValue(ref(db,`scores/${roomCode}`),snap=>{scores=snap.val()||{};renderRoster();renderLeaderboard();});}
function subscribeAims(){onValue(ref(db,`playerAim/${roomCode}`),snap=>{aims=snap.val()||{};renderCrosshairs();});}
function subscribeAnswers(){onValue(ref(db,`trigAnswers/${roomCode}`),snap=>{answers=snap.val()||{};renderRoster();updateUI();});}
function subscribeShots(){
  const shotsRef=ref(db,`playerShots/${roomCode}`);
  const handle=snap=>{
    const uid=snap.key,shot=snap.val();
    if(!uid||!shot||!Number.isFinite(shot.seq))return;
    const last=shotSeqSeen.get(uid)||0;if(shot.seq<=last)return;shotSeqSeen.set(uid,shot.seq);
    if(round.status!=='running'||activePlayers[uid]!==true)return;
    if(!Number.isFinite(shot.shotAt)||shot.shotAt<round.startedAt-1000)return;
    if(answers[uid]?.roundId===round.roundId)return;
    handleShot(uid,shot);
  };
  onChildAdded(shotsRef,handle);onChildChanged(shotsRef,handle);
}

async function restoreExistingSession() {
  try {
    const stateSnap=await get(ref(db,`gameState/${roomCode}`));
    const state=stateSnap.val();
    if(!state||state.gameId!=='trig-graph-shooter')return;
    sessionMode=state.sessionMode==='mix'?'mix':'normal';
    totalRounds=Number(state.totalRounds)||(sessionMode==='mix'?5:7);
    roundNumber=Number(state.roundNumber)||0;
    typeQueue=Array.isArray(state.typeQueue)?state.typeQueue:[];
    soundEnabled=state.soundEnabled!==false;$('soundToggle').checked=soundEnabled;
    visualTheme=state.visualTheme==='tech'?'tech':'classic';$('themeSelect').value=visualTheme;applyTheme();
    round={
      status:state.status||'waiting',roundId:state.roundId||null,startedAt:Number(state.startedAt||0),endsAt:Number(state.endsAt||0),
      remainingMs:Number(state.remainingMs||0),functionType:state.functionType||null,skillKey:state.skillKey||null,skillLabel:state.skillLabel||'—'
    };
    if(round.roundId){
      const privSnap=await get(ref(db,`trigPrivate/${roomCode}`));
      const priv=privSnap.val();
      if(priv?.roundId===round.roundId){
        roundOptions=Array.isArray(priv.options)?priv.options:Object.values(priv.options||{});
        correctByUid=priv.correctByUid||{};
        if(roundOptions.length===6)renderGraphs(roundOptions,round.functionType);
      }
    }
    if(['running','paused'].includes(round.status)){
      if(round.status==='running') engineTimer=setInterval(engineTick,120);
      $('fieldOverlay').classList.add('hidden');
    }
  } catch {}
}

async function startNewGame() {
  const types=selectedTypes();
  if(!types.length){alert('請至少勾選 sin、cos、tan 其中一種題型。');return;}
  if(!activeCount()){alert('請先在右側學生名單勾選至少 1 位本局參加學生。');return;}
  if(roundNumber>0 && round.status!=='finished'){
    if(!confirm('目前已有進行中的遊戲流程。確定重新開始整場並清除參賽學生分數嗎？'))return;
  }
  totalRounds=sessionMode==='mix'?5:7;
  typeQueue=buildBalancedTypeQueue(totalRounds,types);
  roundNumber=0;
  await resetActiveScores();
  await clearTrigRoundData();
  await startNextRound();
}

async function startNextRound() {
  if(round.status==='running'||round.status==='paused')return;
  if(roundNumber>=totalRounds){finishWholeGame();return;}
  roundNumber+=1;
  const functionType=typeQueue[roundNumber-1]||choice(selectedTypes().length?selectedTypes():['sin']);
  const [skillKey,skillLabel]=roundSkillFor(roundNumber);
  const duration=roundDurationFor(roundNumber);
  const options=generateOptions(functionType,skillKey,6);
  if(options.length!==6){roundNumber-=1;alert('題目生成失敗，請再按一次。');return;}
  roundOptions=options.map((p,i)=>({...p,id:OPTION_IDS[i]}));
  const uids=shuffle(activeUids().sort((a,b)=>Number(players[a]?.seat)-Number(players[b]?.seat)));
  correctByUid={};
  const now=Date.now();
  round={status:'running',roundId:crypto.randomUUID?crypto.randomUUID():`${now}-${Math.random()}`,startedAt:now,endsAt:now+duration*1000,remainingMs:duration*1000,functionType,skillKey,skillLabel};

  const writes={};
  writes[`trigAnswers/${roomCode}`]=null;
  writes[`trigCandidates/${roomCode}`]=null;
  writes[`trigResults/${roomCode}`]=null;
  const assignments={};
  uids.forEach((uid,i)=>{
    const option=roundOptions[i%6];
    correctByUid[uid]=option.id;
    assignments[uid]={roundId:round.roundId,roundNumber,functionType,formulaText:formulaText(option),assignedAt:now};
  });
  writes[`trigAssignments/${roomCode}`]=assignments;
  writes[`trigPrivate/${roomCode}`]={
    roundId:round.roundId,roundNumber,functionType,skillKey,skillLabel,startedAt:round.startedAt,endsAt:round.endsAt,
    options:roundOptions,correctByUid,typeQueue,totalRounds,sessionMode
  };
  await update(ref(db),writes);
  answers={};
  renderGraphs(roundOptions,functionType);
  $('fieldOverlay').classList.add('hidden');
  $('roundMessage').textContent=`第 ${roundNumber} 關進行中：${skillLabel}。全班本關都是 ${TYPE_LABEL[functionType]} 題。`;
  await writeGameState();
  stopEngine();engineTimer=setInterval(engineTick,120);
  updateUI();
}

function stopEngine(){if(engineTimer)clearInterval(engineTimer);engineTimer=null;}
function engineTick(){
  if(round.status!=='running')return;
  round.remainingMs=Math.max(0,round.endsAt-Date.now());
  if(round.remainingMs<=0)settleRound(false);
}

async function pauseRound(){
  if(round.status!=='running')return;
  round.remainingMs=Math.max(0,round.endsAt-Date.now());round.status='paused';stopEngine();await writeGameState();updateUI();
}
async function resumeRound(){
  if(round.status!=='paused')return;
  round.status='running';round.startedAt=Date.now();round.endsAt=Date.now()+Math.max(1000,round.remainingMs);await writeGameState();stopEngine();engineTimer=setInterval(engineTick,120);updateUI();
}

async function stopWholeGame(){
  if(!confirm('確定停止整場遊戲？已鎖定的本關答案仍會先結算，之後不再進入下一關。'))return;
  if(['running','paused'].includes(round.status))await settleRound(true);else finishWholeGame();
}

async function settleRound(finishAfter=false) {
  if(settling||!['running','paused'].includes(round.status))return;
  settling=true;stopEngine();
  if(round.status==='running')round.remainingMs=Math.max(0,round.endsAt-Date.now());
  const uids=activeUids();
  const now=Date.now();
  const writes={};
  let correctCount=0;
  for(const uid of uids){
    const p=players[uid];
    const ans=answers[uid];
    const correctOption=correctByUid[uid]||null;
    let chosen=null,correct=false,roundScore=0,lockedAt=null;
    if(ans?.roundId===round.roundId){
      chosen=ans.optionId||null;lockedAt=Number(ans.lockedAt||0);correct=chosen===correctOption;
      if(correct&&Number.isFinite(lockedAt)&&lockedAt>=round.startedAt-1000){roundScore=Math.max(0,Math.ceil((round.endsAt-lockedAt)/1000));correctCount+=1;}
    }
    const old=scores[uid]||{seat:Number(p?.seat||0),score:0};
    const total=Number(old.score||0)+roundScore;
    writes[`scores/${roomCode}/${uid}`]={...old,seat:Number(p?.seat||0),score:total,lastRoundScore:roundScore,lastRound:roundNumber,updatedAt:now};
    writes[`trigResults/${roomCode}/${uid}`]={roundId:round.roundId,roundNumber,correct,roundScore,totalScore:total,chosenOption:chosen,correctOption,finishedAt:now};
  }
  round.status=(finishAfter||roundNumber>=totalRounds)?'finished':'round-ended';
  round.remainingMs=Math.max(0,round.remainingMs);
  writes[`trigCandidates/${roomCode}`]=null;
  await update(ref(db),writes);
  await writeGameState();
  $('fieldOverlay').classList.remove('hidden');
  if(round.status==='finished'){
    $('overlayTitle').textContent='遊戲完成！';
    $('overlayText').textContent=`第 ${roundNumber} 關結算完成，答對 ${correctCount}/${uids.length} 人。請看右側最終排行榜。`;
    $('roundMessage').textContent='整場遊戲完成。排行榜已依總分排序。';
    playFinishSound();
  }else{
    $('overlayTitle').textContent=`第 ${roundNumber} 關結算完成`;
    $('overlayText').textContent=`答對 ${correctCount}/${uids.length} 人。按「下一關」繼續。`;
    $('roundMessage').textContent=`第 ${roundNumber} 關已結算；可進入第 ${roundNumber+1} 關。`;
  }
  settling=false;updateUI();
}

function finishWholeGame(){round.status='finished';stopEngine();writeGameState();$('fieldOverlay').classList.remove('hidden');$('overlayTitle').textContent='遊戲完成！';$('overlayText').textContent='請查看右側最終排行榜。';updateUI();}

async function writeGameState(){
  if(!isHostAuthorized())return;
  await set(ref(db,`gameState/${roomCode}`),{
    gameId:'trig-graph-shooter',status:round.status,sessionMode,totalRounds,roundNumber,typeQueue,
    roundId:round.roundId,startedAt:round.startedAt||null,endsAt:round.endsAt||null,remainingMs:Math.max(0,Math.round(round.remainingMs||0)),
    functionType:round.functionType,skillKey:round.skillKey,skillLabel:round.skillLabel,soundEnabled,visualTheme,controllerUid:hostUid,updatedAt:Date.now()
  });
}

async function clearTrigRoundData(){
  const writes={};
  for(const key of ['trigAssignments','trigPrivate','trigCandidates','trigAnswers','trigResults'])writes[`${key}/${roomCode}`]=null;
  await update(ref(db),writes);
}

function updateUI(){
  const running=round.status==='running',paused=round.status==='paused',inRound=running||paused;
  $('normalModeBtn').classList.toggle('active',sessionMode==='normal');$('mixModeBtn').classList.toggle('active',sessionMode==='mix');
  $('modeBadge').textContent=sessionMode==='mix'?'混搭版':'普通版';
  $('roundMetric').textContent=roundNumber?`${roundNumber}/${totalRounds}`:'—';
  $('roundTitle').textContent=roundNumber?`第 ${roundNumber} 關`:'尚未開始';
  $('roundSkill').textContent=round.skillLabel||'—';
  $('functionTypeLabel').textContent=round.functionType?TYPE_LABEL[round.functionType]:'—';
  const locked=activeUids().filter(uid=>answers[uid]?.roundId===round.roundId).length;
  $('lockedMetric').textContent=`${locked}/${activeCount()}`;
  $('playerCount').textContent=`${Object.keys(players).length} 人`;
  $('pauseBtn').disabled=!running;$('resumeBtn').classList.toggle('hidden',!paused);
  $('settleBtn').disabled=!inRound;$('nextRoundBtn').classList.toggle('hidden',round.status!=='round-ended');
  $('stopGameBtn').disabled=roundNumber===0||round.status==='finished';
  $('startGameBtn').disabled=inRound||round.status==='round-ended';
  $('startGameBtn').textContent=round.status==='finished'?'重新開始整場':roundNumber===0?'開始第 1 關':'重新開始整場';
  $('fsPauseResumeBtn').disabled=!inRound;$('fsPauseResumeBtn').textContent=paused?'繼續':'暫停';
  $('fsSettleBtn').disabled=!inRound;$('fsNextBtn').disabled=round.status!=='round-ended';
  const lockSettings=roundNumber>0&&round.status!=='finished';
  for(const id of ['normalModeBtn','mixModeBtn','sinToggle','cosToggle','tanToggle'])$(id).disabled=lockSettings;
  $('gameStatusBadge').className=`badge ${running?'active':paused?'scheduled':'closed'}`;
  $('gameStatusBadge').textContent=running?'進行中':paused?'暫停':round.status==='round-ended'?'本關結束':round.status==='finished'?'已完成':'等待';
  if(running&&locked===activeCount()&&activeCount()>0)$('roundMessage').textContent='全體參賽學生都已鎖定答案，可直接按「提前結算本關」。';
  renderLeaderboard();renderRoster();renderCrosshairs();
}

function startUiClock(){
  if(uiTimer)clearInterval(uiTimer);
  uiTimer=setInterval(()=>{
    if(round.status==='running')round.remainingMs=Math.max(0,round.endsAt-Date.now());
    $('timer').textContent=String(Math.ceil(Math.max(0,round.remainingMs||0)/1000));
    updateUI();
  },250);
}

async function toggleFullscreen(){
  try{if(!document.fullscreenElement)await $('trigStage').requestFullscreen?.();else await document.exitFullscreen?.();}catch{}
}
function disableAllControls(){document.querySelectorAll('button,input,select').forEach(el=>el.disabled=true);}

async function handleShot(uid,shot){
  const hit=findGraphHit(clamp(Number(shot.x),0,1),clamp(Number(shot.y),0,1));
  if(!hit)return;
  await set(ref(db,`trigCandidates/${roomCode}/${uid}`),{roundId:round.roundId,roundNumber,optionId:hit,createdAt:Date.now()});
  showShotPulse(hit,players[uid]?.seat||'?');
}

function findGraphHit(x,y){
  const field=$('gameField').getBoundingClientRect();const px=field.left+x*field.width,py=field.top+y*field.height;
  for(const card of $('graphGrid').querySelectorAll('.trig-graph-card')){const r=card.getBoundingClientRect();if(px>=r.left&&px<=r.right&&py>=r.top&&py<=r.bottom)return card.dataset.optionId;}
  return null;
}
function showShotPulse(optionId,seat){
  const card=$('graphGrid').querySelector(`[data-option-id="${optionId}"]`);if(!card)return;
  const field=$('gameField').getBoundingClientRect(),r=card.getBoundingClientRect();
  const el=document.createElement('div');el.className='shot-effect correct';el.style.left=`${((r.left+r.width/2-field.left)/field.width)*100}%`;el.style.top=`${((r.top+r.height/2-field.top)/field.height)*100}%`;el.textContent=`${seat}號 → ${optionId}`;$('effectsLayer').appendChild(el);setTimeout(()=>el.remove(),650);
}

function renderCrosshairs(){
  const layer=$('crosshairsLayer');layer.replaceChildren();if(!$('crosshairToggle').checked)return;
  const now=Date.now();
  for(const [uid,a] of Object.entries(aims)){
    if(!players[uid]||activePlayers[uid]!==true)continue;if(!Number.isFinite(a.x)||!Number.isFinite(a.y))continue;if(Number.isFinite(a.updatedAt)&&now-a.updatedAt>15000)continue;
    const el=document.createElement('div');el.className='player-crosshair';el.style.left=`${clamp(a.x,0,1)*100}%`;el.style.top=`${clamp(a.y,0,1)*100}%`;el.style.setProperty('--seat-hue',String(((Number(players[uid].seat)||1)*47)%360));el.innerHTML=`<span>＋</span><b>${safeText(players[uid].seat)}</b>`;layer.appendChild(el);
  }
}

async function setPlayerActive(uid,active){if(!players[uid])return;if(roundNumber>0&&round.status!=='finished'&&round.status!=='waiting'){alert('一旦整場遊戲開始，請在本關結束後再調整下次參賽名單。');return;}await set(ref(db,`activePlayers/${roomCode}/${uid}`),active?true:null);}
async function setAllPlayersActive(active){const writes={};for(const uid of Object.keys(players))writes[uid]=active?true:null;await update(ref(db,`activePlayers/${roomCode}`),writes);}
async function resetAllScores(){const now=Date.now(),writes={};for(const [uid,p] of Object.entries(players))writes[`scores/${roomCode}/${uid}`]={seat:Number(p.seat),score:0,lastRoundScore:0,updatedAt:now};await update(ref(db),writes);}
async function resetActiveScores(){const now=Date.now(),writes={};for(const uid of activeUids())writes[`scores/${roomCode}/${uid}`]={seat:Number(players[uid]?.seat||0),score:0,lastRoundScore:0,updatedAt:now};await update(ref(db),writes);}
async function resetOneScore(uid){const p=players[uid];if(!p)return;await set(ref(db,`scores/${roomCode}/${uid}`),{seat:Number(p.seat),score:0,lastRoundScore:0,updatedAt:Date.now()});}
async function releaseSeat(uid){
  const p=players[uid];if(!p)return;if(!confirm(`確定釋放 ${p.seat} 號座位？該手機必須重新掃 QR Code。`))return;
  const seat=Number(p.seat),writes={};
  for(const path of [`playerAccess/${roomCode}/${uid}`,`activePlayers/${roomCode}/${uid}`,`playerAim/${roomCode}/${uid}`,`playerShots/${roomCode}/${uid}`,`scores/${roomCode}/${uid}`,`trigAssignments/${roomCode}/${uid}`,`trigCandidates/${roomCode}/${uid}`,`trigAnswers/${roomCode}/${uid}`,`trigResults/${roomCode}/${uid}`])writes[path]=null;
  writes[`seatClaims/${roomCode}/${seat}`]=null;await update(ref(db),writes);
}

function renderRoster(){
  const roster=$('playerRoster');const arr=Object.entries(players).sort((a,b)=>Number(a[1].seat)-Number(b[1].seat));
  if(!arr.length){roster.innerHTML='<div class="muted">等待學生掃描 QR Code。</div>';return;}
  roster.replaceChildren();
  for(const [uid,p] of arr){
    const locked=answers[uid]?.roundId===round.roundId;
    const row=document.createElement('div');row.className=`trig-player-row ${activePlayers[uid]===true?'active':''}`;
    row.innerHTML=`<div><label class="trig-player-main"><input type="checkbox" ${activePlayers[uid]===true?'checked':''}><span>${safeText(p.seat)}號</span></label><div class="trig-player-status">${round.status==='running'||round.status==='paused'?(locked?'<span class="trig-locked-chip">已鎖定</span>':'<span class="trig-working-chip">作答中</span>'):activePlayers[uid]===true?'本場參加':'待命'}</div></div><div class="trig-player-score">${fmtScore(scores[uid]?.score)}</div><div><button class="btn ghost tiny-btn reset-one">歸零</button><button class="btn danger tiny-btn release-one">釋放</button></div>`;
    row.querySelector('input').addEventListener('change',e=>setPlayerActive(uid,e.target.checked));
    row.querySelector('.reset-one').addEventListener('click',()=>resetOneScore(uid));row.querySelector('.release-one').addEventListener('click',()=>releaseSeat(uid));roster.appendChild(row);
  }
}
function renderLeaderboard(){
  const arr=Object.entries(players).filter(([uid])=>activePlayers[uid]===true).map(([uid,p])=>({uid,seat:Number(p.seat),score:Number(scores[uid]?.score||0),last:Number(scores[uid]?.lastRoundScore||0)}));
  arr.sort((a,b)=>b.score-a.score||a.seat-b.seat);
  $('leaderboard').innerHTML=arr.length?arr.map((p,i)=>`<div class="trig-leader-row ${i<3?'top':''}"><span>${i+1}</span><b>${p.seat}號${p.last?` <small class="muted">(+${p.last})</small>`:''}</b><strong>${p.score}</strong></div>`).join(''):'<div class="muted">尚未勾選參賽學生。</div>';
}

function formulaText(p){
  const a=p.aLabel==='1'?'':`${p.aLabel} `;
  let inside='x';
  const hasShift=Math.abs(p.h)>1e-8;
  if(hasShift) inside=`(x ${p.h>0?'−':'+'} ${p.hLabel.replace(/^−/,'')})`;
  if(p.bLabel!=='1') inside=hasShift ? `${p.bLabel}${inside}` : `${p.bLabel}x`;
  const core=`${a}${p.type} ${inside}`.replace(/\s+/g,' ').trim();
  if(p.k>0)return `y = ${core} + ${p.k}`;
  if(p.k<0)return `y = ${core} − ${Math.abs(p.k)}`;
  return `y = ${core}`;
}

function generateOptions(type,skillKey,count){
  const out=[];const keys=new Set();let tries=0;
  while(out.length<count&&tries<1000){tries++;
    const p=generateParams(type,skillKey);
    const key=paramKey(p);if(keys.has(key))continue;
    if(out.some(q=>graphsTooSimilar(p,q)))continue;
    keys.add(key);out.push(p);
  }
  return shuffle(out).slice(0,count);
}
function generateParams(type,skill){
  let a=[1,'1'],b=[1,'1'],h=[0,'0'],k=0;
  if(skill==='horizontal-shift')h=choice(H_CHOICES);
  else if(skill==='vertical-shift')k=choice(K_CHOICES);
  else if(skill==='horizontal-scale')b=choice(B_CHOICES);
  else if(skill==='vertical-scale')a=choice(A_CHOICES);
  else if(skill==='horizontal-shift-scale'){h=choice(H_CHOICES);b=choice(B_CHOICES);}
  else if(skill==='vertical-shift-horizontal-scale'){k=choice(K_CHOICES);b=choice(B_CHOICES);}
  else {a=choice(A_CHOICES);b=choice(B_CHOICES);h=choice(H_CHOICES);k=choice(K_CHOICES);}
  return {type,a:a[0],aLabel:a[1],b:b[0],bLabel:b[1],h:h[0],hLabel:h[1],k};
}
function paramKey(p){return `${p.type}|${p.a.toFixed(5)}|${p.b.toFixed(5)}|${p.h.toFixed(5)}|${p.k}`;}
function evalTrig(p,x){const u=p.b*(x-p.h);let base;if(p.type==='sin')base=Math.sin(u);else if(p.type==='cos')base=Math.cos(u);else{const c=Math.cos(u);if(Math.abs(c)<0.035)return NaN;base=Math.tan(u);}const y=p.a*base+p.k;return Number.isFinite(y)?y:NaN;}
function graphsTooSimilar(a,b){
  const domain=a.type==='tan'?[-Math.PI,Math.PI]:[-2*Math.PI,2*Math.PI];let sum=0,n=0;
  for(let i=0;i<=120;i++){const x=domain[0]+(domain[1]-domain[0])*i/120,ya=evalTrig(a,x),yb=evalTrig(b,x);if(!Number.isFinite(ya)||!Number.isFinite(yb)||Math.abs(ya)>8||Math.abs(yb)>8)continue;sum+=Math.abs(ya-yb);n++;}
  return n>40&&sum/n<0.08;
}

function renderGraphs(options,type){
  const grid=$('graphGrid');grid.replaceChildren();
  const yr=computeYRange(options,type);
  options.forEach(p=>{const card=document.createElement('div');card.className='trig-graph-card';card.dataset.optionId=p.id;card.innerHTML=`<span class="option-label">${p.id}</span>${makeGraphSvg(p,yr)}`;grid.appendChild(card);});
}
function computeYRange(options,type){
  if(type==='tan'){const ks=options.map(p=>p.k);return {min:Math.min(...ks)-4.5,max:Math.max(...ks)+4.5};}
  let min=Infinity,max=-Infinity;for(const p of options){min=Math.min(min,p.k-p.a);max=Math.max(max,p.k+p.a);}min=Math.floor(min-0.5);max=Math.ceil(max+0.5);if(max-min<4){const c=(max+min)/2;min=c-2;max=c+2;}return {min,max};
}
function makeGraphSvg(p,yr){
  const W=360,H=220,L=38,R=348,T=14,B=198;const xmin=p.type==='tan'?-Math.PI: -2*Math.PI,xmax=p.type==='tan'?Math.PI:2*Math.PI;
  const sx=x=>L+(x-xmin)/(xmax-xmin)*(R-L), sy=y=>B-(y-yr.min)/(yr.max-yr.min)*(B-T);
  let grid='',axes='',labels='',asym='';
  const xStep=Math.PI/2;for(let m=Math.ceil(xmin/xStep);m<=Math.floor(xmax/xStep);m++){const x=m*xStep,px=sx(x);grid+=`<line class="trig-grid-line" x1="${px}" y1="${T}" x2="${px}" y2="${B}"/>`;if(m!==0)labels+=`<text class="trig-tick-label" x="${px}" y="${sy(0)+13}" text-anchor="middle">${piTick(m)}</text>`;}
  for(let y=Math.ceil(yr.min);y<=Math.floor(yr.max);y++){const py=sy(y);grid+=`<line class="trig-grid-line" x1="${L}" y1="${py}" x2="${R}" y2="${py}"/>`;if(y!==0)labels+=`<text class="trig-tick-label" x="${L-5}" y="${py+3}" text-anchor="end">${y}</text>`;}
  if(yr.min<=0&&yr.max>=0)axes+=`<line class="trig-axis" x1="${L}" y1="${sy(0)}" x2="${R}" y2="${sy(0)}"/>`;
  if(xmin<=0&&xmax>=0)axes+=`<line class="trig-axis" x1="${sx(0)}" y1="${T}" x2="${sx(0)}" y2="${B}"/>`;
  if(p.type==='tan'){
    const start=Math.floor((p.b*(xmin-p.h)-Math.PI/2)/Math.PI)-1,end=Math.ceil((p.b*(xmax-p.h)-Math.PI/2)/Math.PI)+1;
    for(let n=start;n<=end;n++){const x=p.h+(Math.PI/2+n*Math.PI)/p.b;if(x>xmin&&x<xmax)asym+=`<line class="trig-asymptote" x1="${sx(x)}" y1="${T}" x2="${sx(x)}" y2="${B}"/>`;}
  }
  let d='',pen=false,lastY=null;const N=420;
  for(let i=0;i<=N;i++){
    const x=xmin+(xmax-xmin)*i/N,y=evalTrig(p,x);const bad=!Number.isFinite(y)||y<yr.min-0.6||y>yr.max+0.6||lastY!==null&&Math.abs(y-lastY)>(yr.max-yr.min)*0.55;
    if(bad){pen=false;lastY=null;continue;}const px=sx(x),py=sy(y);d+=`${pen?' L':' M'} ${px.toFixed(2)} ${py.toFixed(2)}`;pen=true;lastY=y;
  }
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${p.id} 圖"><rect x="0" y="0" width="${W}" height="${H}" fill="transparent"/>${grid}${asym}${axes}<path class="trig-curve" d="${d}"/>${labels}</svg>`;
}
function piTick(m){
  if(m===0)return'0';const sign=m<0?'−':'';const a=Math.abs(m);if(a===1)return`${sign}π/2`;if(a===2)return`${sign}π`;if(a%2===0)return`${sign}${a/2}π`;return`${sign}${a}π/2`;
}

async function playFinishSound(){if(!soundEnabled)return;const ctx=ensureAudio();if(!ctx)return;[523,659,784].forEach((f,i)=>setTimeout(()=>tone(f,.18),i*100));}
function ensureAudio(){try{const C=window.AudioContext||window.webkitAudioContext;if(!C)return null;if(!audioCtx)audioCtx=new C();if(audioCtx.state==='suspended')audioCtx.resume();return audioCtx;}catch{return null;}}
function tone(freq,d=.08){const ctx=ensureAudio();if(!ctx)return;const o=ctx.createOscillator(),g=ctx.createGain();o.frequency.value=freq;o.type='triangle';g.gain.setValueAtTime(.06,ctx.currentTime);g.gain.exponentialRampToValueAtTime(.0001,ctx.currentTime+d);o.connect(g).connect(ctx.destination);o.start();o.stop(ctx.currentTime+d);}

boot();
