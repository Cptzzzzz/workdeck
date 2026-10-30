import React, {useCallback, useEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Terminal as XTerminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import {ArrowDownToLine, ArrowLeft, ArrowRight, Check, ChevronDown, Circle, Command, Copy, ExternalLink, Folder, KeyRound, LayoutGrid, LogOut, Maximize2, Menu, Monitor, MoreHorizontal, Plus, Radio, RefreshCw, Search, Server, Settings2, ShieldCheck, TerminalSquare, Trash2, X} from 'lucide-react';
import '@xterm/xterm/css/xterm.css';
import './style.css';

type Node={id:string;name:string;online:boolean;hostname:string;home:string;platform:string;last_seen:string;shell:string};
type Term={id:string;node_id:string;name:string;cwd:string;state:string;desired_state:string;created_at:string;updated_at:string;error:string;viewers:number;exit_code:number|null};
type Snapshot={nodes:Node[];terminals:Term[]};
type User={username:string;csrf:string};
type Modal='create'|'join'|'password'|null;
let csrf='';
async function api<T=any>(path:string,options:RequestInit={}):Promise<T>{
 const res=await fetch('/api'+path,{...options,headers:{'Content-Type':'application/json','X-Workdeck-CSRF':csrf,...options.headers},credentials:'same-origin'});
 const body=await res.json().catch(()=>({error:'服务暂时不可用'}));
 if(!res.ok){if(res.status===401)window.dispatchEvent(new Event('workdeck:unauthorized'));throw new Error(body.error||'请求失败')};return body;
}
function timeAgo(raw:string){if(!raw)return '尚未连接';const m=Math.max(0,Math.floor((Date.now()-new Date(raw).getTime())/60000));if(m<1)return '刚刚';if(m<60)return `${m} 分钟前`;if(m<1440)return `${Math.floor(m/60)} 小时前`;return `${Math.floor(m/1440)} 天前`;}
function status(t:Term,node?:Node){if(t.desired_state==='closed'&&t.state!=='closed')return {text:'等待终止',kind:'pending'};if(t.state==='closed')return{text:'已终止',kind:'muted'};if(!node?.online)return{text:'节点离线',kind:'muted'};const states:Record<string,{text:string;kind:string}>={running:{text:'运行中',kind:'live'},creating:{text:'创建中',kind:'pending'},exited:{text:'已退出',kind:'muted'},lost:{text:'会话丢失',kind:'error'},error:{text:'启动失败',kind:'error'}};return states[t.state]||{text:t.state,kind:'muted'};}
function App(){
 const[user,setUser]=useState<User|null>(null),[loading,setLoading]=useState(true);
 const[data,setData]=useState<Snapshot>({nodes:[],terminals:[]});
 const[filter,setFilter]=useState('all'),[query,setQuery]=useState(''),[showEnded,setShowEnded]=useState(false);
 const[modal,setModal]=useState<Modal>(null),[active,setActive]=useState<string|null>(null),[tabs,setTabs]=useState<string[]>([]);
 const[menu,setMenu]=useState(false),[toast,setToast]=useState(''),[refreshError,setRefreshError]=useState('');
 const notify=useCallback((s:string)=>setToast(s),[]);
 const refresh=useCallback(async()=>{try{setData(await api<Snapshot>('/state'));setRefreshError('')}catch(e){setRefreshError((e as Error).message)}},[]);
 useEffect(()=>{api<User>('/me').then(u=>{csrf=u.csrf;setUser(u)}).catch(()=>{}).finally(()=>setLoading(false));const fn=()=>{csrf='';setUser(null);setTabs([]);setActive(null)};window.addEventListener('workdeck:unauthorized',fn);return()=>window.removeEventListener('workdeck:unauthorized',fn)},[]);
 useEffect(()=>{if(!user)return;void refresh();const t=setInterval(refresh,5000);return()=>clearInterval(t)},[user,refresh]);
 useEffect(()=>{if(!toast)return;const t=setTimeout(()=>setToast(''),5000);return()=>clearTimeout(t)},[toast]);
 const open=(id:string)=>{setTabs(a=>a.includes(id)?a:[...a,id]);setActive(id);setMenu(false)};
 const closeTab=(id:string)=>{const next=tabs.filter(t=>t!==id);setTabs(next);if(active===id)setActive(next.at(-1)||null)};
 const stop=async(t:Term)=>{if(!confirm(`终止「${t.name}」？该终端及其后台任务将被结束。${!data.nodes.find(n=>n.id===t.node_id)?.online?'节点离线，指令将在节点重新上线后执行。':''}`))return;try{await api('/terminals/'+t.id,{method:'DELETE'});closeTab(t.id);await refresh();notify('终止请求已保存')}catch(e){notify((e as Error).message)}};
 const rename=async(t:Term)=>{const name=prompt('终端名称',t.name);if(!name||name===t.name)return;try{await api('/terminals/'+t.id,{method:'PATCH',body:JSON.stringify({name})});await refresh()}catch(e){notify((e as Error).message)}};
 const revoke=async(n:Node)=>{if(!confirm(`撤销节点「${n.name}」的接入身份？已有任务仍会留在节点上，但将无法通过此平台连接。`))return;try{await api('/nodes/'+n.id,{method:'DELETE'});setFilter('all');await refresh();notify('节点接入身份已撤销')}catch(e){notify((e as Error).message)}};
 if(loading)return <div className="boot"><Brand/><span>正在连接工作台…</span></div>;
 if(!user)return <Login onLogin={u=>{csrf=u.csrf;setUser(u)}}/>;
 const selected=data.nodes.find(n=>n.id===filter);
 const current=data.terminals.find(t=>t.id===active);
 const online=data.nodes.filter(n=>n.online).length;
 const live=data.terminals.filter(t=>t.state==='running'&&t.desired_state!=='closed');
 const visible=data.terminals.filter(t=>(filter==='all'||t.node_id===filter)&&(showEnded||!['closed','lost','error'].includes(t.state))&&(t.name+' '+t.cwd+' '+(data.nodes.find(n=>n.id===t.node_id)?.name||'')).toLowerCase().includes(query.toLowerCase()));
 return <div className="app">
  {menu&&<div className="scrim" onClick={()=>setMenu(false)}/>}
  <aside className={'sidebar '+(menu?'shown':'')}>
   <Brand/><div className="workspace-label">PERSONAL WORKSPACE</div>
   <button className={'nav-item '+(filter==='all'?'selected':'')} onClick={()=>{setFilter('all');setActive(null);setMenu(false)}}><LayoutGrid size={18}/>全部终端<span className="count">{live.length}</span></button>
   <div className="nav-section"><span>计算节点</span><button title="接入节点" aria-label="接入节点" onClick={()=>setModal('join')}><Plus size={16}/></button></div>
   <div className="node-list">{data.nodes.map(n=><button key={n.id} className={'nav-item node-item '+(filter===n.id?'selected':'')} onClick={()=>{setFilter(n.id);setActive(null);setMenu(false)}}><Server size={17}/><span className="node-name">{n.name}<small>{n.platform||'等待首次连接'}</small></span><i className={'dot '+(n.online?'online':'')}/></button>)}{!data.nodes.length&&<div className="sidebar-empty">接入第一台机器，<br/>随时回到你的工作现场。</div>}</div>
   <button className="add-node" onClick={()=>setModal('join')}><Plus size={16}/>接入新节点</button>
   <div className="sidebar-bottom"><div className="secure-note"><ShieldCheck size={16}/><span>加密连接 · 会话独立运行</span></div><div className="profile"><div className="avatar">{user.username[0]?.toUpperCase()}</div><div><b>{user.username}</b><small>个人工作台</small></div><button title="修改密码" aria-label="修改密码" onClick={()=>setModal('password')}><Settings2 size={17}/></button><button title="退出登录" aria-label="退出登录" onClick={async()=>{try{await api('/logout',{method:'POST'});setUser(null);setTabs([]);setActive(null)}catch(e){notify((e as Error).message)}}}><LogOut size={17}/></button></div></div>
  </aside>
  <main>
   <header className="topbar"><button className="mobile-menu icon-button" aria-label="打开导航" onClick={()=>setMenu(true)}><Menu size={21}/></button><div className="breadcrumb"><span>工作空间</span><span>/</span><b>{active?'终端':selected?.name||'全部终端'}</b></div><div className="topbar-right"><span className="connection-status"><i className={'dot '+(!refreshError?'online':'')}/>{refreshError?'连接中断':'工作台已连接'}</span><button className="icon-button" title="刷新状态" aria-label="刷新状态" onClick={()=>void refresh()}><RefreshCw size={16}/></button></div></header>
   {tabs.length>0&&<div className="tab-strip"><button className={'overview-tab '+(!active?'active':'')} onClick={()=>setActive(null)}><LayoutGrid size={15}/>概览</button>{tabs.map(id=>{const t=data.terminals.find(t=>t.id===id);return <div key={id} className={'terminal-tab '+(active===id?'active':'')}><button onClick={()=>setActive(id)}><TerminalSquare size={15}/><span>{t?.name||'终端'}</span></button><button title="断开此标签页，任务继续运行" aria-label="关闭标签页" onClick={()=>closeTab(id)}><X size={13}/></button></div>})}<button className="new-tab" title="新建终端" onClick={()=>setModal('create')}><Plus size={17}/></button></div>}
   {refreshError&&<div className="global-error">无法刷新状态：{refreshError}。任务在节点上独立运行，正在重试连接。</div>}
   <div className={'overview '+(active?'hidden':'')}>
    <div className="page-heading"><div><div className="eyebrow">YOUR WORK, ALWAYS THERE</div><h1>{selected?selected.name:'你的远程工作台'}<span className="heading-dot">.</span></h1><p>连接任意机器，接着上次的工作继续。</p></div><button className="primary" onClick={()=>setModal('create')} disabled={!online}><Plus size={17}/>新建终端</button></div>
    <div className="stats"><div className="stat"><span><Server size={16}/>在线节点</span><div>{online}<small>/ {data.nodes.length}</small></div></div><div className="stat"><span><TerminalSquare size={16}/>运行中的终端</span><div>{live.length}<small>个会话</small></div></div><div className="stat stat-note"><span><Radio size={16}/>随时离开，随时回来</span><p>关闭浏览器后，任务仍在原机器上运行。</p></div></div>
    {selected&&<div className="node-detail"><span><i className={'dot '+(selected.online?'online':'')}/>{selected.online?'在线':'离线 · 最后连接 '+timeAgo(selected.last_seen)}</span><span>{selected.hostname}</span><span>{selected.platform}</span><button onClick={()=>void revoke(selected)}>撤销接入</button></div>}
    <div className="list-toolbar"><div className="section-label">终端会话 <span>{visible.length}</span></div><div className="list-controls"><label className="search"><Search size={15}/><input aria-label="搜索终端" value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索终端或目录"/></label><label className="checkbox"><input type="checkbox" checked={showEnded} onChange={e=>setShowEnded(e.target.checked)}/>显示已结束</label></div></div>
    {visible.length?<div className="terminal-grid">{visible.map(t=>{const n=data.nodes.find(n=>n.id===t.node_id);const s=status(t,n);const attachable=n?.online&&['running','exited'].includes(t.state)&&t.desired_state!=='closed';return <article className="terminal-card" key={t.id}><div className="card-top"><span className="terminal-icon"><TerminalSquare size={21}/></span><span className={'badge '+s.kind}><i/>{s.text}</span><details className="card-menu"><summary aria-label="终端操作"><MoreHorizontal size={19}/></summary><div><button onClick={()=>void rename(t)}>重命名</button>{t.desired_state!=='closed'&&<button className="danger-text" onClick={()=>void stop(t)}>终止终端</button>}</div></details></div><h3><button onClick={()=>attachable&&open(t.id)}>{t.name}</button></h3><div className="card-node"><Server size={13}/>{n?.name||'已撤销节点'}</div><div className="card-path"><Folder size={14}/><span title={t.cwd}>{n?.home&&t.cwd.startsWith(n.home)?'~'+t.cwd.slice(n.home.length):t.cwd}</span></div>{t.error&&<p className="card-error">{t.error}</p>}<div className="card-footer"><span>{t.viewers?`${t.viewers} 个连接`:'创建于 '+timeAgo(t.created_at)}</span><button disabled={!attachable} onClick={()=>open(t.id)}>{t.state==='exited'?'查看终端':'进入终端'}<ArrowRight size={15}/></button></div></article>})}<button className="create-card" onClick={()=>setModal('create')} disabled={!online}><span><Plus size={22}/></span><b>开启新的工作</b><small>在任意在线节点创建终端</small></button></div>:<div className="empty-state"><div><TerminalSquare size={33}/></div><h2>{query?'没有找到对应的终端':'下一项工作，从这里开始'}</h2><p>{!data.nodes.length?'接入一台机器，即可在浏览器中创建持久终端。':!online?'节点上线后，就可以创建或重新连接终端。':'创建一个终端。即使离开页面，工作也会继续。'}</p><button className="primary" onClick={()=>setModal(data.nodes.length?'create':'join')} disabled={!!data.nodes.length&&!online}><Plus size={16}/>{data.nodes.length?'新建终端':'接入第一台节点'}</button></div>}
    <footer className="page-footer"><span>WORKDECK</span><span>终端在节点运行 · 浏览器仅负责连接</span><span>v0.1</span></footer>
   </div>
   {tabs.map(id=>{const t=data.terminals.find(t=>t.id===id);if(!t)return null;return <TerminalView key={id} terminal={t} node={data.nodes.find(n=>n.id===t.node_id)} visible={active===id} onBack={()=>setActive(null)} onStop={()=>void stop(t)} notify={notify}/>})}
  </main>
  {toast&&<div className="toast" role="status"><Check size={17}/>{toast}<button aria-label="关闭提示" onClick={()=>setToast('')}><X size={14}/></button></div>}
  {modal&&<div className="modal-shade" onMouseDown={e=>{if(e.target===e.currentTarget)setModal(null)}}><section className="modal" role="dialog" aria-modal="true" aria-label={modal==='create'?'新建终端':modal==='join'?'接入节点':'修改密码'}><button className="modal-close icon-button" aria-label="关闭对话框" onClick={()=>setModal(null)}><X size={20}/></button>{modal==='create'?<CreateTerminal nodes={data.nodes} selected={filter} onCreated={async id=>{setModal(null);await refresh();open(id)}}/>:modal==='join'?<JoinNode notify={notify}/>:<Password onSaved={()=>{setModal(null);notify('密码已更新，其他设备需要重新登录')}}/>}</section></div>}
 </div>;
}
function Brand(){return <div className="brand"><div><Command size={21}/></div><span>workdeck</span><small>BETA</small></div>}
function Login({onLogin}:{onLogin:(u:User)=>void}){
 const[username,setUsername]=useState('admin'),[password,setPassword]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 return <div className="login-page"><div className="login-decoration"><span className="orb one"/><span className="orb two"/><div className="login-story"><div className="eyebrow">ONE WORKSPACE. EVERY MACHINE.</div><h1>你的工作现场，<br/>一直都在<span>.</span></h1><p>无论在哪个屏幕，<br/>随时接回你的终端与任务。</p><div className="story-terminal"><div><i/><i/><i/><span>your-machine ~</span></div><p><b>❯</b> 开始一项值得投入的工作<span className="cursor"/></p><small>session running · you can safely disconnect</small></div></div></div><div className="login-panel"><Brand/><form onSubmit={async e=>{e.preventDefault();setError('');setBusy(true);try{onLogin(await api<User>('/login',{method:'POST',body:JSON.stringify({username,password})}))}catch(e){setError((e as Error).message)}finally{setBusy(false)}}}><span className="eyebrow">WELCOME BACK</span><h2>登录工作台</h2><p>连接你的机器，继续你的工作。</p><label>用户名<input name="username" autoComplete="username" value={username} onChange={e=>setUsername(e.target.value)} required/></label><label>密码<input name="password" type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} required/></label>{error&&<div className="form-error" role="alert">{error}</div>}<button className="primary" disabled={busy}>{busy?'正在登录…':'进入工作台'}<ArrowRight size={17}/></button><div className="login-note"><ShieldCheck size={15}/>独立部署 · 加密连接</div></form><div className="login-copyright">Workdeck / 让工作不受设备限制</div></div></div>;
}
function CreateTerminal({nodes,selected,onCreated}:{nodes:Node[];selected:string;onCreated:(id:string)=>void}){
 const online=nodes.filter(n=>n.online);const[node,setNode]=useState(online.find(n=>n.id===selected)?.id||online[0]?.id||''),[name,setName]=useState('新终端'),[cwd,setCwd]=useState(nodes.find(n=>n.id===(online.find(n=>n.id===selected)?.id||online[0]?.id))?.home||''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 return <form onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{const t=await api<Term>('/terminals',{method:'POST',body:JSON.stringify({node_id:node,name,cwd})});if(t.state==='error'){setError(t.error||'终端启动失败');setBusy(false);return}onCreated(t.id)}catch(e){setError((e as Error).message);setBusy(false)}}}><div className="modal-symbol"><TerminalSquare size={24}/></div><h2>开启新的工作</h2><p className="modal-description">在节点上创建独立会话，离开页面后持续运行。</p><label>计算节点<select value={node} onChange={e=>{setNode(e.target.value);setCwd(nodes.find(n=>n.id===e.target.value)?.home||'')}}>{online.map(n=><option key={n.id} value={n.id}>{n.name} · {n.platform}</option>)}</select></label><label>终端名称<input value={name} onChange={e=>setName(e.target.value)} maxLength={80} required autoFocus/></label><label>工作目录<input value={cwd} onChange={e=>setCwd(e.target.value)} placeholder="使用节点的用户主目录"/><small>填写节点上的绝对路径。</small></label>{error&&<div className="form-error">{error}</div>}{!online.length&&<div className="form-error">当前没有在线节点，请先接入机器。</div>}<button className="primary full" disabled={busy||!node}>{busy?'正在创建…':'创建并连接'}<ArrowRight size={17}/></button></form>;
}
function JoinNode({notify}:{notify:(s:string)=>void}){
 const[enrollment,setEnrollment]=useState<{token:string;expires_at:string;hub:string}|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const generate=async()=>{setBusy(true);setError('');try{setEnrollment(await api('/enrollments',{method:'POST'}))}catch(e){setError((e as Error).message)}finally{setBusy(false)}};
 const command=enrollment?`curl -fsS ${enrollment.hub}/install-agent.sh -o /tmp/workdeck-install.sh\nsh /tmp/workdeck-install.sh --hub ${enrollment.hub} --token ${enrollment.token}`:'';
 return <><div className="modal-symbol"><Server size={24}/></div><h2>接入一台机器</h2><p className="modal-description">在目标 Linux 机器上安装 Agent。只需出站 HTTPS，不需要公网 IP。</p><div className="join-steps"><span>01</span><div><b>生成一次性加入令牌</b><p>10 分钟内有效，使用后自动失效。</p></div></div>{!enrollment?<button className="primary full" disabled={busy} onClick={()=>void generate()}><KeyRound size={16}/>{busy?'正在生成…':'生成接入命令'}</button>:<><div className="join-steps"><span>02</span><div><b>在目标机器上运行</b><p>以日常工作用户执行，需要 tmux 与用户级 systemd。</p></div></div><pre className="install-command">{command}</pre><button className="secondary full" onClick={async()=>{try{await navigator.clipboard.writeText(command);notify('接入命令已复制')}catch{notify('请手动复制接入命令')}}}><Copy size={15}/>复制接入命令</button><p className="form-hint">令牌到期时间：{new Date(enrollment.expires_at).toLocaleTimeString()}。新节点上线后会自动出现在列表。</p><button className="text-button" disabled={busy} onClick={()=>void generate()}>重新生成令牌</button></>}{error&&<div className="form-error">{error}</div>}</>;
}
function Password({onSaved}:{onSaved:()=>void}){
 const[current,setCurrent]=useState(''),[password,setPassword]=useState(''),[confirmPassword,setConfirm]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
 return <form onSubmit={async e=>{e.preventDefault();if(password!==confirmPassword){setError('两次输入的密码不一致');return};setBusy(true);setError('');try{await api('/account/password',{method:'POST',body:JSON.stringify({current,password})});onSaved()}catch(e){setError((e as Error).message)}finally{setBusy(false)}}}><div className="modal-symbol"><KeyRound size={24}/></div><h2>修改登录密码</h2><p className="modal-description">保存后，其他设备的登录将失效。</p><label>当前密码<input type="password" autoComplete="current-password" value={current} onChange={e=>setCurrent(e.target.value)} required/></label><label>新密码<input type="password" autoComplete="new-password" value={password} onChange={e=>setPassword(e.target.value)} minLength={16} required/><small>至少 16 个字符。</small></label><label>确认新密码<input type="password" autoComplete="new-password" value={confirmPassword} onChange={e=>setConfirm(e.target.value)} required/></label>{error&&<div className="form-error">{error}</div>}<button className="primary full" disabled={busy}>{busy?'正在保存…':'保存密码'}</button></form>;
}
function TerminalView({terminal,node,visible,onBack,onStop,notify}:{terminal:Term;node?:Node;visible:boolean;onBack:()=>void;onStop:()=>void;notify:(s:string)=>void}){
 const container=useRef<HTMLDivElement>(null),panel=useRef<HTMLElement>(null),instance=useRef<XTerminal|null>(null),socket=useRef<WebSocket|null>(null),connectRef=useRef<(takeover?:boolean)=>void>(()=>{}),fitRef=useRef<()=>void>(()=>{});
 const[connection,setConnection]=useState('connecting'),[readonly,setReadonly]=useState(true),[size,setSize]=useState(''),[failure,setFailure]=useState(''),[ctrl,setCtrl]=useState(false);
 const stopped=terminal.desired_state==='closed'||['closed','lost','error'].includes(terminal.state);
 const visibleRef=useRef(visible);visibleRef.current=visible;
 useEffect(()=>{
  if(!container.current||stopped)return;
  const term=new XTerminal({cursorBlink:true,fontFamily:'"SFMono-Regular", Consolas, "Liberation Mono", monospace',fontSize:14,lineHeight:1.25,scrollback:5000,allowProposedApi:false,theme:{background:'#111416',foreground:'#d7dedb',cursor:'#e7ae7a',selectionBackground:'#46605688',black:'#202628',red:'#e99591',green:'#9fc7a3',yellow:'#e2c38f',blue:'#95b7d1',magenta:'#bda3cf',cyan:'#91c5c0',white:'#d7dedb'},convertEol:false});
  const fit=new FitAddon();term.loadAddon(fit);term.open(container.current);instance.current=term;
  let disposed=false,retry:ReturnType<typeof setTimeout>|null=null,generation=0,attempt=0,currentReadonly=true;
  const sendSize=()=>{if(!visibleRef.current)return;try{fit.fit();setSize(`${term.cols} × ${term.rows}`);if(socket.current?.readyState===WebSocket.OPEN)socket.current.send(JSON.stringify({type:'resize',cols:term.cols,rows:term.rows}))}catch{}};
  fitRef.current=sendSize;
  const connect=(takeover=false)=>{
   if(disposed)return;generation++;const gen=generation;if(retry)clearTimeout(retry);socket.current?.close();setConnection('connecting');setFailure('');
   const ws=new WebSocket(`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}/api/terminals/${terminal.id}/ws${takeover?'?takeover=1':''}`);ws.binaryType='arraybuffer';socket.current=ws;
   ws.onmessage=e=>{
    if(gen!==generation)return;
    if(typeof e.data==='string'){try{const frame=JSON.parse(e.data);if(frame.type==='ready'){term.reset();currentReadonly=frame.readonly;setReadonly(frame.readonly);term.options.disableStdin=frame.readonly;setConnection('connected');attempt=0;requestAnimationFrame(sendSize);if(visibleRef.current)term.focus()}else if(frame.type==='error'){setFailure(frame.message);setConnection('error')}}catch{};return}
    const bytes=new Uint8Array(e.data);term.write(bytes,()=>{if(ws.readyState===WebSocket.OPEN&&gen===generation)ws.send(JSON.stringify({type:'ack',bytes:bytes.byteLength}))});
   };
   ws.onclose=()=>{if(disposed||gen!==generation)return;setConnection('disconnected');retry=setTimeout(()=>connect(),Math.min(1000*2**attempt++,15000))};
   ws.onerror=()=>{if(gen===generation)setConnection('disconnected')};
  };
  connectRef.current=connect;
  const input=term.onData(data=>{if(socket.current?.readyState===WebSocket.OPEN&&!currentReadonly)socket.current.send(new TextEncoder().encode(data))});
  const binary=term.onBinary(data=>{if(socket.current?.readyState===WebSocket.OPEN&&!currentReadonly)socket.current.send(Uint8Array.from(data,c=>c.charCodeAt(0)))});
  const observer=new ResizeObserver(()=>requestAnimationFrame(sendSize));observer.observe(container.current);
  const viewport=()=>requestAnimationFrame(sendSize);window.visualViewport?.addEventListener('resize',viewport);window.addEventListener('resize',viewport);
  connect();return()=>{disposed=true;generation++;if(retry)clearTimeout(retry);observer.disconnect();window.visualViewport?.removeEventListener('resize',viewport);window.removeEventListener('resize',viewport);socket.current?.close();socket.current=null;input.dispose();binary.dispose();term.dispose();instance.current=null};
 },[terminal.id,stopped]);
 useEffect(()=>{if(visible){requestAnimationFrame(()=>{fitRef.current();instance.current?.focus()})}},[visible]);
 const send=(s:string)=>{if(readonly||socket.current?.readyState!==WebSocket.OPEN)return;socket.current.send(new TextEncoder().encode(s));instance.current?.focus()};
 return <section ref={panel} className={'terminal-workspace '+(!visible?'hidden':'')}><div className="terminal-heading"><div><button className="icon-button" title="返回概览" onClick={onBack}><ArrowLeft size={17}/></button><TerminalSquare size={18}/><b>{terminal.name}</b><span className="terminal-host">{node?.name}</span></div><div><span className={'terminal-state '+(connection==='connected'?'live':'')}>{stopped?'已结束':connection==='connected'?(readonly?'只读连接':'控制中'):'重新连接中…'}</span><button className="icon-button" title="重新连接" aria-label="重新连接" onClick={()=>connectRef.current()}><RefreshCw size={16}/></button><button className="icon-button" title="全屏" aria-label="全屏" onClick={()=>{if(!document.fullscreenElement)void panel.current?.requestFullscreen().catch(()=>notify('浏览器不支持全屏'));else void document.exitFullscreen()}}><Maximize2 size={16}/></button><button className="icon-button danger-text" title="终止终端和任务" aria-label="终止终端" onClick={onStop}><Trash2 size={16}/></button></div></div>
  {!stopped&&readonly&&connection==='connected'&&<div className="readonly-banner"><Monitor size={15}/><span>其他设备正在控制此终端。当前为只读模式。</span><button onClick={()=>connectRef.current(true)}>接管终端<ArrowRight size={14}/></button></div>}
  {(failure||stopped||!node?.online)&&<div className="terminal-notice">{failure|| (stopped?'此终端已结束。可返回概览创建新的终端。':'节点当前离线，正在等待重新连接。')}</div>}
  <div className="terminal-screen" ref={container}/>
  <div className="mobile-keys"><button className={ctrl?'pressed':''} disabled={readonly} onClick={()=>setCtrl(!ctrl)}>Ctrl</button>{ctrl?<>{['C','D','Z','L'].map(k=><button key={k} disabled={readonly} onClick={()=>{send(String.fromCharCode(k.charCodeAt(0)-64));setCtrl(false)}}>{k}</button>)}</>:<><button disabled={readonly} onClick={()=>send('\x1b')}>Esc</button><button disabled={readonly} onClick={()=>send('\t')}>Tab</button><button disabled={readonly} onClick={()=>send('\x1b[A')}>↑</button><button disabled={readonly} onClick={()=>send('\x1b[B')}>↓</button><button disabled={readonly} onClick={()=>send('\x1b[D')}>←</button><button disabled={readonly} onClick={()=>send('\x1b[C')}>→</button></>}<button disabled={readonly} onClick={async()=>{try{send(await navigator.clipboard.readText())}catch{notify('请使用浏览器的粘贴功能')}}}>粘贴</button></div>
  <div className="terminal-statusbar"><span><i className={'dot '+(connection==='connected'?'online':'')}/>{connection==='connected'?(readonly?'只读':'可输入'):'连接恢复中'}</span><span>{terminal.cwd}</span><span>{size}</span><span className="persist-label">关闭标签页后任务继续运行</span></div>
 </section>;
}

createRoot(document.getElementById('root')!).render(<App/>);
