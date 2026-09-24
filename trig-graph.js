export function normalizeGraphStyle(value={},theme='classic'){
  const dark=theme==='tech';
  const defaults={axisXColor:dark?'#9ac5d8':'#51657a',axisYColor:dark?'#9ac5d8':'#51657a',axisXWidth:1.2,axisYWidth:1.2,gridXColor:dark?'#11364b':'#e5edf5',gridYColor:dark?'#11364b':'#e5edf5',gridXWidth:1,gridYWidth:1,labelColor:dark?'#8eb4c7':'#64748b',labelSize:10};
  return Object.fromEntries(Object.entries(defaults).map(([key,fallback])=>[key,key.endsWith('Color')?(/^#[0-9a-f]{6}$/i.test(value?.[key])?value[key]:fallback):(Number.isFinite(Number(value?.[key]))?Math.max(key==='labelSize'?8:.5,Math.min(key==='labelSize'?20:6,Number(value[key]))):fallback)]));
}
export function evalTrig(p,x){const u=p.b*(x-p.h);let base;if(p.type==='sin')base=Math.sin(u);else if(p.type==='cos')base=Math.cos(u);else{const c=Math.cos(u);if(Math.abs(c)<0.035)return NaN;base=Math.tan(u);}const y=p.a*base+p.k;return Number.isFinite(y)?y:NaN;}
export function computeYRange(options,type){
  if(type==='tan'){const ks=options.map(p=>p.k);return {min:Math.min(...ks)-4.5,max:Math.max(...ks)+4.5};}
  let min=Infinity,max=-Infinity;for(const p of options){min=Math.min(min,p.k-p.a);max=Math.max(max,p.k+p.a);}min=Math.floor(min-0.5);max=Math.ceil(max+0.5);if(max-min<4){const c=(max+min)/2;min=c-2;max=c+2;}return {min,max};
}
export function makeGraphSvg(p,yr,settings={},theme="classic"){
  const s=normalizeGraphStyle(settings,theme);
  const W=360,H=220,L=42,R=336,T=20,B=192;const xmin=p.type==='tan'?-Math.PI: -2*Math.PI,xmax=p.type==='tan'?Math.PI:2*Math.PI;
  const sx=x=>L+(x-xmin)/(xmax-xmin)*(R-L), sy=y=>B-(y-yr.min)/(yr.max-yr.min)*(B-T);
  let grid='',axes='',labels='',asym='';
  const xStep=Math.PI/2;for(let m=Math.ceil(xmin/xStep);m<=Math.floor(xmax/xStep);m++){const x=m*xStep,px=sx(x);grid+=`<line class="trig-grid-line" style="stroke:${s.gridYColor};stroke-width:${s.gridYWidth}" x1="${px}" y1="${T}" x2="${px}" y2="${B}"/>`;if(m!==0)labels+=xTickLabel(m,px,Math.min(B+17,Math.max(T+s.labelSize,sy(0)+s.labelSize+4)),s);}
  for(let y=Math.ceil(yr.min);y<=Math.floor(yr.max);y++){const py=sy(y);grid+=`<line class="trig-grid-line" style="stroke:${s.gridXColor};stroke-width:${s.gridXWidth}" x1="${L}" y1="${py}" x2="${R}" y2="${py}"/>`;if(y!==0)labels+=`<text class="trig-tick-label" style="fill:${s.labelColor};font-size:${s.labelSize}px" x="${L-5}" y="${py+3}" text-anchor="end">${y}</text>`;}
  if(yr.min<=0&&yr.max>=0)axes+=`<line class="trig-axis axis-x" style="stroke:${s.axisXColor};stroke-width:${s.axisXWidth}" x1="${L}" y1="${sy(0)}" x2="${R}" y2="${sy(0)}"/>`;
  if(xmin<=0&&xmax>=0)axes+=`<line class="trig-axis axis-y" style="stroke:${s.axisYColor};stroke-width:${s.axisYWidth}" x1="${sx(0)}" y1="${T}" x2="${sx(0)}" y2="${B}"/>`;
  if(p.type==='tan'){
    const start=Math.floor((p.b*(xmin-p.h)-Math.PI/2)/Math.PI)-1,end=Math.ceil((p.b*(xmax-p.h)-Math.PI/2)/Math.PI)+1;
    for(let n=start;n<=end;n++){const x=p.h+(Math.PI/2+n*Math.PI)/p.b;if(x>xmin&&x<xmax)asym+=`<line class="trig-asymptote" x1="${sx(x)}" y1="${T}" x2="${sx(x)}" y2="${B}"/>`;}
  }
  let d='',pen=false,lastY=null;const N=420;
  for(let i=0;i<=N;i++){
    const x=xmin+(xmax-xmin)*i/N,y=evalTrig(p,x);const bad=!Number.isFinite(y)||y<yr.min-0.6||y>yr.max+0.6||lastY!==null&&Math.abs(y-lastY)>(yr.max-yr.min)*0.55;
    if(bad){pen=false;lastY=null;continue;}const px=sx(x),py=sy(y);d+=`${pen?' L':' M'} ${px.toFixed(2)} ${py.toFixed(2)}`;pen=true;lastY=y;
  }
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${/^[A-F]$/.test(p.id)?p.id:"函數"} 圖"><rect x="0" y="0" width="${W}" height="${H}" fill="transparent"/>${grid}${asym}${axes}<path class="trig-curve" style="stroke:${theme==='tech'?'#67e8f9':'#2563eb'}" d="${d}"/>${labels}</svg>`;
}
function piTick(m){
  if(m===0)return'0';const sign=m<0?'−':'';const a=Math.abs(m);if(a===1)return`${sign}π/2`;if(a===2)return`${sign}π`;if(a%2===0)return`${sign}${a/2}π`;return`${sign}${a}π/2`;
}


function xTickLabel(m,x,y,s){
  const style=`fill:${s.labelColor};font-size:${s.labelSize}px`;
  if(m%2===0)return `<text class="trig-tick-label" style="${style}" x="${x}" y="${y}" text-anchor="middle">${piTick(m)}</text>`;
  const a=Math.abs(m),numerator=`${m<0?'−':''}${a===1?'':a}π`,size=s.labelSize*.78,width=
    Math.max(size,numerator.length*size*.63);
  return `<g class="trig-fraction-tick" style="fill:${s.labelColor};font-size:${size}px;font-weight:700" text-anchor="middle"><text x="${x}" y="${y-5}">${numerator}</text><line x1="${x-width/2}" x2="${x+width/2}" y1="${y-3}" y2="${y-3}" style="stroke:${s.labelColor};stroke-width:1"/><text x="${x}" y="${y+size-2}">2</text></g>`;
}
