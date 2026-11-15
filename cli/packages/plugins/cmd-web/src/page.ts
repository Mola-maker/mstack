/**
 * The control room page: one file, no framework, no network requests other than this server.
 *
 * Look: the molamaker theme from `@mola/plugin-sdk` (pale blue ground, pink for "needs you"), in 2.5D. Depth is
 * information here, not decoration: a run is a slab whose side face shows its state (blue while agents work,
 * pink and raised while it waits for a person, thin once it is over), and the acceptance levels are drawn as
 * the ladder they are.
 *
 * Updates: two custom elements (`mola-run`, `mola-ladder`). A run's element re-renders only when that run's
 * data changed; elapsed times tick through one timer that touches text nodes only.
 *
 * The script below lives inside a template literal: it uses no backticks, no "${", and no backslashes.
 */
import { themeCss } from "@mola/plugin-sdk";

const STYLE = `
*{box-sizing:border-box}
html{font-family:"Zen Maru Gothic","Hiragino Maru Gothic ProN","Yu Gothic UI","Microsoft YaHei UI",var(--m-font-sans);background:var(--m-ground);color:var(--m-ink)}
body{margin:0;min-height:100vh;font-size:15px;line-height:1.6;-webkit-text-size-adjust:100%}
button{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--m-blue-600);outline-offset:2px}
.top{display:flex;align-items:baseline;gap:14px;padding:22px clamp(16px,4vw,40px) 6px}
.top h1{font-size:22px;font-weight:700;letter-spacing:.02em;margin:0}
.top .conn{font-size:13px;color:var(--m-muted)}
.top .conn[data-live="1"]{color:var(--m-ok)}
.top .mode{margin-left:auto;border:1px solid var(--m-line);background:var(--m-surface);border-radius:var(--m-radius-pill);padding:4px 14px;cursor:pointer;font-size:13px}
.desk{display:grid;grid-template-columns:minmax(0,1.9fr) minmax(280px,1fr);gap:clamp(18px,3vw,36px);padding:14px clamp(16px,4vw,40px) 48px;align-items:start}
@media (max-width:860px){.desk{grid-template-columns:1fr}}
h2{font-size:15px;font-weight:700;margin:0 0 12px;color:var(--m-ink-2)}
.runs{display:grid;gap:18px}
.empty{border:1.5px dashed var(--m-line);border-radius:var(--m-radius-md);padding:26px 22px;color:var(--m-ink-2)}
.empty code{font-family:var(--m-font-mono);font-size:13px;background:var(--m-surface-2);padding:2px 8px;border-radius:6px}

/* a run is a slab: the solid offset under it is its side face */
mola-run{display:block;--edge:var(--m-line);--thick:3px;background:var(--m-surface);border:1px solid var(--m-line);border-radius:var(--m-radius-md);
  padding:16px 18px 14px;box-shadow:0 var(--thick) 0 var(--edge),var(--m-lift-1);
  transition:transform var(--m-t-hover) var(--m-ease),box-shadow var(--m-t-hover) var(--m-ease)}
mola-run[data-state="working"]{--edge:var(--m-blue-500);--thick:7px}
mola-run[data-state="needs-you"]{--edge:var(--m-pink-300);--thick:11px;transform:translateY(-4px);border-color:var(--m-pink-300);box-shadow:0 var(--thick) 0 var(--edge),var(--m-lift-3)}
mola-run[data-state="failed"]{--edge:var(--m-pink-500);--thick:5px}
mola-run .task{font-size:17px;font-weight:700;line-height:1.4;margin:0 0 4px;overflow-wrap:anywhere}
mola-run .where{font-size:13px;color:var(--m-muted);overflow-wrap:anywhere}
/* paths in the mono face: Japanese UI fonts draw a backslash as a yen sign */
.path{font-family:var(--m-font-mono);font-size:12px}
mola-run .stages{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0 4px;padding:0;list-style:none}
mola-run .stages li{font-size:12.5px;padding:2px 10px;border-radius:var(--m-radius-pill);background:var(--m-surface-2);color:var(--m-ink-2)}
mola-run .stages li[data-s="running"]{background:var(--m-blue-600);color:#fff}
mola-run .stages li[data-s="done"]{background:transparent;border:1px solid var(--m-line)}
mola-run .stages li[data-s="failed"]{background:var(--m-pink-500);color:#fff}
mola-run .stages li[data-s="skipped"]{opacity:.45;text-decoration:line-through}
mola-run .agents{margin:10px 0 0;padding:0;list-style:none;display:grid;gap:6px}
mola-run .agents li{display:grid;grid-template-columns:auto 1fr auto;gap:4px 10px;align-items:baseline;font-size:13.5px}
mola-run .dot{width:9px;height:9px;border-radius:50%;background:var(--m-line);align-self:center}
mola-run .dot[data-s="working"]{background:var(--m-blue-500);box-shadow:0 0 0 4px var(--m-blue-100)}
mola-run .dot[data-s="blocked"]{background:var(--m-pink-300);box-shadow:0 0 0 4px var(--m-pink-100)}
mola-run .dot[data-s="failed"]{background:var(--m-pink-500)}
mola-run .agents .last{grid-column:2/4;font-family:var(--m-font-mono);font-size:12px;color:var(--m-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
mola-run .num{font-variant-numeric:tabular-nums;color:var(--m-ink-2)}
mola-run .ask{margin:14px -6px 0;padding:12px 14px;border-radius:var(--m-radius-sm);background:var(--m-pink-100);color:#5a2238}
mola-run .ask p{margin:0 0 10px;font-weight:700;overflow-wrap:anywhere}
mola-run .ask p:last-child{margin-bottom:0}
.acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.ask .acts{margin-top:0}
.btn{border:1px solid var(--m-line);background:var(--m-surface);color:var(--m-ink);border-radius:var(--m-radius-pill);padding:6px 18px;cursor:pointer;min-height:36px;
  box-shadow:0 2px 0 var(--m-line);transition:transform var(--m-t-press) var(--m-ease),box-shadow var(--m-t-press) var(--m-ease)}
.btn:hover{transform:translateY(-1px);box-shadow:0 3px 0 var(--m-line)}
.btn:active{transform:translateY(2px);box-shadow:0 0 0 var(--m-line)}
.btn:disabled{opacity:.5;cursor:default;transform:none}
.btn.yes{background:var(--m-blue-600);border-color:var(--m-blue-700);color:#fff;box-shadow:0 2px 0 var(--m-blue-700)}
.btn.no{border-color:var(--m-pink-500);color:#a8325a;background:#fff;box-shadow:0 2px 0 var(--m-pink-300)}

.side{display:grid;gap:26px;background:var(--m-surface);border:1px solid var(--m-line);border-radius:var(--m-radius-lg);padding:22px 20px;box-shadow:var(--m-lift-2)}
.side section + section{border-top:1px solid var(--m-surface-2);padding-top:22px}
.verdict{font-size:16px;font-weight:700;margin:0 0 2px}
.small{font-size:13px;color:var(--m-muted);margin:0;overflow-wrap:anywhere}
#code > div + div{margin-top:18px}
/* the acceptance ladder: six steps, the lowest widest, drawn bottom-up */
mola-ladder{display:grid;gap:6px;margin:14px 0 4px}
mola-ladder .rung{display:flex;align-items:center;gap:10px;height:22px;font-size:12.5px;color:var(--m-muted)}
mola-ladder .bar{height:100%;border-radius:5px;background:var(--m-surface-2);box-shadow:0 3px 0 var(--m-line);flex:none;transition:background var(--m-t-settle) var(--m-ease)}
mola-ladder .rung[data-on="1"] .bar{background:var(--m-blue-500);box-shadow:0 3px 0 var(--m-blue-700)}
mola-ladder .rung[data-need="1"] .bar{outline:2px dashed var(--m-pink-500);outline-offset:2px}
mola-ladder .rung[data-need="1"]{color:var(--m-ink)}
.gaps{margin:0;padding:0;list-style:none;display:grid;gap:10px}
.gaps:not(:empty){margin-top:12px}
.gaps li{padding-left:14px;border-left:3px solid var(--m-pink-300)}
.gaps li[data-ok="0"]{border-left-color:var(--m-pink-500)}
.gaps .id{font-family:var(--m-font-mono);font-size:12.5px;font-weight:700}
.gaps .msg{font-size:13px;color:var(--m-ink-2);overflow-wrap:anywhere;margin:0}
.roles{width:100%;border-collapse:collapse;font-size:13.5px}
.roles th{text-align:left;font-weight:700;padding:6px 10px 6px 0;vertical-align:top;white-space:nowrap}
.roles td{padding:6px 0;vertical-align:top;color:var(--m-ink-2)}
.roles .grp{font-family:var(--m-font-mono);font-size:12px;color:var(--m-muted);display:block}
.tag{font-size:11.5px;font-weight:400;border:1px solid var(--m-pink-300);color:var(--m-ink-2);border-radius:var(--m-radius-pill);padding:0 8px;margin-left:6px;white-space:nowrap}
@media (prefers-reduced-motion:reduce){mola-run,.btn,mola-ladder .bar{transition:none}}
`;

const SCRIPT = `
(function(){
"use strict";
var tk=new URLSearchParams(location.search).get("token");
if(tk){sessionStorage.setItem("mola-token",tk);history.replaceState(null,"",location.pathname)}
var token=sessionStorage.getItem("mola-token")||"";
function q(u){return token?u+(u.indexOf("?")<0?"?":"&")+"token="+encodeURIComponent(token):u}
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
function dur(ms){var s=Math.max(0,Math.round(ms/1000));if(s<60)return s+" 秒";var m=Math.floor(s/60);return m<60?m+" 分钟":Math.floor(m/60)+" 小时 "+(m%60)+" 分"}
function ago(at){if(!at)return"";var m=Math.max(0,Math.round((Date.now()-at)/60000));return m<1?"刚刚":m<60?m+" 分钟前":m<2880?Math.round(m/60)+" 小时前":Math.round(m/1440)+" 天前"}
var STAGE={queued:"排队",running:"进行中",done:"完成",failed:"失败",skipped:"跳过"};
var AGENT={working:"在干活",blocked:"等你",done:"做完了",failed:"失败了",idle:"空闲"};
function stateOf(p){
  if(p.status==="blocked")return"needs-you";
  if(p.status==="running")return"working";
  if(p.status==="failed"||p.status==="stopped")return"failed";
  return"over";
}

// ---- <mola-run>: one run. Re-renders only when its own data changed.
function MolaRun(){return Reflect.construct(HTMLElement,[],MolaRun)}
MolaRun.prototype=Object.create(HTMLElement.prototype);
Object.defineProperty(MolaRun.prototype,"run",{set:function(p){
  var sig=p.updatedAt+"|"+p.status+"|"+((p.approval&&p.approval.status)||"");
  this._p=p;
  if(sig===this._sig)return;
  this._sig=sig;
  this.dataset.state=stateOf(p);
  var live=p.status==="running"||p.status==="blocked";
  var h='<p class="task">'+esc(p.intent)+'</p><div class="where path">'+esc(p.cwd)+'</div><ol class="stages">';
  p.stages.forEach(function(s){h+='<li data-s="'+esc(s.status)+'" title="'+esc(STAGE[s.status]||s.status)+'">'+esc(s.name)+"</li>"});
  h+='</ol><div class="where"><span class="num" data-since="'+esc(p.startedAt)+'" data-until="'+(live?"":esc(p.updatedAt))+'"></span>，花费 <span class="num">$'+Number(p.costUsd||0).toFixed(2)+"</span></div>";
  if(p.workers&&p.workers.length){
    h+='<ul class="agents">';
    p.workers.forEach(function(w){
      var on=w.status==="working"||w.status==="blocked";
      h+='<li><span class="dot" data-s="'+esc(w.status)+'"></span><span>'+esc(AGENT[w.status]||w.status)+"，"+esc(w.stage)+"，"+esc(w.model||"默认模型")+"</span>"
        +'<span class="num">'+(w.startedAt?'<span data-since="'+esc(w.startedAt)+'" data-until="'+(on?"":esc(w.updatedAt||w.startedAt))+'"></span>':"")+"</span>"
        +(w.lastLine?'<span class="last">'+esc(w.lastLine)+"</span>":"")+"</li>";
    });
    h+="</ul>";
  }
  if(p.status==="blocked"&&p.approval&&p.approval.status==="pending"){
    h+='<div class="ask"><p>要你点头：'+esc(p.approval.action)+'</p><div class="acts"><button class="btn yes" data-a="approve">批准</button><button class="btn no" data-a="deny">拒绝</button><button class="btn" data-a="stop">停止任务</button></div></div>';
  }else if(live){
    h+=(p.blocked&&p.blocked.reason?'<div class="ask"><p>卡住了：'+esc(p.blocked.reason)+"</p></div>":"")+'<div class="acts"><button class="btn" data-a="stop">停止任务</button></div>';
  }else if(p.next){
    h+='<div class="where" style="margin-top:10px">'+esc(p.next)+"</div>";
  }
  this.innerHTML=h;
  tickIn(this);
}});
MolaRun.prototype.connectedCallback=function(){
  var self=this;
  if(this._wired)return;this._wired=true;
  this.addEventListener("click",function(e){
    var b=e.target.closest("button[data-a]");if(!b)return;
    var p=self._p,a=b.getAttribute("data-a");
    if(a==="stop"&&!confirm("停止这个任务？"))return;
    b.disabled=true;
    var path=a==="stop"?"/api/runs/"+encodeURIComponent(p.id)+"/stop":"/api/runs/"+encodeURIComponent(p.id)+"/approvals/"+encodeURIComponent(p.blocked.approvalId);
    fetch(q(path)+(path.indexOf("?")<0?"?":"&")+"cwd="+encodeURIComponent(p.cwd),{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(a==="stop"?{}:{decision:a})})
      .then(function(r){if(!r.ok)alert("没成功（"+r.status+"）")}).catch(function(){alert("连不上控制台服务")}).then(function(){b.disabled=false});
  });
};
customElements.define("mola-run",MolaRun);

// ---- <mola-ladder>: the acceptance levels as steps. found = highest level proven, need = level the project requires.
var LEVELS=["L0 能解析","L1 能构建","L2 单元测试","L3 装上并启动","L4 走通行为","L5 性能与体积"];
function MolaLadder(){return Reflect.construct(HTMLElement,[],MolaLadder)}
MolaLadder.prototype=Object.create(HTMLElement.prototype);
Object.defineProperty(MolaLadder.prototype,"levels",{set:function(v){
  var sig=v.found+"|"+v.need;if(sig===this._sig)return;this._sig=sig;
  var h="";
  for(var i=5;i>=0;i--){
    h+='<div class="rung" data-on="'+(i<=v.found?1:0)+'" data-need="'+(i===v.need?1:0)+'"><span class="bar" style="width:'+(54-i*5)+'%"></span><span>'+LEVELS[i]+(i===v.need?"（要求）":"")+"</span></div>";
  }
  this.innerHTML=h;
}});
customElements.define("mola-ladder",MolaLadder);

// one timer for every elapsed time on the page: text nodes only
function tickIn(root){
  var nodes=root.querySelectorAll("[data-since]");
  for(var i=0;i<nodes.length;i++){
    var n=nodes[i],from=Date.parse(n.getAttribute("data-since")),to=n.getAttribute("data-until");
    var t="已用 "+dur((to?Date.parse(to):Date.now())-from);
    if(n.textContent!==t)n.textContent=t;
  }
}
setInterval(function(){tickIn(document)},1000);

var runsEl=document.getElementById("runs"),conn=document.getElementById("conn"),els={},runs={};
function order(){
  var rank={"needs-you":0,working:1,failed:2,over:3};
  var keys=Object.keys(runs).sort(function(a,b){
    var x=runs[a],y=runs[b],d=rank[stateOf(x)]-rank[stateOf(y)];
    return d!==0?d:(y.updatedAt<x.updatedAt?-1:1);
  });
  document.getElementById("none").hidden=keys.length>0;
  keys.forEach(function(k,i){if(runsEl.children[i]!==els[k])runsEl.insertBefore(els[k],runsEl.children[i]||null)});
  var need=keys.filter(function(k){return stateOf(runs[k])==="needs-you"}).length;
  document.title=(need?"("+need+") ":"")+"mola 控制台";
}
function onRun(p){
  var k=p.cwd+"|"+p.id;
  runs[k]=p;
  if(!els[k]){els[k]=document.createElement("mola-run")}
  els[k].run=p;
  order();
}

var ROLE={think:"思考",build:"实现",operate:"操作",bulk:"批量"};
function onEnv(e){
  var box=document.getElementById("code");
  var withVerdict=e.projects.filter(function(p){return p.verify});
  if(!withVerdict.length){
    box.innerHTML='<p class="small">这些目录还没有验收记录。在项目里建一个 .mstack/verify/gate 文件，之后每次停下都会记一次。</p>';
  }else{
    box.innerHTML="";
    withVerdict.forEach(function(p){
      var v=p.verify,need=v.required?Number(v.required.slice(1)):-1;
      var found=v.ok===true?Math.max(need,0):(v.found&&v.found.charAt(0)==="L"?Number(v.found.slice(1)):-1);
      var line=v.ok===true?"当前代码已验收"+(v.required?"到 "+v.required:""):v.ok===false?(found>=0?"只验到 L"+found:"还没有回执")+(v.required?"，要求 "+v.required:""):"上次没能完成检查";
      var d=document.createElement("div");
      d.innerHTML='<p class="verdict">'+esc(line)+'</p><p class="small"><span class="path">'+esc(v.root)+"</span>　上次停下时的结论"+(v.at?"，"+ago(v.at):"")+"。</p>";
      if(need>=0||found>=0){var l=document.createElement("mola-ladder");l.levels={found:found,need:need};d.appendChild(l)}
      box.appendChild(d);
    });
  }
  var gaps=document.getElementById("gaps"),when=document.getElementById("gapwhen");
  if(!e.doctor){gaps.innerHTML="";when.textContent="还没体检过。"}
  else{
    when.textContent=(e.doctor.gaps.length?"上次体检发现 "+e.doctor.gaps.length+" 处":"上次体检一切正常")+(e.doctor.at?"，"+ago(e.doctor.at):"")+"。";
    gaps.innerHTML=e.doctor.gaps.map(function(g){return'<li data-ok="'+(g.ok?1:0)+'"><span class="id">'+esc(g.id)+'</span><p class="msg">'+esc(g.message)+"</p></li>"}).join("");
  }
  document.getElementById("roles").innerHTML=e.roles.map(function(r){
    return"<tr><th>"+esc(ROLE[r.role]||r.role)+(r.unverified?'<span class="tag">未实测</span>':"")+"</th><td>"+esc(r.kinds.join("、"))+'<span class="grp">'+esc(r.group)+"</span></td></tr>";
  }).join("")||'<tr><td class="small">没找到路由表。</td></tr>';
}
document.getElementById("recheck").addEventListener("click",function(){
  var b=this;b.disabled=true;b.textContent="体检中…";
  fetch(q("/api/doctor"),{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})
    .then(function(r){return r.ok?r.json().then(onEnv):alert(r.status===501?"这个控制台不能发起体检，请在终端运行 mola doctor":"体检没成功（"+r.status+"）")})
    .catch(function(){alert("连不上控制台服务")}).then(function(){b.disabled=false;b.textContent="重新体检"});
});
var mode=document.getElementById("mode");
function setMode(m){document.documentElement.setAttribute("data-theme",m);mode.textContent=m==="night"?"换成日间":"换成夜间";try{localStorage.setItem("mola-theme",m)}catch(e){}}
mode.addEventListener("click",function(){setMode(document.documentElement.getAttribute("data-theme")==="night"?"day":"night")});
try{var saved=localStorage.getItem("mola-theme");setMode(saved||(matchMedia("(prefers-color-scheme: dark)").matches?"night":"day"))}catch(e){setMode("day")}

function connect(){
  var es=new EventSource(q("/api/stream"));
  es.onopen=function(){conn.textContent="已连接";conn.dataset.live="1"};
  es.addEventListener("run",function(ev){onRun(JSON.parse(ev.data))});
  es.addEventListener("env",function(ev){onEnv(JSON.parse(ev.data))});
  es.onerror=function(){conn.textContent="重新连接中…";conn.dataset.live="0";if(es.readyState===2){es.close();setTimeout(connect,2000)}};
}
connect();
})();
`;

/** The whole page. Built once at load: the theme's CSS variables, the page's own styles, the markup and the script. */
export function pageHtml(): string {
  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    "<title>mola 控制台</title>",
    '<link rel="icon" href="data:,">',
    `<style>${themeCss()}${STYLE}</style></head><body>`,
    '<header class="top"><h1>mola 控制台</h1><span class="conn" id="conn">连接中…</span><button class="mode" id="mode" type="button">换成夜间</button></header>',
    '<main class="desk"><div>',
    "<h2>正在干活的 agent</h2>",
    '<div class="empty" id="none">现在没有任务在跑。在终端里运行 <code>mola go "要做的事"</code> 开一个，它会出现在这里。</div>',
    '<div class="runs" id="runs"></div></div>',
    '<aside class="side">',
    '<section><h2>这份代码</h2><div id="code"><p class="small">读取中…</p></div></section>',
    '<section><h2>环境缺口</h2><p class="small" id="gapwhen"></p><ul class="gaps" id="gaps"></ul><div class="acts"><button class="btn" id="recheck" type="button">重新体检</button></div></section>',
    '<section><h2>角色分工</h2><table class="roles"><tbody id="roles"></tbody></table></section>',
    "</aside></main>",
    `<script>${SCRIPT}</script></body></html>`,
  ].join("\n");
}

export const PAGE_HTML = pageHtml();
