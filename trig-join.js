import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js';
import {
  getDatabase, ref, get, update, set, onValue, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js';
import { firebaseConfig } from './firebase-config.js';
import { makeGraphSvg } from './trig-graph.js?v=3.3';
import { formulaHtml, formulaPlainText, validFormula, legacyFormula } from './trig-math.js?v=3.3';

const app=initializeApp(firebaseConfig,'trig-student-controller');
const auth=getAuth(app);const db=getDatabase(app);const $=id=>document.getElementById(id);
const token=new URLSearchParams(location.search).get('t');
const fmt=ms=>new Intl.DateTimeFormat('zh-TW',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(ms));
const clamp=(v,min,max)=>Math.max(min,Math.min(max,v));

let pass=null,uid=null,room=null,seat=null;
let aim={x:.5,y:.5},seq=0,lastFireLocal=0,lastAimWrite=0,aimWriteTimer=null,pointerActive=false,lastPointer=null;
let gameState={status:'waiting',remainingMs:0};let isActivePlayer=false,removedByTeacher=false;
let tiltEnabled=false,tiltBase=null,lastTiltUpdate=0,tiltInvertX=false,tiltInvertY=false,sensorMode='yaw';
let gripMode='portrait',fireSide='right';
let currentAssignment=null,currentCandidate=null,answerLocked=false,dismissedCandidateKey='',lastResultKey='';
let currentTotalScore=0,resultAnimation=null,audioCtx=null;
let currentAnswer=null,pendingResult=null,confirmingRoundId=null,assignmentError='',gameError='',submissionError='';
let serverOffset=0;
let renderedFormulaKey='';
const serverNow=()=>Date.now()+serverOffset;
const roundName=n=>`第${['零','一','二','三','四','五','六','七'][n]||n}關`;

async function boot(){
  try{
    if(!token)throw new Error('網址中沒有房間通行證。');
    const cred=await signInAnonymously(auth);uid=cred.user.uid;
    onValue(ref(db,'.info/serverTimeOffset'),snap=>{serverOffset=Number(snap.val())||0;});
    const snap=await get(ref(db,`joinPasses/${token}`));if(!snap.exists())throw new Error('通行證不存在、已關閉或已到期。');
    pass=snap.val();if(pass.gameId!=='trig-graph-shooter')throw new Error('這個 QR Code 不是「三角函數圖形射擊」房間。');
    room=pass.roomCode;$('roomInfo').classList.remove('hidden');$('gameName').textContent=pass.gameName;$('roomCode').textContent=room;$('timeInfo').textContent=`開放：${fmt(pass.opensAt)}　到期：${fmt(pass.expiresAt)}`;
    if(Date.now()<pass.opensAt){$('status').className='notice info';$('status').textContent=`房間尚未開放，請於 ${fmt(pass.opensAt)} 後再加入。`;return;}
    $('status').className='notice ok';$('status').textContent='通行證有效。請輸入座號加入。';$('seatBox').classList.remove('hidden');$('continueBtn').addEventListener('click',joinGame);
  }catch(e){$('status').className='notice error';$('status').textContent=e?.message||'無法加入房間。';}
}

async function joinGame(){
  ensureAudio();
  seat=Number($('seat').value);if(!Number.isInteger(seat)||seat<1||seat>99){$('status').className='notice error';$('status').textContent='請輸入 1～99 的有效座號。';return;}
  $('continueBtn').disabled=true;
  try{
    const now=Date.now(),writes={};writes[`seatClaims/${room}/${seat}`]={uid,joinToken:token,joinedAt:now};writes[`playerAccess/${room}/${uid}`]={seat,joinToken:token,joinedAt:now};await update(ref(db),writes);
    const oldShot=await get(ref(db,`playerShots/${room}/${uid}`));seq=Number(oldShot.val()?.seq||0);
    $('status').className='notice ok';$('status').textContent=`座號 ${seat} 已加入。題目會顯示在下方。`;$('seatBox').classList.add('hidden');$('controller').classList.remove('hidden');$('seatLabel').textContent=seat;document.body.classList.add('trig-controller-ready');
    bindController();bindConfirmUI();bindGraphPreview();subscribeOwnAccess();subscribeParticipation();subscribeGame();subscribeScore();subscribeAssignment();subscribeCandidate();subscribeAnswer();subscribeResult();
  }catch(e){const msg=/permission/i.test(e?.message||'')?`座號 ${seat} 可能已被其他同學使用，請確認座號後再試。`:(e?.message||'加入失敗。');$('status').className='notice error';$('status').textContent=msg;$('continueBtn').disabled=false;}
}

function subscribeOwnAccess(){onValue(ref(db,`playerAccess/${room}/${uid}`),snap=>{if(snap.exists()||removedByTeacher)return;removedByTeacher=true;isActivePlayer=false;document.body.classList.remove('trig-controller-ready');$('fireBtn').disabled=true;$('controller').classList.add('hidden');$('status').className='notice error';$('status').textContent=`座號 ${seat} 已由教師釋放。請重新掃描 QR Code，再輸入正確座號。`;try{const clean=new URL('./trig-join.html',location.href);clean.search='';history.replaceState({},'',clean.href);}catch{}});}
function subscribeParticipation(){onValue(ref(db,`activePlayers/${room}/${uid}`),snap=>{const prev=isActivePlayer;isActivePlayer=snap.val()===true;if(isActivePlayer&&!prev)scheduleAimWrite(true);updateControllerState();},()=>{isActivePlayer=false;updateControllerState();});}
function subscribeGame(){
  onValue(ref(db,`gameState/${room}`),snap=>{
    const next=snap.val()||{status:'waiting',remainingMs:0};
    const changedRound=next.roundId!==gameState.roundId;
    gameState=next;gameError='';submissionError='';
    if(changedRound){
      confirmingRoundId=null;dismissedCandidateKey='';
      if(resultAnimation){clearInterval(resultAnimation);resultAnimation=null;}
      if(currentCandidate?.roundId!==next.roundId)currentCandidate=null;
      $('confirmOverlay').classList.add('hidden');$('resultOverlay').classList.add('hidden');
    }
    updateControllerState();maybeShowResult();
    if(changedRound)scheduleAimWrite(true);
  },()=>{gameError='房間已關閉或通行證失效。';updateControllerState();});
  setInterval(updateControllerState,200);
}
function subscribeScore(){onValue(ref(db,`scores/${room}/${uid}`),snap=>{const d=snap.val()||{};currentTotalScore=Number(d.score||0);$('scoreLabel').textContent=currentTotalScore;});}
function subscribeAssignment(){
  onValue(ref(db,`trigAssignments/${room}/${uid}`),snap=>{
    currentAssignment=snap.val()||null;assignmentError='';updateControllerState();
  },()=>{assignmentError='題目讀取失敗，請重新整理；若仍無法顯示，請老師確認房間權限設定。';updateControllerState();});
}
function subscribeCandidate(){onValue(ref(db,`trigCandidates/${room}/${uid}`),snap=>{currentCandidate=snap.val()||null;updateControllerState();});}
function subscribeAnswer(){onValue(ref(db,`trigAnswers/${room}/${uid}`),snap=>{currentAnswer=snap.val()||null;updateControllerState();});}
function subscribeResult(){onValue(ref(db,`trigResults/${room}/${uid}`),snap=>{pendingResult=snap.val()||null;maybeShowResult();});}
function maybeShowResult(){
  const r=pendingResult;
  if(!r||r.roundId!==gameState.roundId||!['round-ended','finished'].includes(gameState.status))return;
  const key=`${r.roundId}:${r.finishedAt}`;if(key===lastResultKey)return;
  lastResultKey=key;$('confirmOverlay').classList.add('hidden');showRoundResult(r);
}
function renderAssignment(){
  // Render on both state and assignment changes: Firebase callbacks may arrive in either order.
  const ready=currentAssignment?.roundId===gameState.roundId&&!!currentAssignment?.formulaText;
  $('questionCard').classList.remove('hidden');
  if(ready){
    $('questionType').textContent=`第 ${currentAssignment.roundNumber} 關｜${String(currentAssignment.functionType||'').toUpperCase()}`;
    const formula=currentAssignment.formula||legacyFormula(currentAssignment.formulaText);
    const key=JSON.stringify([currentAssignment.roundId,formula,currentAssignment.formulaText]);
    if(key!==renderedFormulaKey){
      if(validFormula(formula)){
        $('formulaText').innerHTML=formulaHtml(formula);
        $('formulaText').setAttribute('aria-label',formulaPlainText(formula));
      }else{$('formulaText').textContent=currentAssignment.formulaText;$('formulaText').removeAttribute('aria-label');}
      renderedFormulaKey=key;fitFormula();
    }
    $('questionHint').textContent='請在大螢幕 A～F 六張圖中找出正確圖形。';
  }else{
    renderedFormulaKey='';$('formulaText').removeAttribute('aria-label');
    $('questionType').textContent='本關題目';
    $('formulaText').textContent=assignmentError?'題目讀取失敗':!gameState.roundId?'等待老師開始':!isActivePlayer?'等待老師勾選':'題目載入中…';
    $('questionHint').textContent=assignmentError||'題目會顯示在這裡，請留意手機畫面。';
  }
}

function fitFormula(){
  const el=$('formulaText');el.style.fontSize='';
  const equation=el.querySelector('.trig-math-equation');if(!equation||!el.clientWidth)return;
  const width=equation.getBoundingClientRect().width;
  if(width>el.clientWidth){const size=parseFloat(getComputedStyle(el).fontSize);el.style.fontSize=`${size*el.clientWidth/width*.98}px`;}
}
window.addEventListener('resize',fitFormula);
document.fonts?.ready.then(fitFormula);

function bindConfirmUI(){
  $('cancelCandidateBtn').addEventListener('click',()=>{if(currentCandidate)dismissedCandidateKey=`${currentCandidate.roundId}:${currentCandidate.createdAt}:${currentCandidate.optionId}`;currentCandidate=null;$('confirmOverlay').classList.add('hidden');});
  $('confirmCandidateBtn').addEventListener('click',confirmAnswer);
  $('closeResultBtn').addEventListener('click',()=>$('resultOverlay').classList.add('hidden'));
}

async function confirmAnswer(){
  const candidate=currentCandidate,roundId=gameState.roundId;
  if(!candidate||candidate.roundId!==roundId||answerLocked||!isActivePlayer||gameState.status!=='running'||serverNow()>=gameState.endsAt||gameError)return;
  ensureAudio();submissionError='';confirmingRoundId=roundId;$('confirmCandidateBtn').disabled=true;updateControllerState();
  try{
    const submitted={roundId,roundNumber:Number(gameState.roundNumber||0),optionId:candidate.optionId,lockedAt:serverTimestamp()};
    await set(ref(db,`trigAnswers/${room}/${uid}`),submitted);
    // Keep the captured candidate: the host may already have cleared it during settlement.
    if(gameState.roundId===roundId){currentAnswer={...submitted,lockedAt:serverNow()};$('confirmOverlay').classList.add('hidden');}
  }catch(e){
    if(gameState.roundId===roundId)currentAnswer=null;
    submissionError='答案未能鎖定，請確認本關仍在作答時間內後重試。';
  }finally{confirmingRoundId=null;$('confirmCandidateBtn').disabled=false;updateControllerState();}
}

function updateControllerState(){
  if(removedByTeacher){$('fireBtn').disabled=true;return;}
  answerLocked=!!gameState.roundId&&(currentAnswer?.roundId===gameState.roundId||confirmingRoundId===gameState.roundId);
  renderAssignment();renderGraphPreview();
  let remaining=Number(gameState.remainingMs||0);
  if(gameState.status==='running'&&Number.isFinite(gameState.endsAt))remaining=Math.max(0,gameState.endsAt-serverNow());
  const countdown=gameState.status==='countdown';
  const beats=gameState.countdownEndsAt?Math.max(1,Math.ceil((gameState.countdownEndsAt-serverNow())/1000)):null;
  $('timeLabel').textContent=Math.ceil(remaining/1000);$('roundLabel').textContent=gameState.roundNumber?`${gameState.roundNumber}/${gameState.totalRounds||'?'}`:'—';
  const running=gameState.status==='running'&&remaining>0;
  const ready=currentAssignment?.roundId===gameState.roundId&&!!currentAssignment?.formulaText;
  const canPlay=running&&isActivePlayer&&!answerLocked&&ready&&!gameError&&!assignmentError;
  const candidateKey=currentCandidate?`${currentCandidate.roundId}:${currentCandidate.createdAt}:${currentCandidate.optionId}`:'';
  const showCandidate=canPlay&&currentCandidate?.roundId===gameState.roundId&&candidateKey!==dismissedCandidateKey;
  $('confirmOverlay').classList.toggle('hidden',!showCandidate);
  if(showCandidate)$('candidateOption').textContent=`${currentCandidate.optionId} 圖`;
  const cooldown=Math.max(0,1000-(Date.now()-lastFireLocal));$('fireBtn').disabled=!canPlay||cooldown>0||!!showCandidate;
  $('gameMessage').className='notice info';
  if(gameError||assignmentError||submissionError){$('gameMessage').className='notice error';$('gameMessage').textContent=gameError||assignmentError||submissionError;}
  else if((running||countdown)&&!isActivePlayer)$('gameMessage').textContent='目前沒有被老師勾選參加這場遊戲。';
  else if(countdown)$('gameMessage').textContent=beats?`準備開始：${beats}！請先看下方手機題目。`:'題目準備中，請看手機畫面。';
  else if(gameState.status==='settling')$('gameMessage').textContent=`${roundName(gameState.roundNumber)}完成！準備對答案與結算分數。`;
  else if(running&&answerLocked){$('gameMessage').className='notice ok';$('gameMessage').textContent='本關答案已鎖定，準星暫時隱藏；下一關恢復。';}
  else if(running&&ready){$('gameMessage').className='notice ok';$('gameMessage').textContent='看下方手機題目，瞄準大螢幕 A～F 的答案後按 FIRE。';}
  else if(running)$('gameMessage').textContent='正在取得本關題目，請稍候。';
  else if(gameState.status==='running'&&remaining<=0)$('gameMessage').textContent='時間到！等待本關結算。';
  else if(gameState.status==='paused')$('gameMessage').textContent='本關暫停。';
  else if(gameState.status==='round-ended')$('gameMessage').textContent=`本關已結算，${Math.max(0,Math.ceil(((gameState.nextRoundAt||serverNow())-serverNow())/1000))} 秒後自動進入下一關。`;
  else if(gameState.status==='finished')$('gameMessage').textContent='整場遊戲已完成，請看大螢幕最終排行榜。';
  else $('gameMessage').textContent='等待老師開始遊戲。';
  $('cooldownLabel').textContent=countdown?'倒數準備中':!running?'等待遊戲':!isActivePlayer?'待命':answerLocked?'答案已鎖定':!ready?'等待題目':cooldown>0?`${(cooldown/1000).toFixed(1)} 秒`:'可以射擊';
  $('controller').classList.toggle('trig-answer-locked',answerLocked);
}

function bindController(){
  renderAimDot();const pad=$('aimPad');
  pad.addEventListener('pointerdown',e=>{pointerActive=true;lastPointer={x:e.clientX,y:e.clientY};pad.setPointerCapture?.(e.pointerId);e.preventDefault();});
  pad.addEventListener('pointermove',e=>{if(!pointerActive||!lastPointer)return;const r=pad.getBoundingClientRect();const dx=(e.clientX-lastPointer.x)/Math.max(1,r.width),dy=(e.clientY-lastPointer.y)/Math.max(1,r.height);lastPointer={x:e.clientX,y:e.clientY};setAim(aim.x+dx*1.55,aim.y+dy*1.55);e.preventDefault();});
  const end=()=>{pointerActive=false;lastPointer=null;};pad.addEventListener('pointerup',end);pad.addEventListener('pointercancel',end);pad.addEventListener('pointerleave',e=>{if(e.buttons===0)end();});
  $('centerBtn').addEventListener('click',()=>setAim(.5,.5,true));$('fireBtn').addEventListener('click',fire);$('tiltBtn').addEventListener('click',toggleTilt);
  try{tiltInvertX=localStorage.getItem('classroomGameTiltInvertX')==='1';tiltInvertY=localStorage.getItem('classroomGameTiltInvertY')==='1';gripMode=localStorage.getItem('classroomGameGripMode')==='landscape'?'landscape':'portrait';fireSide=localStorage.getItem('classroomGameFireSide')==='left'?'left':'right';}catch{}
  applyGripMode(false);$('portraitModeBtn').addEventListener('click',()=>setGripMode('portrait'));$('landscapeModeBtn').addEventListener('click',()=>setGripMode('landscape'));$('fireLeftBtn').addEventListener('click',()=>setFireSide('left'));$('fireRightBtn').addEventListener('click',()=>setFireSide('right'));
  $('invertXToggle').checked=tiltInvertX;$('invertYToggle').checked=tiltInvertY;
  $('invertXToggle').addEventListener('change',()=>{tiltInvertX=$('invertXToggle').checked;try{localStorage.setItem('classroomGameTiltInvertX',tiltInvertX?'1':'0');}catch{}if(tiltEnabled)recalibrateTilt();});
  $('invertYToggle').addEventListener('change',()=>{tiltInvertY=$('invertYToggle').checked;try{localStorage.setItem('classroomGameTiltInvertY',tiltInvertY?'1':'0');}catch{}if(tiltEnabled)recalibrateTilt();});
  $('recenterTiltBtn').addEventListener('click',()=>{if(tiltEnabled){recalibrateTilt();$('controllerHint').textContent='已重新校正，請把手機朝向螢幕中央。';}});
}
function setAim(x,y,force=false){if(answerLocked)return;aim.x=clamp(x,.02,.98);aim.y=clamp(y,.02,.98);renderAimDot();renderGraphPreview();scheduleAimWrite(force);}
function renderAimDot(){$('aimDot').style.left=`${aim.x*100}%`;$('aimDot').style.top=`${aim.y*100}%`;}
function scheduleAimWrite(force=false){if(!isActivePlayer||answerLocked)return;const now=Date.now(),due=force?0:Math.max(0,100-(now-lastAimWrite));if(aimWriteTimer)clearTimeout(aimWriteTimer);aimWriteTimer=setTimeout(async()=>{if(!isActivePlayer||answerLocked)return;lastAimWrite=Date.now();try{await set(ref(db,`playerAim/${room}/${uid}`),{x:aim.x,y:aim.y,updatedAt:Date.now()});}catch{}},due);}
async function fire(){const now=Date.now();if(gameState.status!=='running'||!isActivePlayer||answerLocked||!currentAssignment?.formulaText||currentAssignment?.roundId!==gameState.roundId||serverNow()>=gameState.endsAt||gameError||assignmentError)return;if(now-lastFireLocal<1000)return;lastFireLocal=now;seq+=1;$('fireBtn').disabled=true;if(navigator.vibrate)navigator.vibrate(35);try{await set(ref(db,`playerShots/${room}/${uid}`),{seq,x:aim.x,y:aim.y,shotAt:serverTimestamp()});}catch{$('gameMessage').className='notice error';$('gameMessage').textContent='射擊送出失敗，請稍後再試。';}updateControllerState();}

async function toggleTilt(){if(tiltEnabled){disableTilt();return;}await enableTilt();}
async function enableTilt(){try{if(typeof DeviceOrientationEvent==='undefined')throw new Error('此手機瀏覽器沒有方向感測器。');if(typeof DeviceOrientationEvent.requestPermission==='function'){const r=await DeviceOrientationEvent.requestPermission();if(r!=='granted')throw new Error('未取得方向感測器權限。');}tiltBase=null;tiltEnabled=true;sensorMode='yaw';window.removeEventListener('deviceorientation',onOrientation);window.addEventListener('deviceorientation',onOrientation,{passive:true});$('tiltBtn').textContent='關閉光線槍感應';$('tiltBtn').classList.add('sensor-active');$('recenterTiltBtn').disabled=false;$('controllerHint').textContent='請把手機朝向螢幕中央，稍候自動校正。';}catch(e){tiltEnabled=false;$('tiltBtn').textContent='啟用光線槍感應';$('tiltBtn').classList.remove('sensor-active');$('recenterTiltBtn').disabled=true;$('controllerHint').textContent=`光線槍感應無法啟用：${e?.message||'不支援'}。仍可使用拖曳瞄準。`;}}
function disableTilt(){tiltEnabled=false;tiltBase=null;sensorMode='yaw';window.removeEventListener('deviceorientation',onOrientation);$('tiltBtn').textContent='啟用光線槍感應';$('tiltBtn').classList.remove('sensor-active');$('recenterTiltBtn').disabled=true;$('controllerHint').textContent='光線槍感應已關閉；可使用觸控區拖曳準星。';}
function onOrientation(e){if(!tiltEnabled)return;const now=Date.now();if(now-lastTiltUpdate<70)return;lastTiltUpdate=now;const ha=Number.isFinite(e.alpha),hb=Number.isFinite(e.beta),hg=Number.isFinite(e.gamma);if(!hb&&!hg)return;if(!tiltBase){sensorMode=ha?'yaw':'fallback';tiltBase={alpha:ha?e.alpha:null,beta:hb?e.beta:null,gamma:hg?e.gamma:null};setAim(.5,.5,true);$('controllerHint').textContent='已校正：左右旋轉手機控制左右；抬高／壓低控制上下。';return;}let hd=0;if(sensorMode==='yaw'&&ha&&Number.isFinite(tiltBase.alpha))hd=-angleDelta(e.alpha,tiltBase.alpha);else if(gripMode==='landscape'&&hb&&Number.isFinite(tiltBase.beta))hd=angleDelta(e.beta,tiltBase.beta);else if(hg&&Number.isFinite(tiltBase.gamma))hd=angleDelta(e.gamma,tiltBase.gamma);else return;let vd=0;if(gripMode==='landscape'&&hg&&Number.isFinite(tiltBase.gamma))vd=angleDelta(e.gamma,tiltBase.gamma);else if(hb&&Number.isFinite(tiltBase.beta))vd=angleDelta(e.beta,tiltBase.beta);else return;setAim(.5+(tiltInvertX?-1:1)*hd/70,.5+(tiltInvertY?1:-1)*vd/50);}
function recalibrateTilt(){tiltBase=null;setAim(.5,.5,true);}
function angleDelta(a,b){let d=a-b;while(d>180)d-=360;while(d<-180)d+=360;return d;}
function setGripMode(mode){gripMode=mode==='landscape'?'landscape':'portrait';try{localStorage.setItem('classroomGameGripMode',gripMode);}catch{}applyGripMode(true);}
function setFireSide(side){fireSide=side==='left'?'left':'right';try{localStorage.setItem('classroomGameFireSide',fireSide);}catch{}applyGripMode(false);}
function applyGripMode(recalibrate=true){const landscape=gripMode==='landscape',core=$('controllerCore');core.classList.toggle('portrait-layout',!landscape);core.classList.toggle('landscape-layout',landscape);core.classList.toggle('fire-left',landscape&&fireSide==='left');core.classList.toggle('fire-right',!landscape||fireSide==='right');document.body.classList.toggle('controller-landscape-mode',landscape);$('fireSideChooser').classList.toggle('hidden',!landscape);$('portraitModeBtn').classList.toggle('active',!landscape);$('landscapeModeBtn').classList.toggle('active',landscape);$('fireLeftBtn').classList.toggle('active',fireSide==='left');$('fireRightBtn').classList.toggle('active',fireSide==='right');if(tiltEnabled&&recalibrate)recalibrateTilt();}

function showRoundResult(r){
  if(resultAnimation)clearInterval(resultAnimation);$('resultOverlay').classList.remove('hidden');const card=$('resultOverlay').querySelector('.trig-result-card');card.classList.toggle('correct',!!r.correct);card.classList.toggle('wrong',!r.correct);$('resultStatus').textContent=r.correct?'答對！本關得分':'本關得分';$('resultDetail').textContent=r.correct?`你選 ${r.chosenOption} 圖，答對。總分 ${r.totalScore}。`:`你選 ${r.chosenOption||'未作答'}；正確答案是 ${r.correctOption} 圖。總分 ${r.totalScore}。`;
  const target=Number(r.roundScore||0);let shown=0;$('resultCounter').textContent='0';const steps=Math.max(8,Math.min(35,target||8)),inc=target/steps;let i=0;resultAnimation=setInterval(()=>{i++;shown=Math.min(target,Math.round(inc*i));$('resultCounter').textContent=shown;if(r.correct&&target>0&&i%3===0)playTick();if(i>=steps){clearInterval(resultAnimation);resultAnimation=null;$('resultCounter').textContent=target;if(r.correct&&target>0)playScoreFinish();}},Math.max(22,900/steps));
}
function ensureAudio(){try{const C=window.AudioContext||window.webkitAudioContext;if(!C)return null;if(!audioCtx)audioCtx=new C();if(audioCtx.state==='suspended')audioCtx.resume();return audioCtx;}catch{return null;}}
function tone(freq,d=.05,vol=.035){const ctx=ensureAudio();if(!ctx)return;const o=ctx.createOscillator(),g=ctx.createGain();o.type='triangle';o.frequency.value=freq;g.gain.setValueAtTime(vol,ctx.currentTime);g.gain.exponentialRampToValueAtTime(.0001,ctx.currentTime+d);o.connect(g).connect(ctx.destination);o.start();o.stop(ctx.currentTime+d);}
function playTick(){tone(740,.035,.025);}function playScoreFinish(){tone(880,.08,.045);setTimeout(()=>tone(1100,.1,.045),80);if(navigator.vibrate)navigator.vibrate([30,40,45]);}

let previewKey='',previewScale=1,previewPan={x:0,y:0},previewPoints=new Map(),previewGesture=null;
function renderGraphPreview(){
  const view=gameState.graphView;
  const valid=isActivePlayer&&view?.roundId===gameState.roundId&&['countdown','running','paused'].includes(gameState.status);
  const hit=valid&&Array.isArray(view.rects)?view.rects.find(r=>aim.x>=r.left&&aim.x<=r.right&&aim.y>=r.top&&aim.y<=r.bottom):null;
  const p=hit&&Array.isArray(view.options)?view.options.find(p=>p.id===hit.id):null;
  const key=p?JSON.stringify([view.roundId,p,view.yRange,view.style,view.theme]):'';
  if(key===previewKey)return;
  previewKey=key;previewPan={x:0,y:0};
  $('previewTitle').textContent=p?`準星所在：${p.id} 圖`:'瞄準圖形預覽';
  $('previewEmpty').classList.toggle('hidden',!!p);
  $('graphPreviewCanvas').innerHTML=p?makeGraphSvg(p,view.yRange,view.style,view.theme):'';
  $('graphPreviewViewport').classList.toggle('preview-tech',view?.theme==='tech');
  applyPreviewTransform();
}
function applyPreviewTransform(){
  previewScale=clamp(previewScale,.5,2);
  const box=$('graphPreviewViewport'),limitX=box.clientWidth*previewScale/2,limitY=box.clientHeight*previewScale/2;
  previewPan.x=clamp(previewPan.x,-limitX,limitX);previewPan.y=clamp(previewPan.y,-limitY,limitY);
  $('graphPreviewCanvas').style.transform=`translate(${previewPan.x}px,${previewPan.y}px) scale(${previewScale})`;
  $('previewZoom').value=String(Math.round(previewScale*100));$('previewZoomValue').textContent=`${Math.round(previewScale*100)}%`;
}
function seedPreviewGesture(){
  const points=[...previewPoints.values()];
  previewGesture=points.length?{points,scale:previewScale,pan:{...previewPan}}:null;
}
function bindGraphPreview(){
  $('previewZoom').addEventListener('input',e=>{previewScale=Number(e.target.value)/100;applyPreviewTransform();});
  new ResizeObserver(()=>document.documentElement.style.setProperty('--trig-question-height',`${$('questionCard').getBoundingClientRect().height}px`)).observe($('questionCard'));
  $('resetPreviewBtn').addEventListener('click',()=>{previewScale=1;previewPan={x:0,y:0};applyPreviewTransform();});
  const box=$('graphPreviewViewport');
  box.addEventListener('pointerdown',e=>{if(!previewKey)return;box.setPointerCapture(e.pointerId);previewPoints.set(e.pointerId,{x:e.clientX,y:e.clientY});seedPreviewGesture();e.preventDefault();});
  box.addEventListener('pointermove',e=>{
    if(!previewPoints.has(e.pointerId)||!previewGesture)return;
    previewPoints.set(e.pointerId,{x:e.clientX,y:e.clientY});const now=[...previewPoints.values()],before=previewGesture.points;
    if(now.length>=2&&before.length>=2){
      const distance=p=>Math.hypot(p[1].x-p[0].x,p[1].y-p[0].y);
      previewScale=clamp(previewGesture.scale*distance(now)/Math.max(1,distance(before)),.5,2);
      previewPan={x:previewGesture.pan.x+(now[0].x+now[1].x-before[0].x-before[1].x)/2,y:previewGesture.pan.y+(now[0].y+now[1].y-before[0].y-before[1].y)/2};
    }else{previewPan={x:previewGesture.pan.x+now[0].x-before[0].x,y:previewGesture.pan.y+now[0].y-before[0].y};}
    applyPreviewTransform();e.preventDefault();
  });
  const end=e=>{previewPoints.delete(e.pointerId);seedPreviewGesture();};
  for(const type of ['pointerup','pointercancel','lostpointercapture'])box.addEventListener(type,end);
}

boot();
