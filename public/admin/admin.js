const $=id=>document.getElementById(id);
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const money=v=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(Number(v));
async function api(path,options={}){const r=await fetch(path,{credentials:"same-origin",...options,headers:{"Content-Type":"application/json",...(options.headers||{})}});const d=await r.json().catch(()=>({error:"استجابة غير صالحة"}));if(!r.ok)throw new Error(d.error||"فشل الطلب");return d;}
let adminPrograms=[];
function fillProgramForm(p){
 $("programName").value=p.name||"";
 $("programDescription").value=p.description||"";
 $("programSize").value=p.account_size_usd;
 $("programFee").value=p.fee_usd;
 $("programTarget").value=p.profit_target_pct;
 $("programDaily").value=p.daily_drawdown_pct;
 $("programMaxLoss").value=p.max_drawdown_pct;
 $("programMinDays").value=p.min_trading_days;
 $("programMaxDays").value=p.max_trading_days??"";
 $("programStatus").value=p.status;
}
async function loadPrograms(){
 const data=await api("/api/admin/programs");
 adminPrograms=data.programs||[];
 $("programSelect").innerHTML=adminPrograms.map(p=>'<option value="'+esc(p.id)+'">'+esc(p.name)+' — '+money(p.account_size_usd)+'</option>').join("");
 if(adminPrograms.length)fillProgramForm(adminPrograms[0]);
}
$("programSelect").addEventListener("change",()=>{
 const selected=adminPrograms.find(p=>p.id===$("programSelect").value);
 if(selected)fillProgramForm(selected);
 $("programEditMessage").textContent="";
});
$("saveProgram").addEventListener("click",async()=>{
 const id=$("programSelect").value;
 if(!id)return;
 const p={
  name:$("programName").value.trim(),description:$("programDescription").value.trim(),
  account_size_usd:Number($("programSize").value),fee_usd:Number($("programFee").value),
  profit_target_pct:Number($("programTarget").value),daily_drawdown_pct:Number($("programDaily").value),
  max_drawdown_pct:Number($("programMaxLoss").value),min_trading_days:Number($("programMinDays").value),
  max_trading_days:$("programMaxDays").value===""?null:Number($("programMaxDays").value),status:$("programStatus").value
 };
 const btn=$("saveProgram");btn.disabled=true;$("programEditMessage").textContent="جارٍ حفظ البرنامج…";
 try{const result=await api("/api/admin/programs/"+encodeURIComponent(id),{method:"PUT",body:JSON.stringify(p)});$("programEditMessage").textContent=result.message||"تم الحفظ.";await loadPrograms();}
 catch(e){$("programEditMessage").textContent=e.message;}
 finally{btn.disabled=false;}
});
const dateFmt=v=>v?new Date(v).toLocaleString():"—";
async function loadChallenges(){
 const status=$("challengeStatusFilter").value;
 const data=await api("/api/admin/challenges"+(status?"?status="+encodeURIComponent(status):""));
 const challenges=data.challenges||[];
 const money2=v=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:2}).format(Number(v||0));
 $("challengesList").innerHTML=challenges.length?challenges.map(c=>'<article class="program-card"><h3>'+esc(c.program_name)+' · '+esc(c.status)+'</h3><p>العميل: <b>'+esc(c.email)+'</b></p><p>Challenge ID: <code>'+esc(c.id)+'</code></p><div class="program-stats"><span>Initial balance<b>'+money2(c.initial_balance)+'</b></span><span>Balance<b>'+money2(c.current_balance)+'</b></span><span>Equity<b>'+money2(c.equity)+'</b></span><span>High watermark<b>'+money2(c.high_watermark)+'</b></span><span>Daily start equity<b>'+money2(c.daily_start_equity)+'</b></span><span>Target<b>'+esc(c.profit_target_pct)+'%</b></span><span>Daily limit<b>'+esc(c.daily_drawdown_pct)+'%</b></span><span>Trading days<b>'+esc(c.trading_days_count||0)+'</b></span><span>Max loss<b>'+esc(c.max_drawdown_pct)+'%</b></span></div><p>Account: '+esc(c.account_login||"غير مُجهز")+' · '+esc(c.server_name||"—")+'</p><p>Platform: '+esc(c.platform||"MT5")+' · Mode: '+esc(c.integration_mode||"—")+' · Connection: '+esc(c.connection_status||"—")+'</p><p>Last sync: '+esc(dateFmt(c.last_sync_at))+' · Started: '+esc(dateFmt(c.started_at))+'</p>'+(c.failure_reason?'<p class="message">Failure reason: '+esc(c.failure_reason)+'</p>':'')+'</article>').join(""):'<p class="empty">لا توجد تحديات بهذه الحالة.</p>';
}
$("challengesRefresh").addEventListener("click",async()=>{$("challengesMessage").textContent="جارٍ التحديث…";try{await loadChallenges();$("challengesMessage").textContent="تم تحديث التحديات.";}catch(e){$("challengesMessage").textContent=e.message;}});
$("challengeStatusFilter").addEventListener("change",async()=>{try{await loadChallenges();$("challengesMessage").textContent="";}catch(e){$("challengesMessage").textContent=e.message;}});
async function loadFinancials(){
 const data=await api("/api/admin/financials");
 const orders=data.orders||[],payments=data.payments||[];
 $("ordersList").innerHTML=orders.length?orders.map(o=>'<article class="program-card"><h3>'+esc(o.program_name)+'</h3><p>'+esc(o.email)+'</p><p>Order: <b>'+esc(o.id)+'</b></p><p>Amount: <b>'+money(o.amount_usd)+' '+esc(o.currency)+'</b></p><p>Status: '+esc(o.status)+'</p><p>Payment method: '+esc(o.payment_provider||"—")+'</p><p>Created: '+esc(dateFmt(o.created_at))+'</p></article>').join(""):'<p class="empty">لا توجد طلبات مسجلة.</p>';
 $("paymentsList").innerHTML=payments.length?payments.map(p=>'<article class="program-card"><h3>'+esc(p.program_name)+'</h3><p>'+esc(p.email)+'</p><p>Payment ID: '+esc(p.id)+'</p><p>Amount: <b>'+Number(p.amount_usdt).toFixed(2)+' USDT</b></p><p>Status: <b>'+esc(p.status)+'</b> · Challenge: '+esc(p.challenge_status)+'</p><p>TXID: <code style="overflow-wrap:anywhere">'+esc(p.txid||"—")+'</code></p><p>Created: '+esc(dateFmt(p.created_at))+' · Paid: '+esc(dateFmt(p.paid_at))+'</p></article>').join(""):'<p class="empty">لا توجد دفعات مسجلة.</p>';
}
$("financialsRefresh").addEventListener("click",async()=>{$("financialsMessage").textContent="جارٍ تحديث البيانات…";try{await loadFinancials();$("financialsMessage").textContent="تم تحديث البيانات.";}catch(e){$("financialsMessage").textContent=e.message;}});
async function loadUsers(){
 const data=await api("/api/admin/users");
 const users=data.users||[];
 $("usersList").innerHTML=users.length?users.map(u=>'<article class="program-card"><h3>'+esc(u.email)+'</h3><p>Role: <b>'+esc(u.role)+'</b></p><p>الحالة: <b>'+esc(u.status)+'</b></p><p>تاريخ التسجيل: '+esc(u.created_at||"—")+'</p><button class="'+(u.status==="active"?"secondary":"primary")+' user-status" data-id="'+esc(u.id)+'" data-status="'+(u.status==="active"?"suspended":"active")+'">'+(u.status==="active"?"تعليق الحساب":"إعادة تفعيل الحساب")+'</button></article>').join(""):'<p class="empty">لا يوجد مستخدمون.</p>';
 $("usersList").querySelectorAll(".user-status").forEach(b=>b.addEventListener("click",async()=>{
  const next=b.dataset.status,verb=next==="suspended"?"تعليق":"إعادة تفعيل";
  if(!confirm("هل تريد "+verb+" هذا الحساب؟"+(next==="suspended"?" سيتم إلغاء جلسات الدخول الحالية.":"")))return;
  b.disabled=true;$("usersMessage").textContent="جارٍ تحديث حالة الحساب…";
  try{const result=await api("/api/admin/users/"+encodeURIComponent(b.dataset.id)+"/status",{method:"PATCH",body:JSON.stringify({status:next})});$("usersMessage").textContent=result.message;await loadUsers();}
  catch(e){$("usersMessage").textContent=e.message;b.disabled=false;}
 }));
}
$("usersRefresh").addEventListener("click",async()=>{ $("usersMessage").textContent="جارٍ تحديث المستخدمين…";try{await loadUsers();$("usersMessage").textContent="تم تحديث قائمة المستخدمين.";}catch(e){$("usersMessage").textContent=e.message;}});
async function loadRiskEvents(){
 const severity=$("riskSeverityFilter").value;
 const challengeId=$("riskChallengeFilter").value.trim();
 const data=await api("/api/admin/risk-events?limit=100"+(severity?"&severity="+encodeURIComponent(severity):"")+(challengeId?"&challenge_id="+encodeURIComponent(challengeId):""));
 const events=data.risk_events||[];
 const labels={breach:"خرق",warning:"تحذير",info:"معلومة"};
 const fmt2=v=>v===null||v===undefined?"—":Number(v).toLocaleString("en-US",{maximumFractionDigits:2});
 $("riskEventsList").innerHTML=events.length?events.map(e=>'<article class="program-card"><h3>'+esc(labels[e.severity]||e.severity)+' · '+esc(e.event_type)+'</h3><p>'+esc(e.email)+' · '+esc(e.program_name)+'</p><p>Challenge: <code>'+esc(e.challenge_id)+'</code></p><p>'+esc(e.message||"")+'</p><div class="program-stats"><span>Metric<b>'+fmt2(e.metric_value)+'</b></span><span>Threshold<b>'+fmt2(e.threshold_value)+'</b></span><span>Status<b>'+esc(e.challenge_status)+'</b></span></div><p>وقت الحدث: '+esc(dateFmt(e.created_at))+'</p></article>').join(""):'<p class="empty">لا توجد أحداث مخاطر.</p>';
}
$("riskRefresh").addEventListener("click",async()=>{$("riskMessage").textContent="جارٍ تحميل سجل المخاطر…";try{await loadRiskEvents();$("riskMessage").textContent="تم تحديث سجل المخاطر.";}catch(e){$("riskMessage").textContent=e.message;}});
$("riskSeverityFilter").addEventListener("change",async()=>{try{await loadRiskEvents();$("riskMessage").textContent="";}catch(e){$("riskMessage").textContent=e.message;}});
$("riskChallengeFilter").addEventListener("change",async()=>{try{await loadRiskEvents();$("riskMessage").textContent="";}catch(e){$("riskMessage").textContent=e.message;}});
async function load(){ $("adminMessage").textContent="جارٍ تحميل الطلبات…"; try{const me=await api("/api/auth/me");if(!me.user||me.user.role!=="admin"){location.href="/app/";return;} $("adminEmail").textContent=me.user.email;await loadPrograms();await loadUsers();await loadChallenges();await loadFinancials();await loadRiskEvents();const data=await api("/api/admin/challenges/pending-provisioning");$("queue").innerHTML=data.challenges.length?data.challenges.map(c=>'<article class="program-card"><h3>'+esc(c.program_name)+'</h3><p>'+esc(c.email)+'</p><p>الرصيد الافتراضي: <b>'+money(c.account_size_usd)+'</b></p><p>المبلغ المؤكد: '+Number(c.amount_usdt).toFixed(2)+' USDT</p><p>الحالة: '+(c.email_status==="failed"?"فشل إرسال البريد — إعادة المحاولة متاحة":"بانتظار إنشاء الحساب")+'</p><button class="primary provision" data-id="'+esc(c.challenge_id)+'">'+(c.email_status==="failed"?"إعادة إرسال بيانات الدخول":"إنشاء حساب MT5 وإرسال البيانات")+'</button><p class="message" id="msg-'+esc(c.challenge_id)+'"></p></article>').join(""):'<p class="empty">لا توجد طلبات مدفوعة تنتظر تجهيز حساب MT5.</p>';$("adminMessage").textContent="تم تحميل قائمة الطلبات.";document.querySelectorAll(".provision").forEach(b=>b.addEventListener("click",async()=>{if(!confirm("سيتم الاتصال بمزود MT5 وإنشاء حساب محاكاة ثم إرسال بيانات الدخول إلى بريد العميل. هل تريد المتابعة؟"))return;b.disabled=true;const msg=$("msg-"+b.dataset.id);msg.textContent="جارٍ تجهيز الحساب وإرسال البريد…";try{const result=await api("/api/admin/challenges/"+encodeURIComponent(b.dataset.id)+"/provision",{method:"POST",body:"{}"});msg.textContent=result.message||"اكتملت العملية.";await load();}catch(e){msg.textContent=e.message;b.disabled=false;}}));}catch(e){$("adminMessage").textContent=e.message;$("queue").innerHTML='<p class="empty">تعذر تحميل لوحة الإدارة. سجّل الدخول بحساب مشرف عبر بوابة المتداول أولاً.</p>';}}
$("refreshBtn").addEventListener("click",load);load();