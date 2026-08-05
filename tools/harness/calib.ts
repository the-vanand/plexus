/**
 * СКОЛЬКО РАСХОЖДЕНИЯ ДАЁТ ИЗМЕРИТЕЛЬ СТЕНДА, А НЕ МОДЕЛЬ.
 *
 * `measure-stub.ts` считает ширину глифа по таблице средних для трёх
 * семейств. Для «Lora», «Roboto» или «yahooSans» такой таблицы нет, и
 * ширина уходит на десятки процентов — вместе с числом строк и высотой
 * страницы. В приложении текст меряет Pixi по настоящим метрикам, поэтому
 * ошибка стенда — свойство ПРИБОРА, а не импорта, и путать их нельзя.
 *
 * Множитель подбирается по самому снимку: у абзацев, где браузер сообщил и
 * ширину, и высоту, число строк известно точно (высота / интерлиньяж).
 * Дальше те же метрики считаются дважды — обычным стендом и
 * откалиброванным.
 *
 *   npx tsx tools/harness/calib.ts y2-fowler y2-npr
 */
import {readFileSync} from "node:fs"; import {JSDOM} from "jsdom";
const dom=new JSDOM("<!doctype html><html><body></body></html>"); const g=globalThis as any;
g.DOMParser=dom.window.DOMParser;g.Node=dom.window.Node;g.Element=dom.window.Element;g.document=dom.window.document;g.window=dom.window;
const {importSnapshotToDoc}=await import("../../src/core/importSnapshot");
const {computeLayout}=await import("../../src/core/layout");
const {createStarterDocument}=await import("../../src/core/scene");
const {measureStub}=await import("./measure-stub");
const px=(v?:string)=>{const m=/^(-?[\d.]+)px$/.exec((v??"").trim());return m?parseFloat(m[1]):NaN;};
const stat=(v:number[])=>v.length?Math.round(v.map(Math.abs).reduce((a,b)=>a+b,0)/v.length):0;
for(const name of process.argv.slice(2)){
 const snap=JSON.parse(readFileSync(`fixtures/snapshots/${name}.json`,"utf8")) as any;
 const paras:any[]=[];
 for(const n of snap.nodes){ const t=(n.x??"").trim(); if(t.length<40) continue;
  if((snap.nodes[n.p]?.x??"")!=="") continue;
  const lh=px(n.s["line-height"]),fs=px(n.s["font-size"]); if(!(lh>0)||!(fs>0)) continue;
  const H=n.r[3],W=n.r[2]; if(!(W>40)||!(H>0)) continue;
  const bl=Math.round(H/lh); if(bl<1||Math.abs(H-bl*lh)>2) continue;
  paras.push({t,fs,fw:parseInt(n.s["font-weight"],10)||400,ff:n.s["font-family"]??"",W,bl,lh,ls:px(n.s["letter-spacing"])||0}); }
 let best=1,bestErr=Infinity;
 for(let c=0.6;c<=1.6;c+=0.01){ let e=0; for(const p of paras){const m=measureStub(p.t,p.fs,p.fw,p.ff,p.W*c,{lineHeight:p.lh/p.fs,letterSpacing:p.ls}); e+=Math.abs(Math.round(m.h/p.lh)-p.bl);} if(e<bestErr){bestErr=e;best=c;} }
 const mk=(k:number)=>((t:any,fs:any,fw:any,ff:any,ww:any,ex:any)=>{const m=measureStub(t,fs,fw,ff,ww===undefined?undefined:ww*k,ex);return {w:Math.min(m.w,ww??m.w),h:m.h};}) as any;
 const run=(mf:any)=>{const doc=createStarterDocument();doc.nodes={};doc.rootFrames=[];doc.wires=[];
  const out=importSnapshotToDoc(doc,{snapshot:snap,pageName:name}); const rects=computeLayout(doc,mf);
  const nodes=Object.values(doc.nodes) as any[]; const fx=doc.nodes[out.frameId]!.layout.x, fy=doc.nodes[out.frameId]!.layout.y;
  const byText=new Map<string,number[]>(); snap.nodes.forEach((n:any,i:number)=>{if(!n.x)return;const k=n.x.slice(0,60);const a=byText.get(k);if(a)a.push(i);else byText.set(k,[i]);});
  const dx:number[]=[],dy:number[]=[],dw:number[]=[];
  for(const nd of nodes){ if(!nd.text)continue; const c=byText.get(nd.text.slice(0,60)); if(!c||!c.length)continue; const s=snap.nodes[c.shift()!]; const r=rects.get(nd.id); if(!r)continue;
   dx.push(Math.round(r.x-fx-s.r[0])); dy.push(Math.round(r.y-fy-s.r[1])); dw.push(Math.round(r.w-s.r[2])); }
  const h=Math.round(Math.abs(rects.get(out.frameId)!.h-snap.documentHeight)/snap.documentHeight*1000)/10;
  return `dx ${stat(dx)} · dy ${stat(dy)} · dw ${stat(dw)} · X4 ${Math.round(dx.filter(v=>Math.abs(v)<=4).length/Math.max(1,dx.length)*100)}% · выс ${h}%`;};
 console.log(name.padEnd(11),"k="+best.toFixed(2),"\n   стенд  ",run(measureStub),"\n   калибр ",run(mk(best)));
}
