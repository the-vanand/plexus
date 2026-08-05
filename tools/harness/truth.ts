/**
 * ЦИФРА ПРИБОРА ПРОТИВ ИСТИНЫ ПО ТРАССЕ.
 *
 * Прибор сопоставляет узел сцены с узлом снимка по первым 60 знакам текста
 * и очередью FIFO. На страницах с подсвеченным кодом и повторяющимися
 * подписями это ошибается на 8–21% пар, и в dx/dy/dw попадают расстояния
 * между РАЗНЫМИ узлами. Трасса импорта знает настоящее соответствие.
 *
 * Стенд печатает обе величины рядом: гнаться нужно за второй.
 *
 *   npx tsx tools/harness/truth.ts y2-django y2-npr
 */
import {readFileSync} from "node:fs"; import {JSDOM} from "jsdom";
const dom=new JSDOM("<!doctype html><html><body></body></html>"); const g=globalThis as any;
g.DOMParser=dom.window.DOMParser;g.Node=dom.window.Node;g.Element=dom.window.Element;g.document=dom.window.document;g.window=dom.window;
const {importSnapshotToDoc}=await import("../../src/core/importSnapshot");
const {computeLayout}=await import("../../src/core/layout");
const {createStarterDocument}=await import("../../src/core/scene");
const {measureStub}=await import("./measure-stub");
const stat=(v:number[])=>v.length?Math.round(v.map(Math.abs).reduce((a,b)=>a+b,0)/v.length):0;
for(const name of process.argv.slice(2)){
 const snap=JSON.parse(readFileSync(`fixtures/snapshots/${name}.json`,"utf8")) as any;
 const doc=createStarterDocument();doc.nodes={};doc.rootFrames=[];doc.wires=[];
 const out=importSnapshotToDoc(doc,{snapshot:snap,pageName:name,trace:true});
 const rects=computeLayout(doc,measureStub);
 const fx=doc.nodes[out.frameId]!.layout.x, fy=doc.nodes[out.frameId]!.layout.y;
 const nodes=Object.values(doc.nodes) as any[];
 const byText=new Map<string,number[]>(); snap.nodes.forEach((n:any,i:number)=>{if(!n.x)return;const k=n.x.slice(0,60);const a=byText.get(k);if(a)a.push(i);else byText.set(k,[i]);});
 const dxT:number[]=[],dyT:number[]=[],dwT:number[]=[]; let wrong=0,pairs=0;
 for(const nd of nodes){ if(!nd.text)continue; const c=byText.get(nd.text.slice(0,60)); if(!c||!c.length)continue; const si=c.shift()!; const r=rects.get(nd.id); if(!r)continue;
  pairs++; const tr=out.trace!.get(nd.id); if(tr!==undefined&&tr!==si) wrong++;
  const s=snap.nodes[si]; dxT.push(Math.round(r.x-fx-s.r[0])); dyT.push(Math.round(r.y-fy-s.r[1])); dwT.push(Math.round(r.w-s.r[2])); }
 const dxR:number[]=[],dyR:number[]=[],dwR:number[]=[];
 for(const [id,si] of out.trace!){ const nd=(doc.nodes as any)[id]; if(!nd||!nd.text)continue; const r=rects.get(id); if(!r)continue; const s=snap.nodes[si];
  dxR.push(Math.round(r.x-fx-s.r[0])); dyR.push(Math.round(r.y-fy-s.r[1])); dwR.push(Math.round(r.w-s.r[2])); }
 console.log(name.padEnd(11),`пар ${pairs}, из них сопоставлено НЕ с тем узлом ${wrong} (${Math.round(wrong/Math.max(1,pairs)*100)}%)`);
 console.log("   по тексту (прибор) dx",stat(dxT),"dy",stat(dyT),"dw",stat(dwT),"X4",Math.round(dxT.filter(v=>Math.abs(v)<=4).length/Math.max(1,dxT.length)*100)+"%");
 console.log("   по трассе (истина) dx",stat(dxR),"dy",stat(dyR),"dw",stat(dwR),"X4",Math.round(dxR.filter(v=>Math.abs(v)<=4).length/Math.max(1,dxR.length)*100)+"%","узлов",dxR.length);
}
