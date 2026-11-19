function updateKpi(id,value){const el=$(id);if(el)el.textContent=String(value);}
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
 adminPrograms=data.programs||[];updateKpi("kpiPrograms",adminPrograms.filter(p=>p.status==="active").length);
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
let cachedChallenges=[];
function renderChallenges(){
 const status=$("challengeStatusFilter").value,query=($("challengeSearch")?.value||"").trim().toLowerCase();
 const filtered=cachedChallenges.filter(c=>(!status||c.status===status)&&(!query||String(c.email||"").toLowerCase().includes(query)||String(c.id||"").toLowerCase().includes(query)||String(c.program_name||"").toLowerCase().includes(query)||String(c.account_login||"").toLowerCase().includes(query)));
 const count=$("challengesSearchSummary");if(count)count.textContent="إجمالي التحديات: "+cachedChallenges.length+" · النتائج: "+filtered.length;
 const money2=v=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:2}).format(Number(v||0));
 $("challengesList").innerHTML=filtered.length?filtered.map(c=>'<article class="program-card"><h3>'+esc(c.program_name)+' · '+esc(c.status)+'</h3><p>العميل: <b>'+esc(c.email)+'</b></p><p>Challenge ID: <code>'+esc(c.id)+'</code></p><div class="program-stats"><span>Initial balance<b>'+money2(c.initial_balance)+'</b></span><span>Balance<b>'+money2(c.current_balance)+'</b></span><span>Equity<b>'+money2(c.equity)+'</b></span><span>High watermark<b>'+money2(c.high_watermark)+'</b></span><span>Daily start equity<b>'+money2(c.daily_start_equity)+'</b></span><span>Target<b>'+esc(c.profit_target_pct)+'%</b></span><span>Daily limit<b>'+esc(c.daily_drawdown_pct)+'%</b></span><span>Trading days<b>'+esc(c.trading_days_count||0)+' / '+esc(c.max_trading_days??'∞')+'</b></span><span>Minimum days<b>'+esc(c.min_trading_days??0)+'</b></span><span>Max loss<b>'+esc(c.max_drawdown_pct)+'%</b></span></div><p>Account: '+esc(c.account_login||"غير مُجهز")+' · '+esc(c.server_name||"—")+'</p><p>Platform: '+esc(c.platform||"MT5")+' · Mode: '+esc(c.integration_mode||"—")+' · Connection: '+esc(c.connection_status||"—")+'</p><p>Last sync: '+esc(dateFmt(c.last_sync_at))+' · Started: '+esc(dateFmt(c.started_at))+'</p>'+(c.failure_reason?'<p class="message">Failure reason: '+esc(c.failure_reason)+'</p>':'')+(c.status==='active'||c.status==='pending'?'<button class="secondary cancel-challenge" data-id="'+esc(c.id)+'">إلغاء التحدي</button>':'')+'</article>').join(""):'<p class="empty">لا توجد نتائج مطابقة.</p>';
 $("challengesList").querySelectorAll(".cancel-challenge").forEach(b=>b.addEventListener("click",async()=>{if(!confirm("تأكيد إلغاء هذا التحدي؟ سيتم تسجيل العملية وإشعار المتداول."))return;b.disabled=true;try{const result=await api("/api/admin/challenges/"+encodeURIComponent(b.dataset.id)+"/cancel",{method:"POST",body:"{}"});$("challengesMessage").textContent=result.message||"تم الإلغاء.";await loadChallenges();}catch(e){$("challengesMessage").textContent=e.message;b.disabled=false;}}));
}
async function loadChallenges(){
 const data=await api("/api/admin/challenges");cachedChallenges=data.challenges||[];
 updateKpi("kpiActive",cachedChallenges.filter(c=>c.status==="active").length);
 updateKpi("kpiPending",cachedChallenges.filter(c=>c.status==="pending").length);
 updateKpi("kpiPassed",cachedChallenges.filter(c=>c.status==="passed").length);
 updateKpi("kpiFailed",cachedChallenges.filter(c=>c.status==="failed").length);
 renderChallenges();
}
const challengeSearch=$("challengeSearch");if(challengeSearch)challengeSearch.addEventListener("input",renderChallenges);
$("challengesRefresh").addEventListener("click",async()=>{$("challengesMessage").textContent="جارٍ التحديث…";try{await loadChallenges();$("challengesMessage").textContent="تم تحديث التحديات.";}catch(e){$("challengesMessage").textContent=e.message;}});
$("challengeStatusFilter").addEventListener("change",async()=>{try{await loadChallenges();$("challengesMessage").textContent="";}catch(e){$("challengesMessage").textContent=e.message;}});
async function loadFinancials(){
 const data=await api("/api/admin/financials");
 await loadFinancialLedger();
 const orders=data.orders||[],payments=data.payments||[];updateKpi("kpiOrders",orders.length);updateKpi("kpiPayments",payments.length);
 $("ordersList").innerHTML=orders.length?orders.map(o=>'<article class="program-card"><h3>'+esc(o.program_name)+'</h3><p>'+esc(o.email)+'</p><p>Order: <b>'+esc(o.id)+'</b></p><p>Amount: <b>'+money(o.amount_usd)+' '+esc(o.currency)+'</b></p><p>Status: '+esc(o.status)+'</p><p>Payment method: '+esc(o.payment_provider||"—")+'</p><p>Created: '+esc(dateFmt(o.created_at))+'</p></article>').join(""):'<p class="empty">لا توجد طلبات مسجلة.</p>';
 $("paymentsList").innerHTML=payments.length?payments.map(p=>'<article class="program-card"><h3>'+esc(p.program_name)+'</h3><p>'+esc(p.email)+'</p><p>Payment ID: '+esc(p.id)+'</p><p>Amount: <b>'+Number(p.amount_usdt).toFixed(2)+' USDT</b></p><p>Status: <b>'+esc(p.status)+'</b> · Challenge: '+esc(p.challenge_status)+'</p><p>TXID: <code style="overflow-wrap:anywhere">'+esc(p.txid||"—")+'</code></p><p>Created: '+esc(dateFmt(p.created_at))+' · Paid: '+esc(dateFmt(p.paid_at))+'</p></article>').join(""):'<p class="empty">لا توجد دفعات مسجلة.</p>';
}
async function loadFinancialLedger(){
 const d=await api("/api/admin/financial-ledger");
 const sum=(rows,status)=>{const r=(rows||[]).find(x=>x.status===status);return r?Number(r.amount||0):0;};
 const count=(rows,status)=>{const r=(rows||[]).find(x=>x.status===status);return r?Number(r.count||0):0;};
 const orderTotals=d.orders?.totals||[],paymentTotals=d.crypto_payments?.totals||[],payoutTotals=d.payouts?.totals||[];
 const usdPaid=orderTotals.filter(x=>x.status==="paid"&&String(x.currency||"USD").toUpperCase()==="USD").reduce((n,x)=>n+Number(x.amount||0),0);
 const otherPaid=orderTotals.filter(x=>x.status==="paid"&&String(x.currency||"USD").toUpperCase()!=="USD");
 const usdtPaid=sum(paymentTotals,"paid"),paidOut=sum(payoutTotals,"paid"),approved=sum(payoutTotals,"approved"),pending=sum(payoutTotals,"pending");
 const stats=[
  ["إيرادات الطلبات المؤكدة (USD)",money(usdPaid)],
  ["دفعات USDT المؤكدة",usdtPaid.toFixed(2)+" USDT"],
  ["طلبات دفع معلقة",count(orderTotals,"pending")+count(paymentTotals,"pending")],
  ["سحوبات معتمدة غير مدفوعة",money(approved)],
  ["طلبات سحب قيد المراجعة",money(pending)],
  ["السحوبات المدفوعة",money(paidOut)]
 ];
 $("ledgerSummary").innerHTML=stats.map(x=>'<span>'+esc(x[0])+'<b>'+esc(x[1])+'</b></span>').join("")+
  (otherPaid.length?otherPaid.map(x=>'<span>إيرادات مؤكدة ('+esc(x.currency)+')<b>'+Number(x.amount||0).toFixed(2)+' '+esc(x.currency)+'</b></span>').join(""):"");
 const rows=d.payouts?.records||[];
 $("ledgerPayouts").innerHTML=rows.length?rows.map(p=>'<article class="program-card"><h3>'+esc(p.email)+' · '+money(p.requested_amount_usd)+'</h3><p>الحالة: <b>'+esc(p.status)+'</b> · Challenge: <code>'+esc(p.challenge_id)+'</code></p><p>طلب السحب: '+esc(p.id)+'</p><p>مرجع التحويل: <code style="overflow-wrap:anywhere">'+esc(p.tx_reference||"—")+'</code></p><p>تاريخ الطلب: '+esc(dateFmt(p.created_at))+' · آخر تحديث: '+esc(dateFmt(p.updated_at))+'</p></article>').join(""):'<p class="empty">لا توجد طلبات سحب.</p>';
 $("ledgerUpdated").textContent="آخر تحديث: "+dateFmt(d.generated_at);
}
$("financialsRefresh").addEventListener("click",async()=>{$("financialsMessage").textContent="جارٍ تحديث البيانات…";try{await loadFinancials();$("financialsMessage").textContent="تم تحديث البيانات.";}catch(e){$("financialsMessage").textContent=e.message;}});
let adminUsers=[];
function renderUsers(){
 const query=($("usersSearch")?.value||"").trim().toLowerCase();
 const users=adminUsers.filter(u=>!query||String(u.email||"").toLowerCase().includes(query)||String(u.role||"").toLowerCase().includes(query)||String(u.status||"").toLowerCase().includes(query));
 const active=adminUsers.filter(u=>u.status==="active").length;
 const suspended=adminUsers.filter(u=>u.status==="suspended").length;
 const summary=$("usersSummary");if(summary)summary.textContent="المجموع: "+adminUsers.length+" · نشط: "+active+" · موقوف: "+suspended+" · نتائج البحث: "+users.length;
 $("usersList").innerHTML=users.length?users.map(u=>'<article class="program-card"><h3>'+esc(u.email)+'</h3><p>Role: <b>'+esc(u.role)+'</b></p><p>الحالة: <b>'+esc(u.status)+'</b></p><p>تاريخ التسجيل: '+esc(u.created_at||"—")+'</p><button class="secondary trader-profile" data-id="'+esc(u.id)+'">عرض الملف الكامل</button> <button class="'+(u.status==="active"?"secondary":"primary")+' user-status" data-id="'+esc(u.id)+'" data-status="'+(u.status==="active"?"suspended":"active")+'">'+(u.status==="active"?"تعليق الحساب":"إعادة تفعيل الحساب")+'</button></article>').join(""):'<p class="empty">لا توجد نتائج مطابقة.</p>';
 $("usersList").querySelectorAll(".trader-profile").forEach(b=>b.addEventListener("click",async()=>{
  b.disabled=true;$("usersMessage").textContent="جارٍ تحميل ملف المتداول…";
  try{await loadTraderProfile(b.dataset.id);$("usersMessage").textContent="تم تحميل ملف المتداول.";}
  catch(e){$("usersMessage").textContent=e.message;}
  finally{b.disabled=false;}
 }));
 $("usersList").querySelectorAll(".user-status").forEach(b=>b.addEventListener("click",async()=>{
  const next=b.dataset.status,verb=next==="suspended"?"تعليق":"إعادة تفعيل";
  if(!confirm("هل تريد "+verb+" هذا الحساب؟"+(next==="suspended"?" سيتم إلغاء جلسات الدخول الحالية.":"")))return;
  b.disabled=true;$("usersMessage").textContent="جارٍ تحديث حالة الحساب…";
  try{const result=await api("/api/admin/users/"+encodeURIComponent(b.dataset.id)+"/status",{method:"PATCH",body:JSON.stringify({status:next})});$("usersMessage").textContent=result.message;await loadUsers();}
  catch(e){$("usersMessage").textContent=e.message;b.disabled=false;}
 }));
}
async function loadUsers(){
 const data=await api("/api/admin/users");adminUsers=data.users||[];updateKpi("kpiUsers",adminUsers.length);renderUsers();
}
const usersSearch=$("usersSearch");if(usersSearch)usersSearch.addEventListener("input",renderUsers);
$("usersRefresh").addEventListener("click",async()=>{ $("usersMessage").textContent="جارٍ تحديث المستخدمين…";try{await loadUsers();$("usersMessage").textContent="تم تحديث قائمة المستخدمين.";}catch(e){$("usersMessage").textContent=e.message;}});

async function loadTraderProfile(userId){
 const d=await api("/api/admin/users/"+encodeURIComponent(userId));
 const u=d.user, money2=v=>new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:2}).format(Number(v||0));
 const section=(title,rows,render)=>'<h3>'+title+'</h3>'+(rows.length?rows.map(render).join(""):'<p class="empty">لا توجد سجلات.</p>');
 const a=d.analytics||{},pct=v=>Number(v||0).toFixed(1)+"%",val=v=>v===null||v===undefined?"—":money2(v);
 const symbolRows=d.symbol_stats||[],trades=d.recent_trades||[];
 const analyticsHtml='<h3>تحليلات الأداء الفعلية (الصفقات المغلقة فقط)</h3><div class="program-stats"><span>الصفقات المغلقة<b>'+Number(a.closed_trades||0)+'</b></span><span>نسبة الفوز<b>'+pct(a.win_rate_pct)+'</b></span><span>صافي الربح والخسارة<b>'+money2(a.net_pnl)+'</b></span><span>Profit Factor<b>'+(a.profit_factor===null?"—":Number(a.profit_factor).toFixed(2))+'</b></span><span>إجمالي الأرباح<b>'+money2(a.gross_profit)+'</b></span><span>إجمالي الخسائر<b>'+money2(a.gross_loss)+'</b></span><span>متوسط الصفقة الرابحة<b>'+val(a.average_win)+'</b></span><span>متوسط الصفقة الخاسرة<b>'+val(a.average_loss)+'</b></span><span>أفضل صفقة<b>'+val(a.best_trade)+'</b></span><span>أسوأ صفقة<b>'+val(a.worst_trade)+'</b></span></div>';
 const symbolsHtml=section("الأداء حسب الرمز",symbolRows,x=>'<article class="program-card"><b>'+esc(x.symbol)+'</b><p>الصفقات: '+esc(x.trades)+' · نسبة الفوز: '+pct(x.trades?Number(x.wins||0)/Number(x.trades)*100:0)+'</p><p>صافي النتيجة: '+money2(x.net_pnl)+'</p></article>');
 const tradesHtml=section("آخر 30 صفقة مغلقة",trades,t=>'<article class="program-card"><b>'+esc(t.symbol)+' · '+esc(t.side)+'</b><p>الحجم: '+esc(t.volume)+' · النتيجة الصافية: '+money2(Number(t.profit||0)+Number(t.commission||0)+Number(t.swap||0))+'</p><p>فتح: '+esc(dateFmt(t.opened_at))+' · إغلاق: '+esc(dateFmt(t.closed_at))+'</p><p>المصدر: '+esc(t.source||"—")+' · Challenge: '+esc(t.challenge_id)+'</p></article>');
 const el=$("traderProfile");el.hidden=false;
 el.innerHTML='<div class="dash-head"><div><h2>ملف المتداول</h2><p class="sub">'+esc(u.email)+' · '+esc(u.status)+' · '+esc(u.role)+'</p></div><button type="button" class="secondary" id="closeTraderProfile">إغلاق الملف</button></div><div class="program-stats"><span>التحديات<b>'+d.challenges.length+'</b></span><span>الصفقات المسجلة<b>'+Number(a.closed_trades||0)+'</b></span><span>صافي نتائج الصفقات<b>'+money2(a.net_pnl)+'</b></span><span>طلبات السحب<b>'+d.payouts.length+'</b></span></div>'+analyticsHtml+symbolsHtml+tradesHtml+
 section("التحديات",d.challenges,c=>'<article class="program-card"><h4>'+esc(c.program_name)+' · '+esc(c.status)+'</h4><p>Challenge: <code>'+esc(c.id)+'</code></p><p>الرصيد: '+money2(c.current_balance)+' · Equity: '+money2(c.equity)+'</p><p>حساب MT5: '+esc(c.account_login||"غير مجهز")+' · '+esc(c.server_name||"—")+'</p><p>الصفقات المسجلة: '+esc(c.trade_count)+' · صافي P/L: '+money2(c.net_trade_pnl)+'</p><p>أيام التداول: '+esc(c.trading_days_count)+' · الإنشاء: '+esc(dateFmt(c.created_at))+'</p></article>')+
 section("طلبات السحب",d.payouts,p=>'<article class="program-card"><p>'+money2(p.requested_amount_usd)+' · '+esc(p.status)+'</p><p>Challenge: '+esc(p.challenge_id)+'</p><p>محفظة الاستلام: <code>'+esc(p.payout_wallet_address||"غير مسجلة")+'</code></p><p>TX reference: '+esc(p.tx_reference||"—")+'</p><p>'+esc(p.admin_note||"")+' · '+esc(dateFmt(p.created_at))+'</p>'+(p.status==="pending"?'<button class="primary payout-review" data-id="'+esc(p.id)+'" data-status="approved">موافقة</button> <button class="secondary payout-review" data-id="'+esc(p.id)+'" data-status="rejected">رفض</button>':p.status==="approved"?'<button class="primary payout-review" data-id="'+esc(p.id)+'" data-status="paid">تأكيد الدفع</button>':'')+'</article>')+
 section("المدفوعات",d.payments,p=>'<article class="program-card"><p>'+Number(p.amount_usdt||0).toFixed(2)+' USDT · '+esc(p.status)+'</p><p>TXID: <code>'+esc(p.txid||"—")+'</code></p><p>'+esc(dateFmt(p.created_at))+'</p></article>')+
 section("سجل المخاطر",d.risk_events,r=>'<article class="program-card"><p>'+esc(r.severity)+' · '+esc(r.event_type)+'</p><p>'+esc(r.message)+'</p><p>Challenge: '+esc(r.challenge_id)+' · '+esc(dateFmt(r.created_at))+'</p></article>');
 el.querySelectorAll(".payout-review").forEach(btn=>btn.addEventListener("click",async()=>{
  const status=btn.dataset.status;let admin_note="",tx_reference="";
  if(status==="rejected"){admin_note=prompt("سبب رفض طلب السحب:")||"";if(admin_note.trim().length<3)return;}
  if(status==="paid"){tx_reference=prompt("أدخل مرجع معاملة التحويل على الشبكة:")||"";if(tx_reference.trim().length<6)return;}
  if(!confirm(status==="approved"?"تأكيد الموافقة على طلب السحب؟":status==="rejected"?"تأكيد رفض طلب السحب؟":"تأكيد أن التحويل تم فعلياً؟"))return;
  btn.disabled=true;
  try{await api("/api/admin/payouts/"+encodeURIComponent(btn.dataset.id),{method:"PATCH",body:JSON.stringify({status,admin_note,tx_reference})});await openTraderProfile(u.id);}
  catch(e){alert(e.message);btn.disabled=false;}
 }));
 $("closeTraderProfile").addEventListener("click",()=>{el.hidden=true;el.innerHTML="";});
 el.scrollIntoView({behavior:"smooth",block:"start"});
}
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
async function loadOperations(){
 const msg=$("operationsMessage"); if(msg)msg.textContent="جارٍ تحميل المؤشرات…";
 try{
  const d=await api("/api/admin/overview");
  const set=(id,v)=>{const el=$(id);if(el)el.textContent=String(v??0);};
  const fmt=v=>new Intl.NumberFormat("en-US",{maximumFractionDigits:2}).format(Number(v||0));
  set("opsTraders",d.traders?.total);
  set("opsActiveTraders",d.traders?.active);
  set("opsSuspended",d.traders?.suspended);
  set("opsChallenges",d.challenges?.total);
  set("opsChallengesActive",d.challenges?.active);
  set("opsPassed",d.challenges?.passed);
  set("opsFailed",d.challenges?.failed);
  set("opsPaymentsPending",d.payments?.pending);
  set("opsPaymentsConfirmed",fmt(d.payments?.confirmed_usdt)+" USDT");
  set("opsPayoutPending",d.payouts?.pending);
  set("opsPayoutApproved",d.payouts?.approved);
  set("opsPayoutOutstanding",fmt(d.payouts?.outstanding_usd)+" USD");
  if(msg)msg.textContent="آخر تحديث: "+dateFmt(d.generated_at);
 }catch(e){if(msg)msg.textContent="تعذر تحميل مركز العمليات: "+e.message;}
}
const operationsRefresh=$("operationsRefresh");
if(operationsRefresh)operationsRefresh.addEventListener("click",loadOperations);
loadOperations();
