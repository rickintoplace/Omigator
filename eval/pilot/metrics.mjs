import { readFileSync, existsSync } from 'node:fs';
const C = JSON.parse(readFileSync('pilot/candidates.json','utf8'));
const gold = new Set(readFileSync('/Users/aaron/Documents/omigator/eval/hypoxia_gold.txt','utf8').match(/GSE\d+/g));
const G = 46; // denominator as in the original report
const lg = p => Math.log(Math.min(Math.max(p,1e-12),1-1e-12));
const logit = p => lg(p) - Math.log(1-Math.min(Math.max(p,1e-12),1-1e-12));
const load = f => existsSync(`pilot/res-${f}.jsonl`) ? Object.fromEntries(readFileSync(`pilot/res-${f}.jsonl`,'utf8').trim().split('\n').map(l=>{const r=JSON.parse(l);return [r.gse,r];})) : null;
let seed=20261019; const rnd=()=>((seed=(seed*1664525+1013904223)>>>0)/2**32);
function metrics(rows){ // rows: [{gse, s, y}]
  const s=[...rows].sort((a,b)=>b.s-a.s); const P=s.filter(r=>r.y).length, N=s.length;
  const at=k=>s.slice(0,k).filter(r=>r.y).length;
  let ap=0,h=0; s.forEach((r,i)=>{ if(r.y){h++; ap+=h/(i+1);} }); ap/=P;
  const pos=s.filter(r=>r.y).map(r=>r.s), neg=s.filter(r=>!r.y).map(r=>r.s);
  let au=0; for(const a of pos) for(const b of neg) au+= a>b?1:a===b?0.5:0; au/=pos.length*neg.length;
  let k95=0,c=0; for(let i=0;i<N;i++){ if(s[i].y) c++; if(c>=Math.ceil(0.95*P)){k95=i+1;break;} }
  const ties = N - new Set(s.map(r=>r.s)).size;
  return { auroc:au, ap, p20:at(20)/20, p50:at(50)/50, r50:at(50)/G, r100:at(100)/G, wss95:(N-k95)/N-0.05, k95, ties };
}
function boot(rows, key, B=2000){ const v=[]; for(let b=0;b<B;b++){ const smp=rows.map(()=>rows[Math.floor(rnd()*rows.length)]); if(!smp.some(r=>r.y)||smp.every(r=>r.y)) continue; v.push(metrics(smp)[key]); } v.sort((a,b)=>a-b); return [v[Math.floor(0.025*v.length)], v[Math.floor(0.975*v.length)]]; }
const conds = [];
for (const f of ['dec27','dec4']) { const R=load(f); if(!R) continue;
  conds.push([`${f} overall`, d=>logit(R[d.gse].p.overall)]);
  conds.push([`${f} criteria (Σ log p)`, d=>['bulk_rnaseq','human_in_vitro','hypoxia_low_o2','normoxia_control'].reduce((a,k)=>a+lg(R[d.gse].p[k]),0)]);
  conds.push([`${f} criteria+overall`, d=>['bulk_rnaseq','human_in_vitro','hypoxia_low_o2','normoxia_control','overall'].reduce((a,k)=>a+lg(R[d.gse].p[k]),0)]);
}
for (const f of ['ds41','q397']) { const R=load(f); if(!R || Object.keys(R).length<C.length) { if(R) console.log(`${f}: ${Object.keys(R).length}/${C.length} scored, skipped`); continue; } conds.push([`${f} logprob overall`, d=>logit(R[d.gse].p.overall)]); }
console.log('candidates', C.length, 'gold retrieved', C.filter(d=>gold.has(d.gse)).length, '/ 46\n');
console.log('OLD (glm-4.7, verbalized 0-100, from eval/runs): P@20 0.800  P@50 0.600  R@50 0.652  (t=70 and t=80 identical → heavy ties)\n');
console.log('condition'.padEnd(30), 'AUROC [95% CI]       AP     P@20  P@50  R@50  R@100 WSS@95 (n read) ties');
for (const [name,f] of conds) { const rows=C.map(d=>({gse:d.gse,s:f(d),y:gold.has(d.gse)})); const m=metrics(rows); const ci=boot(rows,'auroc');
  console.log(name.padEnd(30), `${m.auroc.toFixed(3)} [${ci[0].toFixed(3)}–${ci[1].toFixed(3)}]  ${m.ap.toFixed(3)}  ${m.p20.toFixed(2)}  ${m.p50.toFixed(2)}  ${m.r50.toFixed(3)} ${m.r100.toFixed(3)} ${m.wss95.toFixed(3)} (${m.k95})   ${m.ties}`); }
// decision-level for dec27 criteria at p>0.5 each
for (const f of ['dec27','dec4']) { const R=load(f); const inc=C.filter(d=>['bulk_rnaseq','human_in_vitro','hypoxia_low_o2','normoxia_control'].every(k=>R[d.gse].p[k]>0.5)); const tp=inc.filter(d=>gold.has(d.gse)).length;
  console.log(`\n${f}: include if every criterion p>0.5 → ${inc.length} included, TP ${tp}, precision ${(tp/inc.length).toFixed(3)}, recall ${(tp/44).toFixed(3)} (of 44 retrieved)`);
  const fails={}; for(const d of C.filter(d=>gold.has(d.gse))) for(const k of Object.keys(R[d.gse].p)) if(R[d.gse].p[k]<=0.5) fails[k]=(fails[k]||0)+1; console.log('  gold items failing a criterion:', JSON.stringify(fails)); }
// Ensemble: mean of z-scored decider (criteria+overall) and DeepSeek logprob logit
{ const A=load('dec27'), B=load('ds41'); const fa=d=>Object.values(A[d.gse].p).reduce((a,p)=>a+lg(p),0), fb=d=>logit(B[d.gse].p.overall);
  const z=f=>{const v=C.map(f); const m=v.reduce((a,b)=>a+b)/v.length; const sd=Math.sqrt(v.reduce((a,b)=>a+(b-m)**2,0)/v.length); return Object.fromEntries(C.map((d,i)=>[d.gse,(v[i]-m)/sd]));};
  const za=z(fa), zb=z(fb); const rows=C.map(d=>({gse:d.gse,s:za[d.gse]+zb[d.gse],y:gold.has(d.gse)})); const m=metrics(rows); const ci=boot(rows,'auroc');
  console.log('\nENSEMBLE dec27+ds41'.padEnd(30), `${m.auroc.toFixed(3)} [${ci[0].toFixed(3)}–${ci[1].toFixed(3)}]  ${m.ap.toFixed(3)}  ${m.p20.toFixed(2)}  ${m.p50.toFixed(2)}  ${m.r50.toFixed(3)} ${m.r100.toFixed(3)} ${m.wss95.toFixed(3)} (${m.k95})`); }
