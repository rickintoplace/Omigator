// Rebuild the hypoxia candidate set exactly as in eval/tasks/hypoxia.json, cache to pilot/candidates.json
import { writeFileSync } from 'node:fs';
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const EU = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const TOOL = '&tool=omigator-pilot';
async function get(url, tries=4){ for(let i=0;;i++){ const r=await fetch(url); if(r.ok) return r.text(); if(i>=tries) throw new Error(`${r.status} ${url}`); await sleep(1500*(i+1)); } }
const term = `hypoxia[Description] AND "expression profiling by high throughput sequencing"[DataSet Type] AND gse[entry type] AND ("1000/01/01"[Publication Date] : "2021/02/11"[Publication Date])`;
const ids = JSON.parse(await get(`${EU}/esearch.fcgi?db=gds&term=${encodeURIComponent(term)}&retmode=json&retmax=400${TOOL}`)).esearchresult.idlist;
console.log('esearch ids', ids.length);
const docs = [];
for (let i=0;i<ids.length;i+=100){ const j=JSON.parse(await get(`${EU}/esummary.fcgi?db=gds&id=${ids.slice(i,i+100).join(',')}&retmode=json${TOOL}`)); for(const id of j.result.uids) docs.push(j.result[id]); await sleep(400); }
let c = docs.map(d=>({gse:d.accession, title:d.title, summary:d.summary, taxon:d.taxon, gdstype:d.gdstype, n:Number(d.n_samples), pdat:d.pdat}));
c = c.filter(d=>d.taxon.toLowerCase().includes('homo sapiens') && d.gdstype.toLowerCase().includes('high throughput sequencing') && d.n>=4 && new Date(d.pdat)<=new Date('2021-02-11'));
console.log('after hard filters', c.length);
for (const [i,d] of c.entries()){
  const soft = await get(`https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=${d.gse}&targ=self&form=text&view=quick`);
  if (/recaptcha|<html/i.test(soft.slice(0,2000))) throw new Error('captcha for '+d.gse);
  d.design = soft.split('\n').filter(l=>l.startsWith('!Series_overall_design =')).map(l=>l.slice(25).trim()).join(' ');
  d.pmid = (soft.match(/!Series_pubmed_id = (\d+)/)||[])[1];
  if(i%25===0) console.log(i, d.gse); await sleep(350);
}
const pmids = [...new Set(c.map(d=>d.pmid).filter(Boolean))];
const abs = {};
for (let i=0;i<pmids.length;i+=150){ const x = await get(`${EU}/efetch.fcgi?db=pubmed&id=${pmids.slice(i,i+150).join(',')}&retmode=xml${TOOL}`);
  for (const art of x.split('<PubmedArticle>').slice(1)){ const p=(art.match(/<PMID[^>]*>(\d+)</)||[])[1]; abs[p]=(art.match(/<AbstractText[^>]*>[\s\S]*?<\/AbstractText>/g)||[]).map(s=>s.replace(/<[^>]+>/g,'')).join(' '); } await sleep(400); }
for (const d of c) d.abstract = d.pmid ? (abs[d.pmid]||'') : '';
writeFileSync('pilot/candidates.json', JSON.stringify(c,null,1));
import { readFileSync } from 'node:fs';
const gold = new Set(readFileSync('/Users/aaron/Documents/omigator/eval/hypoxia_gold.txt','utf8').match(/GSE\d+/g));
console.log('gold in candidates', c.filter(d=>gold.has(d.gse)).length, 'of', gold.size, '| with pmid', c.filter(d=>d.pmid).length);
