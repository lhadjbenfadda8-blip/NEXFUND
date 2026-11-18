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
async function loadDashboard(){try{const me=await api("/api/auth/me");$("auth").classList.add("hidden");$("dashboard").classList.remove("hidden");$("userEmail").textContent=me.user.email;await loadPrograms();const data=await api("/api/dashboard");$("challengeList").innerHTML=data.challenges.length?data.challenges.map(c=>'<div class="item"><strong>'+escapeHtml(c.program_name)+'</strong><small>الحالة: '+escapeHtml(c.status)+' · الرصيد: '+money(c.current_balance)+' · المنصة: '+escapeHtml(c.platform||"MT5")+(c.account_login?' · Server: '+escapeHtml(c.server_name||"NEXFUND")+' · Login: '+escapeHtml(c.account_login):' · حساب MT5 بانتظار التجهيز')+'</small></div>').join(""):'<p class="empty">لم تختر حساب تقييم بعد. اختر إحدى الباقات أدناه للبدء.</p>';$("notifications").innerHTML=data.notifications.length?data.notifications.map(n=>'<div class="item"><strong>'+escapeHtml(n.title)+'</strong><small>'+escapeHtml(n.body)+'</small></div>').join(""):'<p class="empty">لا توجد إشعارات.</p>';}catch(error){$("auth").classList.remove("hidden");$("dashboard").classList.add("hidden");}}
$("logoutBtn").addEventListener("click",async()=>{try{await api("/api/auth/logout",{method:"POST",body:"{}"});}finally{$("dashboard").classList.add("hidden");$("auth").classList.remove("hidden");$("password").value="";}});
loadDashboard();