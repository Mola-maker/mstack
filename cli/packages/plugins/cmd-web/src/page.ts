/** The single inline page for `mola web`: no build step, no CDN, no framework. */
export const PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>mola web</title>
<style>
:root{--bg:#f6f7f9;--fg:#15181d;--card:#fff;--mut:#667085;--bd:#dde1e7;--ok:#1a9d55;--warn:#d98a00;--bad:#d92d20;--acc:#2563eb}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e6e8eb;--card:#181b21;--mut:#98a2b3;--bd:#2a2f38;--ok:#3ccf7c;--warn:#f5b73d;--bad:#ff6b5e;--acc:#6ea0ff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.4 system-ui,-apple-system,Segoe UI,sans-serif}
header{padding:12px 14px;display:flex;justify-content:space-between;align-items:center;font-weight:600}
#conn{font-size:12px;color:var(--mut);font-weight:400}
main{padding:0 10px 24px;display:grid;gap:10px;max-width:900px;margin:0 auto}
.card{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:12px;overflow:hidden}
.intent{font-weight:600;word-break:break-word}
.line{font:12px ui-monospace,Menlo,Consolas,monospace;color:var(--mut);margin:4px 0;word-break:break-word}
.meta{font-size:12px;color:var(--mut)}
.chips{display:flex;flex-wrap:wrap;gap:4px;margin:8px 0}
.chip{font-size:11px;padding:2px 7px;border-radius:99px;border:1px solid var(--bd);color:var(--mut)}
.chip.running{color:var(--acc);border-color:var(--acc)}.chip.done{color:var(--ok);border-color:var(--ok)}
.chip.failed{color:var(--bad);border-color:var(--bad)}.chip.blocked{color:var(--warn);border-color:var(--warn)}
.w{display:grid;grid-template-columns:12px 1fr auto;gap:2px 8px;padding:6px 0;border-top:1px solid var(--bd);align-items:center}
.dot{width:10px;height:10px;border-radius:50%;background:var(--mut)}
.dot.working{background:var(--acc)}.dot.blocked{background:var(--warn)}.dot.done{background:var(--ok)}.dot.failed{background:var(--bad)}
.w .n{font-size:13px;word-break:break-word}.w .c{font-size:12px;color:var(--mut);text-align:right}
.w .l{grid-column:2/4;font:11px ui-monospace,Menlo,Consolas,monospace;color:var(--mut);word-break:break-word}
.appr{margin-top:10px;padding:10px;border:1px solid var(--warn);border-radius:8px}
.appr b{display:block;margin-bottom:8px;word-break:break-word}
.btns{display:flex;gap:8px;flex-wrap:wrap}
button{flex:1;min-width:96px;font:inherit;font-weight:600;padding:12px 10px;border-radius:8px;border:1px solid var(--bd);background:var(--card);color:var(--fg);cursor:pointer}
button.go{background:var(--ok);border-color:var(--ok);color:#fff}button.no{background:var(--bad);border-color:var(--bad);color:#fff}
button:disabled{opacity:.5}
.empty{text-align:center;color:var(--mut);padding:30px}
</style></head><body>
<header><span>mola web</span><span id="conn">connecting…</span></header>
<main id="runs"><div class="empty">No runs yet.</div></main>
<script>
(function(){
var qs=new URLSearchParams(location.search),tk=qs.get("token");
if(tk){sessionStorage.setItem("mola-token",tk);history.replaceState(null,"",location.pathname)}
var token=sessionStorage.getItem("mola-token")||"";
var runs={},es,root=document.getElementById("runs"),conn=document.getElementById("conn");
function q(u){return token?u+(u.indexOf("?")<0?"?":"&")+"token="+encodeURIComponent(token):u}
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
function dur(ms){var s=Math.max(0,Math.round(ms/1000));if(s<60)return s+"s";var m=Math.floor(s/60);return m<60?m+"m":Math.floor(m/60)+"h"+(m%60)+"m"}
function line(p){
  var act=p.stages.filter(function(s){return s.status!=="skipped"}),i=0;
  act.forEach(function(s,k){if(s.name===p.stage)i=k});
  var w=p.workers.filter(function(x){return x.status==="working"}).length;
  var mins=Math.max(0,Math.round((Date.now()-Date.parse(p.startedAt))/60000));
  var h=p.status==="blocked"?"go ⏸ "+p.stage+": "+((p.blocked&&p.blocked.reason)||"waiting"):"go ▸ "+p.stage+" ("+(i+1)+"/"+act.length+")";
  return [h,w+" agent"+(w===1?"":"s"),"$"+p.costUsd.toFixed(2),mins+"m"].join(" · ");
}
function card(p){
  var end=p.status==="running"||p.status==="blocked"?Date.now():Date.parse(p.updatedAt);
  var h='<div class="card"><div class="intent">'+esc(p.intent)+'</div><div class="line">'+esc(line(p))+'</div>'
   +'<div class="meta">'+esc(p.status)+" · $"+p.costUsd.toFixed(2)+" · "+dur(end-Date.parse(p.startedAt))+" · "+esc(p.id)+'</div><div class="chips">';
  p.stages.forEach(function(s){h+='<span class="chip '+esc(s.status)+'">'+esc(s.name)+"</span>"});
  h+="</div>";
  p.workers.forEach(function(w){
    var e=w.startedAt?dur((w.status==="working"||w.status==="blocked"?Date.now():Date.parse(w.updatedAt||w.startedAt))-Date.parse(w.startedAt)):"";
    h+='<div class="w"><span class="dot '+esc(w.status)+'"></span><span class="n">'+esc(w.status)+" · "+esc(w.stage)+" · "+esc(w.model||"-")+'</span><span class="c">'+e+" · $"+(w.costUsd||0).toFixed(2)+"</span>"
     +(w.lastLine?'<span class="l">'+esc(w.lastLine)+"</span>":"")+"</div>";
  });
  var k=esc(p.cwd)+"|"+esc(p.id);
  if(p.status==="blocked"&&p.approval&&p.approval.status==="pending"){
    h+='<div class="appr"><b>'+esc(p.approval.action)+'</b><div class="btns"><button class="go" data-k="'+k+'" data-a="approve">Approve</button><button class="no" data-k="'+k+'" data-a="deny">Deny</button><button data-k="'+k+'" data-a="stop">Stop</button></div></div>';
  }else if(p.status==="running"||p.status==="blocked"){
    h+='<div class="btns" style="margin-top:8px"><button data-k="'+k+'" data-a="stop">Stop</button></div>';
  }
  return h+"</div>";
}
function render(){
  var a=Object.keys(runs).map(function(k){return runs[k]}).sort(function(x,y){return y.updatedAt<x.updatedAt?-1:1});
  root.innerHTML=a.length?a.map(card).join(""):'<div class="empty">No runs yet.</div>';
}
function post(path,body){
  return fetch(q(path)+(path.indexOf("?")<0?"?":"&")+"cwd="+encodeURIComponent(body.cwd),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body.json)});
}
root.addEventListener("click",function(e){
  var b=e.target.closest("button");if(!b)return;
  var k=b.getAttribute("data-k").split("|"),cwd=k[0],id=k[1],a=b.getAttribute("data-a"),p=runs[cwd+"|"+id];
  if(a==="stop"&&!confirm("Stop this run?"))return;
  b.disabled=true;
  var path=a==="stop"?"/api/runs/"+id+"/stop":"/api/runs/"+id+"/approvals/"+encodeURIComponent(p.blocked.approvalId)+"";
  post(path,{cwd:cwd,json:a==="stop"?{}:{decision:a}}).then(function(r){if(!r.ok)alert("failed: "+r.status)}).catch(function(){}).then(function(){b.disabled=false});
});
function connect(){
  es=new EventSource(q("/api/stream"));
  es.onopen=function(){conn.textContent="live"};
  es.addEventListener("run",function(ev){var p=JSON.parse(ev.data);runs[p.cwd+"|"+p.id]=p;render()});
  es.onerror=function(){conn.textContent="reconnecting…";if(es.readyState===2){es.close();setTimeout(connect,2000)}};
}
setInterval(render,15000);
connect();
})();
</script></body></html>`;
