/* PdcPdf — يحوّل ميجر pdc (xlsx) إلى PDF مطابق لإكسل:
   الخلفية = صفحة PDF صدّرها إكسل نفسه (القالب بدون القيم المتغيرة)، والمحرك يكتب فوقها القيم المتغيرة فقط
   بنفس الخلايا والخطوط (Liberation Sans = مقاسات Arial، Carlito = مقاسات Calibri). */
(function(G){
'use strict';
const colNum=s=>{let n=0;for(const ch of s)n=n*26+ch.charCodeAt(0)-64;return n;};
const unesc=s=>s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&#x([0-9a-fA-F]+);/g,(m,h)=>String.fromCodePoint(parseInt(h,16))).replace(/&#(\d+);/g,(m,d)=>String.fromCodePoint(+d)).replace(/&amp;/g,'&');
const parseRef=s=>{const m=/^\$?([A-Z]{1,3})\$?(\d+)$/.exec(s);return m?[+m[2],colNum(m[1])]:null;};
const key=(r,c)=>r*1000+c;
function parseRange(s){const [a,b]=s.split(':');const p=parseRef(a),q=b?parseRef(b):p;return [Math.min(p[0],q[0]),Math.min(p[1],q[1]),Math.max(p[0],q[0]),Math.max(p[1],q[1])];}

/* ---------- قراءة الورقة ---------- */
function parseSheet(xml){
  const cells=new Map();const shared={};
  const re=/<c r="([A-Z]{1,3})(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;let m;
  while((m=re.exec(xml))){const c=colNum(m[1]),r=+m[2],at=m[3]||'',body=m[4]||'';
    const s=+((/\bs="(\d+)"/.exec(at)||[])[1]||0),t=(/\bt="(\w+)"/.exec(at)||[])[1]||'n';
    const o={r,c,s,t};
    const fm=/<f([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/.exec(body);
    if(fm){const fa=fm[1]||'';const si=(/\bsi="(\d+)"/.exec(fa)||[])[1];
      if(/t="shared"/.test(fa)&&si!=null){if(fm[2]){shared[si]={r,c,f:unesc(fm[2])};o.f=unesc(fm[2]);}else o.fsi=si;}
      else if(fm[2])o.f=unesc(fm[2]);}
    if(t==='inlineStr'){const tt=[...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x=>x[1]).join('');o.v=unesc(tt);}
    else{const vm=/<v>([\s\S]*?)<\/v>/.exec(body);if(vm)o.v=unesc(vm[1]);}
    cells.set(key(r,c),o);}
  // المعادلات المشتركة: نزيح المراجع النسبية حسب بعد الخلية عن الخلية الأم
  for(const o of cells.values())if(o.fsi!=null&&shared[o.fsi]){const S=shared[o.fsi];o.f=shiftF(S.f,o.r-S.r,o.c-S.c);}
  const merges=[...xml.matchAll(/<mergeCell ref="([A-Z0-9:]+)"/g)].map(x=>parseRange(x[1]));
  const cf=[];for(const b of xml.matchAll(/<conditionalFormatting[^>]*sqref="([^"]+)"[^>]*>([\s\S]*?)<\/conditionalFormatting>/g)){
    const rngs=b[1].split(/\s+/).map(parseRange);
    for(const rm of b[2].matchAll(/<cfRule([^>]*)>([\s\S]*?)<\/cfRule>/g)){const a=rm[1];
      cf.push({rngs,type:(/type="(\w+)"/.exec(a)||[])[1],op:(/operator="(\w+)"/.exec(a)||[])[1],dxf:+((/dxfId="(\d+)"/.exec(a)||[])[1]||-1),f:((/<formula>([\s\S]*?)<\/formula>/.exec(rm[2])||[])[1]||'')});}}
  const showZeros=!/<sheetView [^>]*showZeros="0"/.test(xml);
  return{cells,merges,cf,showZeros};}
function colStr(n){let s='';while(n>0){const m=(n-1)%26;s=String.fromCharCode(65+m)+s;n=Math.floor((n-1)/26);}return s;}
function shiftF(f,dr,dc){
  return f.replace(/("(?:[^"]|"")*")|(\[[^\]]*\])|(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\w(])/g,(m,str,tbl,d1,col,d2,row)=>{
    if(str||tbl)return m;const c=d1?colNum(col):colNum(col)+dc,r=d2?+row:+row+dr;return d1+colStr(c)+d2+r;});}

/* ---------- الأنماط ---------- */
function parseStyles(xml,themeXml){
  const numFmts={};for(const m of xml.matchAll(/<numFmt numFmtId="(\d+)" formatCode="([^"]*)"/g))numFmts[+m[1]]=unesc(m[2]);
  const theme=['FFFFFF','000000','E7E6E6','44546A','4472C4','ED7D31','A5A5A5','FFC000','5B9BD5','70AD47'];
  if(themeXml){const cs=[...themeXml.matchAll(/<a:(?:srgbClr val|sysClr[^>]*lastClr)="([0-9A-Fa-f]{6})"/g)].map(x=>x[1]);
    if(cs.length>=10){theme[0]=cs[1];theme[1]=cs[0];theme[2]=cs[3];theme[3]=cs[2];for(let i=4;i<10;i++)theme[i]=cs[i];}}
  const color=a=>{if(!a)return null;const rgb=/rgb="(?:[0-9A-Fa-f]{2})?([0-9A-Fa-f]{6})"/.exec(a);if(rgb)return rgb[1];const th=/theme="(\d+)"/.exec(a);if(th)return theme[+th[1]]||'000000';return null;};
  const fontsX=(/<fonts[^>]*>([\s\S]*?)<\/fonts>/.exec(xml)||[])[1]||'';
  const fonts=[...fontsX.matchAll(/<font>([\s\S]*?)<\/font>|<font\/>/g)].map(m=>{const b=m[1]||'';
    return{name:(/<name val="([^"]+)"/.exec(b)||[])[1]||'Calibri',sz:+((/<sz val="([\d.]+)"/.exec(b)||[])[1]||11),b:/<b\/>|<b val="(1|true)"\/>/.test(b),i:/<i\/>/.test(b),color:color((/<color([^>]*)\/>/.exec(b)||[])[1])||'000000'};});
  const xfsX=(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)||[])[1]||'';
  const xfs=[...xfsX.matchAll(/<xf([^>]*?)(?:\/>|>([\s\S]*?)<\/xf>)/g)].map(m=>{const a=m[1],b=m[2]||'';const al=(/<alignment([^>]*)\/>/.exec(b)||[])[1]||'';
    return{font:+((/fontId="(\d+)"/.exec(a)||[])[1]||0),nf:+((/numFmtId="(\d+)"/.exec(a)||[])[1]||0),
      h:(/horizontal="(\w+)"/.exec(al)||[])[1]||'general',v:(/vertical="(\w+)"/.exec(al)||[])[1]||'bottom',
      wrap:/wrapText="1"/.test(al),shrink:/shrinkToFit="1"/.test(al),indent:+((/indent="(\d+)"/.exec(al)||[])[1]||0),ro:+((/readingOrder="(\d+)"/.exec(al)||[])[1]||0)};});
  const dxfsX=(/<dxfs[^>]*>([\s\S]*?)<\/dxfs>/.exec(xml)||[])[1]||'';
  const dxfs=[...dxfsX.matchAll(/<dxf>([\s\S]*?)<\/dxf>/g)].map(m=>{const b=m[1];const fill=/<fill>[\s\S]*?<bgColor([^>]*)\/>/.exec(b)||/<fill>[\s\S]*?<fgColor([^>]*)\/>/.exec(b);
    return{fill:fill?color(fill[1]):null,font:color((/<font>[\s\S]*?<color([^>]*)\/>/.exec(b)||[])[1])};});
  return{numFmts,fonts,xfs,dxfs};}
const BUILTIN_NF={0:'General',1:'0',2:'0.00',3:'#,##0',4:'#,##0.00',9:'0%',10:'0.00%',14:'dd/mm/yyyy',49:'@'};

/* ---------- تقييم المعادلات (نفس سلوك إكسل للأنواع المستخدمة في القالب) ---------- */
const NA={err:'#N/A'};
function makeEval(sheet,tables,sst){
  const memo=new Map();const busy=new Set();
  function raw(o){if(!o)return null;if(o.v==null)return null;
    if(o.t==='s')return sst(+o.v);if(o.t==='inlineStr'||o.t==='str')return o.v;if(o.t==='b')return o.v==='1';if(o.t==='e')return NA;
    const n=+o.v;return isNaN(n)?o.v:n;}
  function val(r,c){const k=key(r,c);if(memo.has(k))return memo.get(k);const o=sheet.cells.get(k);
    if(!o||!o.f){const v=raw(o);memo.set(k,v);return v;}
    if(busy.has(k))return 0;busy.add(k);let v;
    try{v=evalF(o.f);}catch(e){v=raw(o);}
    busy.delete(k);if(v===undefined)v=null;memo.set(k,v);return v;}
  function evalF(f){const tk=[];const re=/\s*(\$?[A-Z]{1,3}\$?\d+:\$?[A-Z]{1,3}\$?\d+|\$?[A-Z]{1,3}\$?\d+(?![\w(])|_xlfn\.[A-Z.]+(?=\()|[A-Z_][A-Z0-9_.]*\[[^\]]*\]|[A-Z][A-Z0-9_.]*(?=\()|TRUE|FALSE|\d+(?:\.\d+)?(?:E[+-]?\d+)?|"(?:[^"]|"")*"|[-+*/(),&=<>^%])/gy;
    let m;re.lastIndex=0;while(re.lastIndex<f.length&&(m=re.exec(f)))tk.push(m[1]);let i=0;
    const peek=()=>tk[i],next=()=>tk[i++];
    const num=v=>{if(v==null||v==='')return 0;if(typeof v==='number')return v;if(typeof v==='boolean')return v?1:0;if(v&&v.err)throw v;const n=+v;if(isNaN(n))throw {err:'#VALUE!'};return n;};
    function prim(){const t=next();
      if(t==='('){const v=expr();next();return v;}
      if(t==='-')return -num(prim());if(t==='+')return num(prim());
      if(/^"/.test(t))return t.slice(1,-1).replace(/""/g,'"');
      if(/^\d/.test(t))return +t;if(t==='TRUE')return true;if(t==='FALSE')return false;
      if(/\[/.test(t))return{table:t.replace(/\[.*$/,'')};
      if(/:/.test(t)){return{range:parseRange(t)};}
      const rf=parseRef(t);if(rf){const v=val(rf[0],rf[1]);return v==null?null:v;}
      // دالة
      const fn=t.replace(/^_xlfn\./,'');next();const args=[];
      if(peek()!==')'){while(true){args.push(expr());if(peek()===','){next();continue;}break;}}
      next();return call(fn,args);}
    function pw(){let v=prim();while(peek()==='%'){next();v=num(v)/100;}return v;}
    function mul(){let v=pw();while(peek()==='*'||peek()==='/'){const op=next(),b=pw();v=op==='*'?num(v)*num(b):num(v)/num(b);}return v;}
    function add(){let v=mul();while(peek()==='+'||peek()==='-'){const op=next(),b=mul();v=op==='+'?num(v)+num(b):num(v)-num(b);}return v;}
    function cat(){let v=add();while(peek()==='&'){next();const b=add();v=String(v==null?'':v)+String(b==null?'':b);}return v;}
    function expr(){let v=cat();while(['=','<','>'].includes(peek())){let op=next();if((op==='<'||op==='>')&&(peek()==='='||peek()==='>')){op+=next();}const b=cat();
      const a1=v==null?0:v,b1=b==null?0:b;v=op==='='?a1==b1:op==='<>'?a1!=b1:op==='<'?a1<b1:op==='>'?a1>b1:op==='<='?a1<=b1:a1>=b1;}return v;}
    function call(fn,a){
      if(fn==='IFNA')return(a[0]&&a[0].err==='#N/A')?a[1]:a[0];
      if(fn==='IFERROR')return(a[0]&&a[0].err)?a[1]:a[0];
      if(fn==='SUM'){let s=0;a.forEach(x=>{if(x&&x.range){const[r1,c1,r2,c2]=x.range;for(let r=r1;r<=r2;r++)for(let c=c1;c<=c2;c++){const v=val(r,c);if(typeof v==='number')s+=v;}}else s+=num(x);});return s;}
      if(fn==='VLOOKUP'){const k=a[0],tb=a[1]&&a[1].table,col=num(a[2]);const T=tables[tb];if(!T||k==null||k===''||(k&&k.err))return NA;
        const rec=T[String(k)];if(!rec)return NA;if((typeof k==='number')!==(rec.t==='n'))return NA; // إكسل يفرّق بين الرقم والنص
        const v=rec[String(col)];return v==null?0:v;}
      if(fn==='IF')return(a[0]&&a[0]!==0)?a[1]:(a.length>2?a[2]:false);
      if(fn==='ROUND'){const p=Math.pow(10,num(a[1]));return Math.round(num(a[0])*p)/p;}
      throw{err:'#NAME?'};}
    try{return expr();}catch(e){if(e&&e.err)return e;throw e;}}
  return{val};}

/* ---------- تنسيق الأرقام ---------- */
function fmtNum(v,code){
  if(v==null||v==='')return '';if(v&&v.err)return v.err;if(typeof v==='boolean')return v?'TRUE':'FALSE';if(typeof v==='string')return v;
  code=code||'General';
  if(code==='General'||code==='@'){if(Number.isInteger(v))return String(v);const s=String(+v.toPrecision(10));return s;}
  const secs=code.split(';');let sec=secs[0],neg=false;
  if(v<0&&secs[1]){sec=secs[1];neg=true;}else if(v===0&&secs[2])sec=secs[2];
  const lits=[];sec.replace(/"([^"]*)"/g,(m,x)=>{lits.push(x);return m;});
  const body=sec.replace(/"[^"]*"|_.|\*.|\\./g,'').replace(/[^#0.,%?]/g,'');
  let out;
  if(!/[#0]/.test(body)){out=lits.join(' ').trim();}
  else{const dec=((/\.([0#?]+)/.exec(body)||[])[1]||'').length;const grp=/,/.test(body);let x=Math.abs(v);if(/%/.test(body))x*=100;
    out=x.toLocaleString('en-US',{minimumFractionDigits:dec,maximumFractionDigits:dec,useGrouping:grp});
    if(/%/.test(body))out+='%';if(v<0&&!neg)out='-'+out;else if(neg&&/\\-|^-/.test(secs[1]))out='-'+out;
    const pre=(/^[^#0?]*?"([^"]*)"/.exec(sec.split(/[#0?]/)[0])||[])[1];const post=(/"([^"]*)"[^"#0?]*$/.exec(sec)||[])[1];
    if(pre&&sec.indexOf('"'+pre+'"')<sec.search(/[#0?]/))out=pre+out;
    if(post&&sec.lastIndexOf('"'+post+'"')>sec.search(/[#0?]/))out=out+' '+post;}
  return out;}

/* ---------- اختيار الخط ---------- */
const AR=/[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/;
function fontKey(name,b){const n=(name||'').toLowerCase();const fam=n.includes('nova')?'nova':n.includes('calibri')?'carlito':'liber';return fam+(b?'B':'R');}

/* تقسيم النص لمقاطع عربية/لاتينية (اتجاه أساسي يمين→يسار للنص العربي) */
function bidiRuns(text){const runs=[];let cur=null;
  for(const ch of text){const t=AR.test(ch)?'R':(/[A-Za-z0-9]/.test(ch)?'L':'N');
    if(!cur){cur={t:t==='N'?'?':t,s:ch};continue;}
    if(t==='N'||t===cur.t||cur.t==='?'){cur.s+=ch;if(cur.t==='?'&&t!=='N')cur.t=t;}else{runs.push(cur);cur={t,s:ch};}}
  if(cur)runs.push(cur);
  // المسافات والرموز في أطراف المقطع اللاتيني تتبع العربي
  runs.forEach(r=>{if(r.t==='?')r.t='R';});
  return runs;}
const AR_DIG=0.556,AR_DY=0.3;
const AR_W={'ر.س.\u200f':2.03,'ر.س.':2.03};
const AR_SCALE=0.77;
function segments(text,rtl){const out=[];let cur=null;
  const cls=ch=>AR.test(ch)?'A':/[0-9]/.test(ch)?'D':/[A-Za-z]/.test(ch)?'L':'N';
  const chars=[...text];
  chars.forEach((ch,i)=>{let t=cls(ch);
    if(t==='N'&&(ch==='.'||ch===',')&&cur&&cur.t==='D'&&i+1<chars.length&&cls(chars[i+1])==='D')t='D';
    if(cur&&cur.t===t)cur.s+=ch;else{cur={t,s:ch};out.push(cur);}});
  out.forEach(sg=>{if(sg.t==='N'){sg.draw=rtl?[...sg.s].reverse().map(ch=>MIRROR[ch]||ch).join(''):sg.s;}
    else if(sg.t==='D'){sg.draw=sg.s;} // V387: الأرقام بالإنجليزي دائماً (طلب المدير)
    else sg.draw=sg.s;});
  // في السياق اللاتيني: المحايد بين حروف عربية يتبع العربي
  return out;}
/* ترتيب العرض البصري: قائمة قطع من اليسار لليمين. النص الإنجليزي/الرقمي الذي فيه كلمة عربية (مثل «2,156.00 ر.س.») تُعرض الكلمة العربية كوحدة يمين→يسار */
function layout(text,rtl){
  const piece=sg=>({draw:sg.draw,ar:sg.t==='A',dig:false});
  if(rtl)return segments(text,true).reverse().map(piece);
  const out=[];const re=/[\u0600-\u06FF][\u0600-\u06FF .\u200f\u060C]*/g;let last=0,m;
  const pushL=t=>{if(t)segments(t,false).forEach(sg=>out.push({draw:sg.draw,ar:false}));};
  while((m=re.exec(text))){pushL(text.slice(last,m.index));let u=m[0];const tr=u.replace(/\s+$/,'');
    out.push({group:segments(tr,true).reverse().map(sg=>({draw:sg.draw,ar:sg.t==='A',dig:false})),key:tr});
    if(tr.length<u.length)pushL(u.slice(tr.length));last=m.index+u.length;}
  pushL(text.slice(last));return out;}
const MIRROR={'(':')',')':'(','<':'>','>':'<','[':']',']':'[','{':'}','}':'{'};

async function render(opts){
  const{PDFLib,fontkit,JSZip}=opts.libs;const{PDFDocument,rgb,pushGraphicsState,popGraphicsState,rectangle,clip,endPath}=PDFLib;
  const zip=opts.zip||await JSZip.loadAsync(opts.xlsx); // V388: يقبل الملف مباشرة بدون ضغط/فك (أسرع)
  const sheetXml=await zip.file(opts.sheetPath||'xl/worksheets/sheet1.xml').async('string');
  const stylesXml=await zip.file('xl/styles.xml').async('string');
  const themeF=zip.file('xl/theme/theme1.xml');const themeXml=themeF?await themeF.async('string'):'';
  let sstArr=null;const sstF=zip.file('xl/sharedStrings.xml');
  const sst=i=>{if(!sstArr){sstArr=[];if(sstF&&opts._sstXml)for(const m of opts._sstXml.matchAll(/<si>([\s\S]*?)<\/si>/g))sstArr.push(unesc([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x=>x[1]).join('')));}return sstArr[i]==null?'':sstArr[i];};
  if(sstF)opts._sstXml=await sstF.async('string');
  const sheet=parseSheet(sheetXml),sty=parseStyles(stylesXml,themeXml);
  const tplSheet=opts.tplSheet||(opts.tplSheet=parseSheet(opts.tplSheetXml));
  const E=makeEval(sheet,opts.tables,sst);
  const geo=opts.geom,X=geo.X,Y=geo.Y,H=geo.H,SC=geo.s;
  const maxR=opts.maxRow||65,maxC=opts.maxCol||122,minR=opts.minRow||5;
  // خريطة الدمج
  const mtl=new Map();sheet.merges.forEach(g=>{for(let r=g[0];r<=g[2];r++)for(let c=g[1];c<=g[3];c++)mtl.set(key(r,c),g);});
  // هل الخلية متغيرة؟ (معادلة تعتمد على مدخلات، أو فاضية في القالب)
  const dynSet=new Set(opts.dyn||[]);
  const isDyn=(r,c)=>{const ref=colStr(c)+r;if(dynSet.has(ref))return true;const t=tplSheet.cells.get(key(r,c));return !t||(t.v==null&&!t.f);};

  /* الصفحة نفسها = صفحة إكسل الأصلية (بدون تغليفها في XObject) — حتى يبقى التكبير/التصغير حاد مثل ملف إكسل تماماً */
  const doc=await PDFDocument.load(opts.bgPdf);doc.registerFontkit(fontkit);
  const page=doc.getPage(0);page.node.normalize&&page.node.normalize();
  /* الخطوط تُحمّل وتُضمَّن عند الحاجة فقط (الخطوط اللاتينية مقلّصة مسبقاً، والعربي يُقلَّص هنا) */
  const _F={};const gF=async k=>{if(_F[k])return _F[k];let b=opts.fonts&&opts.fonts[k];if(!b&&opts.loadFont)b=await opts.loadFont(k);
    if(!b){if(k!=='liberB')return gF('liberB');throw new Error('font '+k);}return _F[k]=await doc.embedFont(b,{subset:/^ar/.test(k)});};
  const fm=f=>{const fk=f.embedder&&f.embedder.font;const u=fk?fk.unitsPerEm:1000;return{asc:fk?fk.ascent/u:0.9,desc:fk?-fk.descent/u:0.21};};
  const rectOf=(r,c)=>{const g=mtl.get(key(r,c));const r1=g?g[0]:r,c1=g?g[1]:c,r2=g?g[2]:r,c2=g?g[3]:c;return{x0:X[c1-1],x1:X[c2],t:Y[r1-1],b:Y[r2],r1,c1,r2,c2,merged:!!g};};
  const hex=h=>{const n=parseInt(h||'000000',16);return rgb(((n>>16)&255)/255,((n>>8)&255)/255,(n&255)/255);};
  const PAD=opts.pad==null?1.6*SC:opts.pad;

  // 1) تعبئة التنسيق الشرطي (اللون الأصفر لما الكمية > 0)
  sheet.cf.forEach(rule=>{if(rule.type!=='cellIs')return;const d=sty.dxfs[rule.dxf];if(!d||!d.fill)return;const thr=+rule.f;
    rule.rngs.forEach(([r1,c1,r2,c2])=>{for(let r=r1;r<=r2;r++)for(let c=c1;c<=c2;c++){if(r<minR||r>maxR||c>maxC)continue;const g=mtl.get(key(r,c));if(g&&(g[0]!==r||g[1]!==c))continue;
      const v=E.val(r,c);if(typeof v!=='number')continue;let ok=false;
      if(rule.op==='greaterThan')ok=v>thr;else if(rule.op==='equal')ok=v==thr;else if(rule.op==='lessThan')ok=v<thr;else if(rule.op==='notEqual')ok=v!=thr;else if(rule.op==='greaterThanOrEqual')ok=v>=thr;
      if(!ok||!isDyn(r,c))continue;const R=rectOf(r,c);
      page.drawRectangle({x:R.x0+0.35,y:H-R.b+0.35,width:R.x1-R.x0-0.7,height:R.b-R.t-0.7,color:hex(d.fill)});}});});

  // 2) النصوص
  const drawn=[];
  /* مكتبة الأوصاف: نصوص عربية مرسومة بإكسل نفسه (من PDF صدّره المستخدم) — تُنقل كما هي = نفس خط إكسل 100% */
  const LB=opts.arLib||null,libJobs=[];const nrm=t=>String(t||'').replace(/\s+/g,' ').trim();
  // مطابقة مرنة: نفس النص مع اختلاف الهمزات/الياء/التاء المربوطة فقط (مثل أحادي ↔ آحادي)
  const anrm=t=>nrm(t).replace(/\s*([\/\-\(\)\.,،:])\s*/g,'$1').replace(/[\u064B-\u065F\u0640]/g,'').replace(/[آأإٱ]/g,'ا').replace(/ى/g,'ي').replace(/ة/g,'ه').replace(/ؤ/g,'و').replace(/ئ/g,'ي');
  if(LB&&!LB._n){LB._n={};for(const z in LB.map){const o={};for(const t in LB.map[z])o[anrm(t)]=LB.map[z][t];LB._n[z]=o;}}
  for(const o of sheet.cells.values()){const{r,c}=o;if(r<minR||r>maxR||c>maxC)continue;
    const g=mtl.get(key(r,c));if(g&&(g[0]!==r||g[1]!==c))continue;if(!isDyn(r,c))continue;
    const v=E.val(r,c);if(v==null||v==='')continue;if(v===0&&!sheet.showZeros)continue;
    const xf=sty.xfs[o.s]||sty.xfs[0];const fo=sty.fonts[xf.font]||sty.fonts[0];
    const code=sty.numFmts[xf.nf]||BUILTIN_NF[xf.nf]||'General';
    let text=fmtNum(v,code);if(text==='')continue;
    const R=rectOf(r,c);const size=fo.sz*(geo.fs||0.62);
    const isAr=AR.test(text);const fs1=(/[A-Za-z0-9\u0600-\u06FF]/.exec(text)||[''])[0];const rtl=isAr&&AR.test(fs1);
    let h=xf.h;if(h==='general')h=(typeof v==='number')?'right':(rtl&&xf.ro!==1?'right':'left');
    if(h==='centerContinuous'||h==='fill'||h==='justify'||h==='distributed')h='center';
    if(LB&&rtl&&h==='right'){const m=LB.map[String(fo.sz)];let e=m&&(m[nrm(text)]||LB._n[String(fo.sz)][anrm(text)]);
      // ما تطابق النص؟ نأخذ وصف العقد لرقم البند اللي في نفس الصف (AE للمقاول / CM للاستشاري)
      if(!e&&LB.code){const cc={AL:['AE','S'],CT:['CM','C']}[colStr(c)];if(cc){const cd=String(E.val(r,colNum(cc[0]))??'').trim();e=LB.code[cc[1]]&&LB.code[cc[1]][cd]||null;}}const cal=LB.cal[String(fo.sz)];
      if(e&&cal){libJobs.push({e,R,cal,ref:colStr(c)+r});drawn.push({ref:colStr(c)+r,text,lib:1});continue;}}
    const fL=await gF(fontKey(fo.name,fo.b)),fA=isAr?await gF(fo.b?'arB':'arR'):fL;
    // مقاطع النص: عربي (A) / أرقام (D) / لاتيني (L) / محايد (N) — في السياق العربي إكسل يعرض الأرقام بالهندية ويعكس الرموز
    const pcs=layout(text,rtl);
    const pW=(p,z)=>{if(p.group){const nat=p.group.reduce((a,q)=>a+pW(q,z),0);return AR_W[p.key]?AR_W[p.key]*z:nat;}
      if(p.dig)return [...p.draw].reduce((a,ch)=>a+(/[\u0660-\u0669]/.test(ch)?AR_DIG*z:fA.widthOfTextAtSize(ch,z*AR_SCALE)),0);
      const ff=p.ar?fA:fL;return ff.widthOfTextAtSize(p.draw,z*(p.ar?AR_SCALE:1));};
    let w=pcs.reduce((a,p)=>a+pW(p,size),0);
    let sz=size;if(xf.shrink&&w>R.x1-R.x0-2*PAD){const k=(R.x1-R.x0-2*PAD)/w;sz=size*k;w*=k;}
    // تنسيق المحاسبة (* تعبئة): الرقم يلتصق يمين الخلية مع حشوة بعرض الرموز بعد _ في آخر القسم
    let padR=PAD;if(typeof v==='number'&&/\*./.test(code)){h='right';const sec=(v<0&&code.split(';')[1])?code.split(';')[1]:(v===0&&code.split(';')[2])?code.split(';')[2]:code.split(';')[0];
      const tail=(/((?:_.)+)\s*$/.exec(sec)||[])[1]||'';padR=[...tail].filter((ch,i)=>i%2===1).reduce((s,ch)=>s+fL.widthOfTextAtSize(ch,sz),0)+1.52;}
    let x;if(h==='center')x=(R.x0+R.x1)/2-w/2;else if(h==='right')x=R.x1-padR-w;else x=R.x0+PAD+xf.indent*3*SC;
    x+=(opts.dx==null?0.38:opts.dx);
    const met=fm(fL);let base;
    if(xf.v==='center')base=(R.t+R.b)/2+(met.asc-met.desc)*sz/2;
    else if(xf.v==='top')base=R.t+PAD*0.5+met.asc*sz;
    else base=R.b-PAD*0.6-met.desc*sz;
    base+=(opts.dy==null?-0.3:opts.dy);
    // القص: الخلايا المدموجة أو النص المحاذي لليمين/الوسط يُقص داخل الخلية؛ النص اليساري في خلية مفردة يمتد للخلايا الفاضية
    const needClip=w>R.x1-R.x0-0.5;
    if(needClip){page.pushOperators(pushGraphicsState(),rectangle(R.x0+0.3,H-R.b,R.x1-R.x0-0.6,R.b-R.t),clip(),endPath());}
    // الترتيب البصري: النص العربي يبدأ من اليمين → نعكس ترتيب المقاطع
    let cx=x;const col=hex(fo.color);
    const drawP=(p,x0)=>{if(p.dig){let dx=x0;for(const ch of [...p.draw].reverse()){const isd=/[\u0660-\u0669]/.test(ch);const gw=fA.widthOfTextAtSize(ch,sz*AR_SCALE);const adv=isd?AR_DIG*sz:gw;page.drawText(ch,{x:dx+(adv-gw)/2,y:H-base+AR_DY,size:sz*AR_SCALE,font:fA,color:col});dx+=adv;}return;}
      const ff=p.ar?fA:fL;page.drawText(p.draw,{x:x0,y:H-base+(p.ar?AR_DY:0),size:sz*(p.ar?AR_SCALE:1),font:ff,color:col});};
    for(const p of pcs){const want=pW(p,sz);
      if(p.group){const nat=p.group.reduce((a,q)=>a+pW(q,sz),0);let gx=cx+(want-nat)/2;for(const q of p.group){drawP(q,gx);gx+=pW(q,sz);}}
      else drawP(p,cx);cx+=want;}
    if(needClip)page.pushOperators(popGraphicsState());
    drawn.push({ref:colStr(c)+r,text,x,base,w,size:sz});}
  if(libJobs.length){const src=LB.doc;
    const emb=await doc.embedPages(libJobs.map(j=>src.getPage(j.e[0])),libJobs.map(j=>({left:j.e[3],bottom:j.e[4],right:j.e[5],top:j.e[6]})));
    libJobs.forEach((j,i)=>{const{e,R,cal}=j;const xEnd=R.x1-cal.pad,yB=H-((R.t+R.b)/2+cal.k);
      page.pushOperators(pushGraphicsState(),rectangle(R.x0+0.3,H-R.b,R.x1-R.x0-0.3,R.b-R.t),clip(),endPath());
      const k=cal.s||1;page.drawPage(emb[i],{x:xEnd+(e[3]-e[1])*k,y:yB+(e[4]-e[2])*k,xScale:k,yScale:k});
      page.pushOperators(popGraphicsState());});}
  // 3) التوقيع (متجه)
  if(opts.sig&&opts.sig.d){const sg=opts.sig;const R={x0:X[sg.c0],x1:X[sg.c1],t:Y[sg.r0]+sg.dy0,b:Y[sg.r1]+(sg.dy1||0)};
    const sx=(R.x1-R.x0)/sg.w,sy=(R.b-R.t)/sg.h;const s=Math.min(sx,sy);const ox=R.x0+((R.x1-R.x0)-sg.w*s)/2,oy=R.t+((R.b-R.t)-sg.h*s)/2;
    page.drawSvgPath(sg.d,{x:ox+(sg.tx||0)*s,y:H-(oy+(sg.ty||0)*s),scale:s,color:hex(sg.color||'1537A8'),borderWidth:0});}
  return{doc,page,drawn,tplSheet};}
G.PdcPdf={render,parseSheet,parseStyles,fmtNum,shiftF};
})(typeof window!=='undefined'?window:globalThis);
