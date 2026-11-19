const $=id=>document.getElementById(id);
let mode="login";
let selectedProgram=null;
let activePaymentId=null;
function setMode(next){mode=next;$("loginTab").classList.toggle("active",mode==="login");$("registerTab").classList.toggle("active",mode==="register");$("submitBtn").textContent=mode==="login"?"تسجيل الدخول":"إنشاء حساب";$("password").autocomplete=mode==="login"?"current-password":"new-password";$("authMessage").textContent="";}
$("loginTab").addEventListener("click",()=>setMode("login"));
$("registerTab").addEventListener("click",()=>setMode("register"));
async function api(path,options={}){const response=await fetch(path,{credentials:"same-origin",...options,headers:{"Content-Type":"application/json",...(options.headers||{})}});const data=await response.json().catch(()=>({error:"استجابة غير متوقعة من الخادم."}));if(!response.ok)throw new Error(data.error||"فشل الطلب.");return data;}
$("authForm").addEventListener("submit",async event=>{event.preventDefault();$("submitBtn").disabled=true;$("authMessage").textContent="يرجى الانتظار…";try{await api(mode==="login"?"/api/auth/login":"/api/auth/register",{method:"POST",body:JSON.stringify({email:$("email").value,password:$("password").value})});await loadDashboard();}catch(error){$("authMessage").textContent=error.message;}finally{$("submitBtn").disabled=false;}});
function escapeHtml(value){return String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function money(v){return new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:0}).format(Number(v));}
async function loadPrograms(){const data=await api("/api/programs");$("programList").innerHTML=data.programs.map(p=>`<article class="program-card"><div class="program-top"><span class="chip">MT5</span><span class="program-fee">رسوم مقترحة: ${money(p.fee_usd)}</span></div><h4>${money(p.account_size_usd)} حساب افتراضي</h4><div class="program-stats"><span>هدف الربح <b>${p.profit_target_pct}%</b></span><span>الخسارة اليومية <b>${p.daily_drawdown_pct}%</b></span><span>أقصى خسارة <b>${p.max_drawdown_pct}%</b></span><span>أيام التداول الدنيا <b>${p.min_trading_days}</b></span></div><button class="primary choose-program" data-program="${escapeHtml(p.id)}">اختيار هذا الحساب</button></article>`).join("");$("programNotice").textContent="الأسعار والشروط المعروضة مقترحات أولية قابلة للتعديل، ولا توجد مدفوعات مفعّلة حالياً.";document.querySelectorAll(".choose-program").forEach(b=>b.addEventListener("click",()=>selectProgram(b.dataset.program,data.programs)));}
function selectProgram(programId,programs){selectedProgram=programs.find(p=>p.id===programId);if(!selectedProgram)return;$("selectedProgramName").textContent=money(selectedProgram.account_size_usd)+" — "+money(selectedProgram.fee_usd)+" رسوم مقترحة";$("platformStep").classList.remove("hidden");$("platformStep").scrollIntoView({behavior:"smooth",block:"center"});}
$("confirmSelection").addEventListener("click",async()=>{if(!selectedProgram)return;const button=$("confirmSelection");button.disabled=true;$("selectionMessage").textContent="جارٍ حفظ اختيارك…";try{const result=await api("/api/challenges",{method:"POST",body:JSON.stringify({program_id:selectedProgram.id,platform:"MT5"})});$("selectionMessage").textContent="تم إنشاء طلبك. افتح تفاصيل الدفع أدناه.";activePaymentId=result.payment_id;await showPayment(activePaymentId);await loadDashboard();}catch(error){$("selectionMessage").textContent=error.message;}finally{button.disabled=false;}});
async function showPayment(paymentId){
  $("paymentPanel").classList.remove("hidden");
  $("paymentStatus").textContent="جارٍ تحميل تفاصيل طلب الدفع…";
  try{
    const data=await api("/api/payments/"+encodeURIComponent(paymentId));
    const p=data.payment;
    $("paymentAmount").textContent=Number(p.amount_usdt).toFixed(2)+" USDT";
    $("paymentAddress").textContent=data.receiving_address || "عنوان الاستقبال غير مضبوط في إعدادات Cloudflare.";
    $("paymentAddress").classList.remove("hidden");
    $("paymentTxid").parentElement.classList.remove("hidden");
    $("verifyPaymentBtn").classList.remove("hidden");
    $("paymentNetwork").textContent=data.network+" — "+data.token;
    $("paymentStatus").textContent=p.status==="paid"?"تم تأكيد الدفع": "بانتظار التحويل";
    $("paymentWarning").textContent=!data.configuration_ready
      ?"عنوان الاستقبال غير مضبوط بعد. أضف USDT_TRC20_ADDRESS في إعدادات Worker على Cloudflare."
      :!data.payment_enabled
        ?"عنوان الاستقبال مضبوط، لكن التحقق الآلي متوقف حتى تفعيل إعداد PAYMENTS_ENABLED بعد اختبار النظام."
        :"أدخل رقم المعاملة بعد التحويل ليتم التحقق من وصول USDT على شبكة TRON.";
    $("verifyPaymentBtn").disabled=!data.configuration_ready || !data.payment_enabled;
  }catch(error){
    $("paymentStatus").textContent="تعذر تحميل تفاصيل الدفع: "+error.message;
    $("paymentWarning").textContent="لا ترسل أي أموال. نحتاج إصلاح إعدادات الخادم أولاً.";
    $("verifyPaymentBtn").disabled=true;
  }
}
async function copyCheckoutValue(value,label){
  if(!value||value==="عنوان الاستقبال غير مضبوط في إعدادات Cloudflare."){$("paymentStatus").textContent="لا توجد قيمة جاهزة للنسخ.";return;}
  try{await navigator.clipboard.writeText(value);$("paymentStatus").textContent="تم نسخ "+label+" إلى الحافظة.";}
  catch{$("paymentStatus").textContent="تعذر النسخ تلقائيًا. حدّد النص وانسخه يدويًا.";}
}
$("copyAddressBtn").addEventListener("click",()=>copyCheckoutValue($("paymentAddress").textContent.trim(),"عنوان المحفظة"));
$("copyAmountBtn").addEventListener("click",()=>copyCheckoutValue($("paymentAmount").textContent.trim(),"المبلغ"));
$("verifyPaymentBtn").addEventListener("click",async()=>{
  if(!activePaymentId)return;
  const txid=$("paymentTxid").value.trim();
  $("verifyPaymentBtn").disabled=true;
  $("paymentStatus").textContent="جارٍ التحقق من شبكة TRON…";
  try{
    const result=await api("/api/payments/"+encodeURIComponent(activePaymentId)+"/verify",{method:"POST",body:JSON.stringify({txid})});
    $("paymentStatus").textContent=result.message;
    await loadDashboard();
  }catch(error){$("paymentStatus").textContent=error.message;}
  finally{$("verifyPaymentBtn").disabled=false;}
});
async function loadDashboard(){try{const me=await api("/api/auth/me");$("auth").classList.add("hidden");$("dashboard").classList.remove("hidden");$("userEmail").textContent=me.user.email;await loadPrograms();const data=await api("/api/dashboard");const challenges=data.challenges||[];const active=challenges.filter(c=>c.status==="active").length;const balance=challenges.reduce((sum,c)=>sum+Number(c.current_balance||0),0);$("overviewCount").textContent=challenges.length;$("overviewActive").textContent=active;$("overviewBalance").textContent=new Intl.NumberFormat("en-US",{style:"currency",currency:"USD",maximumFractionDigits:2}).format(balance);$("overviewStatus").textContent=challenges.length?active?"نشط":"قيد المتابعة":"لا توجد تحديات";const statusLabels={pending:"بانتظار التفعيل",active:"نشط",passed:"ناجح",failed:"غير ناجح",cancelled:"ملغى"};$("challengeList").innerHTML=challenges.length?challenges.map(c=>'<article class="challenge-card"><div class="challenge-heading"><div><span class="challenge-label">EVALUATION ACCOUNT</span><h4>'+escapeHtml(c.program_name)+'</h4></div><span class="challenge-status status-'+escapeHtml(c.status)+'">'+escapeHtml(statusLabels[c.status]||c.status)+'</span></div><div class="challenge-metrics"><div><span>الرصيد</span><strong>'+money(c.current_balance)+'</strong></div><div><span>Equity</span><strong>'+money(c.equity??c.current_balance)+'</strong></div><div><span>هدف الربح</span><strong>'+Number(c.profit_target_pct||0)+'%</strong></div><div><span>الخسارة اليومية</span><strong>'+Number(c.daily_drawdown_pct||0)+'%</strong></div><div><span>أقصى خسارة</span><strong>'+Number(c.max_drawdown_pct||0)+'%</strong></div><div><span>أيام التداول</span><strong>'+Number(c.trading_days_count||0)+'</strong></div><div><span>المنصة</span><strong>'+escapeHtml(c.platform||"MT5")+'</strong></div></div><div class="challenge-foot">'+(c.account_login?'Login: '+escapeHtml(c.account_login)+' · Server: '+escapeHtml(c.server_name||"—"):'حساب التداول لم يتم تجهيزه بعد')+(c.failure_reason?'<div class="challenge-foot">سبب الإنهاء: '+escapeHtml(c.failure_reason)+'</div>':'')+(c.ended_at?'<div class="challenge-foot">تاريخ الإنهاء: '+escapeHtml(c.ended_at)+'</div>':'')+(c.last_provider_snapshot_at?'<div class="challenge-foot">آخر مزامنة بيانات: '+escapeHtml(c.last_provider_snapshot_at)+'</div>':'')+'</div></article>').join(""):'<p class="empty">لم تختر حساب تقييم بعد. اختر إحدى الباقات أدناه للبدء.</p>';$("notifications").innerHTML=data.notifications.length?data.notifications.map(n=>'<div class="item"><strong>'+escapeHtml(n.title)+'</strong><small>'+escapeHtml(n.body)+'</small></div>').join(""):'<p class="empty">لا توجد إشعارات.</p>';}catch(error){$("auth").classList.remove("hidden");$("dashboard").classList.add("hidden");$("authMessage").textContent="تعذر تحميل لوحة التحكم: "+(error?.message||"خطأ غير معروف");}}
$("logoutBtn").addEventListener("click",async()=>{try{await api("/api/auth/logout",{method:"POST",body:"{}"});}finally{$("dashboard").classList.add("hidden");$("auth").classList.remove("hidden");$("password").value="";}});
loadDashboard();