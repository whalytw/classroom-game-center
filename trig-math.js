// Exact rational arithmetic keeps the displayed expansion identical to the graph.
function gcd(a,b){a=Math.abs(a);b=Math.abs(b);while(b){[a,b]=[b,a%b];}return a||1;}
export function rational(n,d=1){
  if(!Number.isSafeInteger(n)||!Number.isSafeInteger(d)||d===0)throw new Error('無效的分數');
  if(d<0){n=-n;d=-d;}const g=gcd(n,d);return {n:n/g,d:d/g};
}
function parseFraction(label){
  const match=String(label).replaceAll('−','-').match(/^(-?\d+)(?:\/(\d+))?$/);
  if(!match)throw new Error('無效的係數');return rational(Number(match[1]),Number(match[2]||1));
}
function parsePi(label){
  if(String(label)==='0')return rational(0);
  const match=String(label).replaceAll('−','-').match(/^(-?)(\d*)π(?:\/(\d+))?$/);
  if(!match)throw new Error('無效的平移量');
  return rational((match[1]?-1:1)*Number(match[2]||1),Number(match[3]||1));
}
export function createFormula(p){
  const a=parseFraction(p.aLabel),b=parseFraction(p.bLabel),h=parsePi(p.hLabel);
  return {version:1,type:p.type,a,x:b,pi:rational(-b.n*h.n,b.d*h.d),k:p.k};
}
function validFraction(q){return q&&Number.isSafeInteger(q.n)&&Math.abs(q.n)<=10000&&Number.isSafeInteger(q.d)&&q.d>0&&q.d<=10000;}
export function validFormula(f){return !!(f&&['sin','cos','tan'].includes(f.type)&&[f.a,f.x,f.pi].every(validFraction)&&Number.isSafeInteger(f.k)&&Math.abs(f.k)<=10000);}
function termPlain(q,symbol=''){
  const n=Math.abs(q.n),top=(n===1&&symbol?'':String(n))+symbol;
  return (q.n<0?'−':'')+(q.d===1?top:`(${top})/${q.d}`);
}
export function formulaPlainText(f){
  if(!validFormula(f))throw new Error('無效的函數式');
  const a=f.a.n===f.a.d?'':termPlain(f.a)+' ';
  const phase=f.pi.n?` ${f.pi.n<0?'−':'+'} ${termPlain({...f.pi,n:Math.abs(f.pi.n)},'π')}`:'';
  return `y = ${a}${f.type}(${termPlain(f.x,'x')}${phase})${f.k?` ${f.k<0?'−':'+'} ${Math.abs(f.k)}`:''}`;
}
function termHtml(q,symbol=''){
  const n=Math.abs(q.n),top=(n===1&&symbol?'':String(n))+symbol;
  const value=q.d===1?top:`<span class="trig-fraction"><span class="trig-numerator">${top}</span><span class="trig-denominator">${q.d}</span></span>`;
  return (q.n<0?'−':'')+value;
}
export function formulaHtml(f){
  if(!validFormula(f))throw new Error('無效的函數式');
  const a=f.a.n===f.a.d?'':`<span class="trig-math-term">${termHtml(f.a)}</span>`;
  const phase=f.pi.n?`<span class="trig-math-sign">${f.pi.n<0?'−':'+'}</span><span class="trig-math-term">${termHtml({...f.pi,n:Math.abs(f.pi.n)},'π')}</span>`:'';
  const k=f.k?`<span class="trig-math-offset"><span class="trig-math-sign">${f.k<0?'−':'+'}</span><span>${Math.abs(f.k)}</span></span>`:'';
  return `<span class="trig-math-equation"><span>y =</span>${a}<span class="trig-function-name">${f.type}</span><span class="trig-math-argument"><span class="trig-math-paren">(</span><span class="trig-math-term">${termHtml(f.x,'x')}</span>${phase}<span class="trig-math-paren">)</span></span>${k}</span>`;
}
// Compatibility for a v3.1 round already in progress when the pages are refreshed.
export function legacyFormula(text){
  const m=String(text).match(/^y = (?:(\d+(?:\/\d+)?) )?(sin|cos|tan) (?:(\d+(?:\/\d+)?))?(?:x|\(x ([−+]) ([\dπ/]+)\))(?: ([−+]) (\d+))?$/);
  if(!m)return null;
  return createFormula({type:m[2],aLabel:m[1]||'1',bLabel:m[3]||'1',hLabel:m[5]?`${m[4]==='+'?'−':''}${m[5]}`:'0',k:m[7]?Number(m[7])*(m[6]==='−'?-1:1):0});
}
