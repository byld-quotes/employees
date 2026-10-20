/* BYLD Labour app — worker phone app and admin board in one page. Runs on Firebase's free Spark plan: no Storage, no Cloud Functions. */
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInAnonymously, signInWithEmailAndPassword, signOut, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, collection, query, where, orderBy, limit, onSnapshot, setDoc, addDoc, updateDoc, deleteDoc, getDoc, getDocs, serverTimestamp, writeBatch, arrayUnion, Timestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const CFG = self.BYLD_CONFIG;
const ADMINS = CFG.admins.map(e => e.toLowerCase());
const OFF = CFG.offDays || [5];
const fb = initializeApp(CFG.firebase);
const auth = getAuth(fb), db = getFirestore(fb);
const LOGO = document.getElementById("logo-tpl").innerHTML;
const MARK = document.getElementById("mark-tpl").innerHTML;
const BELL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';
const DOC_TYPES = ["Salary certificate", "Employment letter", "NOC", "Experience letter", "Payslip", "Copy of my contract", "Other"];
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const DOW = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

/* ---------- small helpers ---------- */
const $ = id => document.getElementById(id);
const val = id => ($(id)?.value ?? "").trim();
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const pad = n => String(n).padStart(2, "0");
const dubaiDate = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai" }).format(d);
const dubaiHM = d => d ? new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", hour: "2-digit", minute: "2-digit", hour12: false }).format(d) : "";
const pd = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
const iso = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const fd = s => { if (!s) return ""; const d = typeof s === "string" ? pd(s) : s; return d.getDate() + " " + MON[d.getMonth()]; };
const fdy = s => { if (!s) return ""; const d = typeof s === "string" ? pd(s) : s; return d.getDate() + " " + MON[d.getMonth()] + " " + d.getFullYear(); };
const ms = s => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); };
const days = (a, b) => Math.round((ms(b) - ms(a)) / 864e5) + 1;
const aed = n => "AED " + Math.round(n || 0).toLocaleString("en-US");
const tsDate = t => t?.toDate ? t.toDate() : (t instanceof Date ? t : null);
const when = t => { const d = tsDate(t); return d ? fd(dubaiDate(d)) + ", " + dubaiHM(d) : "just now"; };
const initials = n => (n || "?").split(/\s+/).filter(Boolean).map(x => x[0]).slice(0, 2).join("").toUpperCase();
const norm = s => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
const snapList = s => s.docs.map(d => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
function toast(m) { const t = $("toast"); t.textContent = m; t.classList.add("show"); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), 2800); }
function banner(title, text) { const p = $("push"); p.innerHTML = `<div class="pm">${MARK}</div><div><b>${esc(title)}</b><span>${esc(text)}</span></div>`; p.classList.add("show"); clearTimeout(banner.t); banner.t = setTimeout(() => p.classList.remove("show"), 5000); }
function fail(e) { console.error(e); toast(e?.code === "permission-denied" ? "You don't have permission to do that." : "Couldn't save. Check your connection and try again."); }
function distM(a, b, c, d) { const R = 6371000, r = x => x * Math.PI / 180; const dl = r(c - a), dn = r(d - b); const h = Math.sin(dl / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dn / 2) ** 2; return Math.round(2 * R * Math.asin(Math.sqrt(h))); }
const fmtDist = d => d == null ? "no site pin" : d < 1000 ? d + " m" : (d / 1000).toFixed(1) + " km";
function shrinkImage(file, max = 480) { return new Promise((res, rej) => { const rd = new FileReader(); rd.onerror = rej; rd.onload = () => { const img = new Image(); img.onerror = rej; img.onload = () => { const s = Math.min(1, max / Math.max(img.width, img.height)); const c = document.createElement("canvas"); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s); c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); res(c.toDataURL("image/jpeg", 0.55)); }; img.src = rd.result; }; rd.readAsDataURL(file); }); }
function emailAdmins(subject, message) {
  const e = CFG.emailjs || {};
  if (!e.serviceId || !window.emailjs) return;
  try { window.emailjs.send(e.serviceId, e.templateId, { subject, message, to_email: CFG.admins.join(","), app_link: location.href.split("#")[0] }, { publicKey: e.publicKey }).catch(() => {}); } catch (_) {}
}

/* ---------- files kept in the database (free plan has no file storage) ---------- */
const CHUNK = 700000; /* characters of base64 per part, under Firestore's 1 MB per document */
const readAsDataURL = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(f); });
async function saveFile(file, wid, kind) {
  const url = await readAsDataURL(file), b64 = url.slice(url.indexOf(",") + 1), n = Math.ceil(b64.length / CHUNK) || 1;
  const fref = doc(collection(db, "files"));
  for (let i = 0; i < n; i++) await setDoc(doc(db, "files", fref.id, "parts", String(i)), { wid, kind, n: i, d: b64.slice(i * CHUNK, (i + 1) * CHUNK) });
  await setDoc(fref, { wid, kind, name: file.name, type: file.type || "application/octet-stream", size: file.size, parts: n, createdAt: serverTimestamp() });
  return fref.id;
}
async function openFile(fileId, fileName) {
  toast("Opening…");
  const meta = await getDoc(doc(db, "files", fileId));
  if (!meta.exists()) { toast("That file is no longer available."); return; }
  const m = meta.data(), parts = await getDocs(query(collection(db, "files", fileId, "parts"), where("wid", "==", m.wid)));
  const b64 = parts.docs.map(d => d.data()).sort((a, b) => a.n - b.n).map(p => p.d).join("");
  const bin = atob(b64), bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: m.type }));
  const a = document.createElement("a"); a.href = url; a.target = "_blank"; a.rel = "noopener"; if (!/^(application\/pdf|image\/)/.test(m.type)) a.download = fileName || m.name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function moveFile(fileId, wid) {
  const parts = await getDocs(collection(db, "files", fileId, "parts"));
  const b = writeBatch(db); parts.docs.forEach(d => b.update(d.ref, { wid })); b.update(doc(db, "files", fileId), { wid }); await b.commit();
}
/* save a car's driver history and move its fines to whoever had the car on each fine's date */
async function saveAssignments(car, asg) {
  const next = { ...car, asg };
  await updateDoc(doc(db, "cars", car.id), { asg });
  for (const f of S.fines.filter(x => x.carId === car.id)) {
    const w = driverOn(next, f.date);
    if (w && w !== f.wid) { await updateDoc(doc(db, "fines", f.id), { wid: w }); if (f.fileId) await moveFile(f.fileId, w); }
  }
}
async function deleteFile(fileId) {
  if (!fileId) return;
  const parts = await getDocs(collection(db, "files", fileId, "parts"));
  const b = writeBatch(db); parts.docs.forEach(d => b.delete(d.ref)); b.delete(doc(db, "files", fileId)); await b.commit();
}

/* ---------- leave rules (UAE): leave year runs from the joining anniversary ---------- */
function todayD() { return pd(dubaiDate()); }
function monthsService(w) { if (!w?.joined) return 0; const a = pd(w.joined), t = todayD(); let m = (t.getFullYear() - a.getFullYear()) * 12 + (t.getMonth() - a.getMonth()); if (t.getDate() < a.getDate()) m--; return Math.max(0, m); }
function leaveYear(w) { const t = todayD(), j = w?.joined ? pd(w.joined) : t; let s = new Date(t.getFullYear(), j.getMonth(), j.getDate()); if (s > t) s = new Date(t.getFullYear() - 1, j.getMonth(), j.getDate()); if (s < j) s = j; const e = new Date(s.getFullYear() + 1, j.getMonth(), j.getDate() - 1); return { s, e }; }
function entitlement(w) { const m = monthsService(w); if (m < 6) return 0; if (m < 12) return m * 2; return 30; }
function usedIn(reqs, wid, type, s, e) { const S = iso(s), E = iso(e); return reqs.filter(r => r.wid === wid && r.type === type && r.status === "Approved" && r.from <= E && r.to >= S).reduce((t, r) => t + days(r.from < S ? S : r.from, r.to > E ? E : r.to), 0); }
function leaveLeft(w, reqs) { const y = leaveYear(w); return Math.max(0, entitlement(w) - usedIn(reqs, w.id, "Annual leave", y.s, y.e)); }
function sickUsed(w, reqs) { const y = leaveYear(w); return usedIn(reqs, w.id, "Sick leave", y.s, y.e); }
const stTag = s => `<span class="tag ${s === "Approved" || s === "Sent" ? "ok" : s === "Rejected" || s === "Declined" ? "bad" : "warn"}">${s === "Sent" ? "Ready in Documents" : esc(s)}</span>`;
const reqTitle = r => r.type === "Document" ? "Document · " + r.doc : r.type === "Loan" ? "Loan · " + aed(r.amount) : r.type === "Fine installment" ? "Fine installments · " + aed(r.amount) + " over " + r.months + " months" : r.type + " · " + fd(r.from) + (r.to !== r.from ? "–" + fd(r.to) : "");

/* ---------- state ---------- */
const S = { mode: "loading", user: null, unsubs: [], err: "", sheet: null, dlg: null, arm: null, info: "",
  dir: [], sites: [], link: null,
  me: null, att: null, reqs: [], loans: [], msgs: [], notices: [], seen: [], docs: [],
  wtab: "home", punch: null,
  tab: "today", workers: [], links: [], todayAtt: [], allSeen: [], compMode: "one", ts: null, tsMonth: dubaiDate().slice(0, 7), cars: [], fines: [] };
/* ---------- cars and fines ---------- */
const FINE_TYPES = ["Speeding", "Parking", "Red signal", "Salik", "Lane / overtaking", "Seatbelt", "Mobile phone", "Other"];
const FINE_ST = ["Unpaid", "Installments", "Paid by company", "Deducted from salary", "Waived"];
function driverOn(car, date) { let w = null; (car?.asg || []).slice().sort((a, b) => a.from.localeCompare(b.from)).forEach(x => { if (x.from <= date) w = x.wid; }); return w; }
const owed = f => f.status === "Unpaid" ? f.amount : f.status === "Installments" ? (f.remaining ?? f.amount) : 0;
const fineReq = f => S.reqs.find(r => r.type === "Fine installment" && r.fineId === f.id && r.status === "Pending");
function parseDate(t) {
  t = (t || "").trim(); let m;
  if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return iso(new Date(+m[1], m[2] - 1, +m[3]));
  if ((m = t.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/))) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return iso(new Date(y, m[2] - 1, +m[1])); }
  if ((m = t.match(/^(\d{1,2})[\s\-]([A-Za-z]{3})[A-Za-z]*[\s\-,]+(\d{2,4})$/))) { const mi = MON.findIndex(x => x.toLowerCase() === m[2].toLowerCase()); if (mi < 0) return null; const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; return iso(new Date(y, mi, +m[1])); }
  return null;
}
function stopAll() { S.unsubs.forEach(u => { try { u(); } catch (_) {} }); S.unsubs = []; }
function watch(q, fn) { S.unsubs.push(onSnapshot(q, fn, e => { console.error(e); if (e.code === "permission-denied" && S.mode === "worker") { } })); }
let renderQueued = false;
function render() { if (renderQueued) return; renderQueued = true; requestAnimationFrame(() => { renderQueued = false; draw(); }); }

/* ---------- auth ---------- */
onAuthStateChanged(auth, async user => {
  stopAll(); S.user = user; S.sheet = null; S.dlg = null; S.err = "";
  if (!user) { S.mode = "loading"; draw(); try { await signInAnonymously(auth); } catch (e) { S.mode = "error"; S.info = "Couldn't connect. Check your internet and reload."; draw(); } return; }
  if (!user.isAnonymous) {
    if (ADMINS.includes((user.email || "").toLowerCase())) { S.mode = "admin"; startAdmin(); }
    else { S.mode = "notadmin"; }
    draw(); return;
  }
  /* worker phone */
  S.mode = "loading"; draw();
  watch(collection(db, "sites"), s => { S.sites = snapList(s); render(); });
  watch(doc(db, "links", user.uid), s => {
    const had = S.link;
    S.link = s.exists() ? { id: s.id, ...s.data() } : null;
    if (!S.link) { if (had) S.info = "The office reset this phone. Log in again."; startLogin(); }
    else if (S.link.status === "approved") { if (S.mode !== "worker") startWorker(S.link.wid); }
    else { S.mode = "waiting"; render(); }
  });
});
let dirUnsub = null;
function startLogin() {
  S.mode = "login";
  if (!dirUnsub) { dirUnsub = onSnapshot(collection(db, "directory"), s => { S.dir = snapList(s).filter(d => d.active !== false); render(); }, e => console.error(e)); S.unsubs.push(() => { dirUnsub && dirUnsub(); dirUnsub = null; }); }
  render();
}

/* ---------- worker data ---------- */
let workerSubs = [];
function startWorker(wid) {
  workerSubs.forEach(u => u()); workerSubs = [];
  S.mode = "worker"; S.wid = wid;
  const w = (q, fn) => { const u = onSnapshot(q, fn, e => console.error(e)); workerSubs.push(u); S.unsubs.push(u); };
  w(doc(db, "workers", wid), s => { S.me = s.exists() ? { id: s.id, ...s.data() } : null; render(); });
  w(doc(db, "attendance", wid + "_" + dubaiDate()), s => { S.att = s.exists() ? s.data({ serverTimestamps: "estimate" }) : null; render(); });
  w(query(collection(db, "requests"), where("wid", "==", wid)), s => { S.reqs = snapList(s); render(); });
  w(query(collection(db, "loans"), where("wid", "==", wid)), s => { S.loans = snapList(s); render(); });
  w(query(collection(db, "messages"), where("wid", "==", wid)), s => { const old = S.msgs.length; S.msgs = snapList(s).sort((a, b) => (tsDate(b.createdAt) || 0) - (tsDate(a.createdAt) || 0)); render(); });
  w(query(collection(db, "notices"), orderBy("createdAt", "desc"), limit(30)), s => { S.notices = snapList(s); render(); });
  w(doc(db, "noticeSeen", wid), s => { S.seen = s.exists() ? (s.data().ids || []) : []; render(); });
  w(query(collection(db, "fines"), where("wid", "==", wid)), s => { S.fines = snapList(s).sort((a, b) => b.date.localeCompare(a.date)); render(); });
  w(query(collection(db, "documents"), where("wid", "==", wid)), s => { S.docs = snapList(s).sort((a, b) => (tsDate(b.createdAt) || 0) - (tsDate(a.createdAt) || 0)); render(); });
  if (!getLS(seenKey())) setLS(seenKey(), String(Date.now()));
  bannerSince = Date.now();
  render();
}

/* ---------- admin data ---------- */
function startAdmin() {
  const w = watch;
  w(collection(db, "workers"), s => { S.workers = snapList(s).sort((a, b) => (a.name || "").localeCompare(b.name || "")); render(); });
  w(collection(db, "sites"), s => { S.sites = snapList(s).sort((a, b) => (a.name || "").localeCompare(b.name || "")); render(); });
  w(query(collection(db, "links"), where("status", "==", "pending")), s => { S.links = snapList(s); render(); });
  w(query(collection(db, "attendance"), where("date", "==", dubaiDate())), s => { S.todayAtt = snapList(s); render(); });
  w(query(collection(db, "requests"), orderBy("createdAt", "desc"), limit(500)), s => { S.reqs = snapList(s); render(); });
  w(collection(db, "loans"), s => { S.loans = snapList(s); render(); });
  w(query(collection(db, "messages"), orderBy("createdAt", "desc"), limit(300)), s => { S.msgs = snapList(s); render(); });
  w(query(collection(db, "notices"), orderBy("createdAt", "desc"), limit(50)), s => { S.notices = snapList(s); render(); });
  w(collection(db, "noticeSeen"), s => { S.allSeen = snapList(s); render(); });
  w(query(collection(db, "documents"), orderBy("createdAt", "desc"), limit(500)), s => { S.docs = snapList(s); render(); });
  w(collection(db, "cars"), s => { S.cars = snapList(s).sort((a, b) => (a.plate || "").localeCompare(b.plate || "")); render(); });
  w(query(collection(db, "fines"), orderBy("date", "desc"), limit(1000)), s => { S.fines = snapList(s); render(); });
  bannerSince = Date.now();
}
const wk = id => S.workers.find(w => w.id === id);
const wName = id => wk(id)?.name || id;
const siteOf = w => S.sites.find(s => s.id === w?.siteId);

/* ---------- updates (free plan: shown in the app, no phone pings) ---------- */
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(e => console.warn("sw", e));
const getLS = k => { try { return localStorage.getItem(k); } catch (_) { return null; } };
const setLS = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (_) {} };
const msOf = t => tsDate(t)?.getTime() || 0;
function workerUpdates() {
  const out = [];
  S.reqs.filter(r => r.status !== "Pending" && r.decidedAt).forEach(r => { const label = r.type === "Document" ? r.doc : r.type; out.push({ key: "r" + r.id + r.status, at: msOf(r.decidedAt), t: r.status === "Sent" ? label + " is ready" : label + " " + r.status.toLowerCase(), x: r.status === "Sent" ? "Open Documents to see it." : reqTitle(r) }); });
  S.fines.forEach(f => out.push({ key: "f" + f.id, at: msOf(f.createdAt), t: "New car fine: " + f.type, x: aed(f.amount) + " on " + fd(f.date) + " · " + f.plate }));
  S.docs.filter(d => !d.requestId).forEach(d => out.push({ key: "d" + d.id, at: msOf(d.createdAt), t: "New document: " + d.name, x: "Added by the office" }));
  S.msgs.forEach(m => out.push({ key: "m" + m.id, at: msOf(m.createdAt), t: "Message: " + m.title, x: m.text.slice(0, 80) }));
  S.notices.forEach(n => out.push({ key: "n" + n.id, at: msOf(n.createdAt), t: "General notice: " + n.title, x: n.text.slice(0, 80) }));
  return out.sort((a, b) => b.at - a.at).slice(0, 20);
}
const seenKey = () => "byld-seen-" + (S.mode === "admin" ? "admin" : S.wid);
function unseenCount() { const since = +getLS(seenKey()) || 0; return workerUpdates().filter(u => u.at > since).length; }
/* a banner when something new arrives while the app is open */
const bannered = new Set(); let bannerSince = Date.now();
function checkNew(items) { items.forEach(u => { if (u.at > bannerSince && !bannered.has(u.key)) { bannered.add(u.key); banner(u.t, u.x); } }); }
function adminPending() {
  const out = S.reqs.filter(r => r.status === "Pending").map(r => ({ key: "q" + r.id, at: msOf(r.createdAt), t: "New " + (r.type === "Document" ? "document" : r.type.toLowerCase()) + " request", x: wName(r.wid) + " · " + reqTitle(r) }));
  S.links.forEach(l => out.push({ key: "l" + l.id, at: msOf(l.at), t: "New phone waiting for approval", x: l.name + " · " + l.position }));
  return out.sort((a, b) => b.at - a.at);
}

/* ---------- drawing ---------- */
function draw() {
  const root = $("root");
  document.body.className = S.mode === "worker" || S.mode === "waiting" || S.mode === "login" ? "app-worker" : "";
  const keep = captureForm();
  if (S.mode === "loading") root.innerHTML = `<div class="center"><div class="spin" role="status" aria-label="Loading"></div></div>`;
  else if (S.mode === "error") root.innerHTML = `<div class="wrap"><div class="center">${LOGO}<h2>No connection</h2><p>${esc(S.info)}</p></div></div>`;
  else if (S.mode === "login") root.innerHTML = loginHTML();
  else if (S.mode === "adminLogin") root.innerHTML = adminLoginHTML();
  else if (S.mode === "notadmin") root.innerHTML = `<div class="wrap"><div class="center">${LOGO}<h2>Not an admin account</h2><p>${esc(auth.currentUser?.email || "")} can't open the office view.</p><button class="btn" data-a="logout">Log out</button></div></div>`;
  else if (S.mode === "waiting") root.innerHTML = `<div class="wrap"><div class="center">${LOGO}<h2>Waiting for the office</h2><p>You asked to use this phone as <b>${esc(S.link?.name)}</b>, ${esc(S.link?.position)}. The office needs to approve it once. This page opens by itself when they do.</p><div class="spin" aria-hidden="true"></div></div></div>`;
  else if (S.mode === "worker") root.innerHTML = `<div class="wrap">${workerHTML()}</div>`;
  else if (S.mode === "admin") root.innerHTML = `<div class="wrap">${adminTop()}${adminHTML()}</div>`;
  restoreForm(keep); afterDraw();
}
/* keep typed text when live data re-renders the page */
function captureForm() { const out = {}; document.querySelectorAll("#root input:not([type=file]), #root select, #root textarea").forEach(el => { if (el.id) out[el.id] = el.type === "checkbox" ? el.checked : el.value; }); const f = document.activeElement?.id; return { out, f }; }
function restoreForm(k) { for (const [id, v] of Object.entries(k.out)) { const el = $(id); if (el && !el.dataset.fresh) { if (el.type === "checkbox") el.checked = v; else el.value = v; } } if (k.f && $(k.f)) $(k.f).focus(); }
const photoURLs = {};
function afterDraw() {
  calcs();
  if (S.mode === "worker") checkNew(workerUpdates()); else if (S.mode === "admin") checkNew(adminPending());
  document.querySelectorAll("img[data-photo]").forEach(img => {
    const p = img.dataset.photo;
    if (photoURLs[p]) { img.src = photoURLs[p]; return; }
    getDoc(doc(db, "photos", p)).then(s => { if (s.exists()) { photoURLs[p] = s.data().data; img.src = photoURLs[p]; } }).catch(() => {});
  });
}

/* ---------- login screens ---------- */
function loginHTML() {
  const positions = [...new Set(S.dir.map(d => d.position).filter(Boolean))].sort();
  return `<div class="wrap"><div class="center">${LOGO}
    <h2>Welcome</h2><p>Type your name and choose your position. The office will approve this phone once.</p>
    ${S.info ? `<div class="note">${esc(S.info)}</div>` : ""}
    <label class="f" for="lg-name">Your full name<input id="lg-name" list="lg-names" autocomplete="name" placeholder="Mohammed Rafiq"></label>
    <datalist id="lg-names">${S.dir.map(d => `<option value="${esc(d.name)}">`).join("")}</datalist>
    <label class="f" for="lg-pos">Your position<select id="lg-pos"><option value="">Choose</option>${positions.map(p => `<option>${esc(p)}</option>`).join("")}</select></label>
    ${S.err ? `<div class="err">${esc(S.err)}</div>` : ""}
    <button class="btn pri" data-a="login">Continue</button>
    <button class="link" data-a="to-admin">Office login</button></div></div>`;
}
function adminLoginHTML() {
  return `<div class="wrap"><div class="center">${LOGO}<h2>Office login</h2><p>For ${CFG.admins.map(esc).join(", ")}.</p>
    <label class="f" for="al-email">Email<input id="al-email" type="email" autocomplete="username"></label>
    <label class="f" for="al-pass">Password<input id="al-pass" type="password" autocomplete="current-password"></label>
    ${S.err ? `<div class="err">${esc(S.err)}</div>` : ""}
    <button class="btn pri" data-a="admin-login">Log in</button>
    <div class="row-btns"><button class="link" data-a="reset-pass">Forgot password</button><button class="link" data-a="to-worker" style="margin-left:auto">Back to worker login</button></div></div></div>`;
}

/* ---------- worker screens ---------- */
function workerHTML() {
  const w = S.me;
  if (!w) return `<div class="center">${LOGO}<h2>Account not found</h2><p>Your account was removed. Ask the office.</p></div>`;
  const a = S.att, site = siteOf(w), now = new Date(), y = leaveYear(w);
  const unreadMsg = S.msgs.filter(m => !m.readAt).length + S.notices.filter(n => !S.seen.includes(n.id)).length;
  const loanBal = S.loans.reduce((s, l) => s + (l.amount || 0) - (l.paid || 0), 0);
  const fresh = S.reqs.filter(r => r.status !== "Pending" && !r.seenByWorker).length + S.docs.filter(d => !d.openedAt).length;
  let main = "";
  if (S.wtab === "home") {
    const tin = tsDate(a?.in?.at), tout = tsDate(a?.out?.at);
    const status = tout ? `Timed in ${dubaiHM(tin)} · out ${dubaiHM(tout)}` : tin ? `Timed in at ${dubaiHM(tin)}` : "Not timed in yet";
    const mine = S.reqs.slice().sort((x, z) => (tsDate(z.createdAt) || 0) - (tsDate(x.createdAt) || 0)).slice(0, 6);
    const ln = S.notices[0];
    main = `${ln ? `<button class="notice ${S.seen.includes(ln.id) ? "" : "fresh"}" data-notice="${ln.id}"><span class="nl">General notice${S.seen.includes(ln.id) ? "" : " · new"}</span><b>${esc(ln.title)}</b><span class="nx">${esc(ln.text.length > 90 ? ln.text.slice(0, 90) + "…" : ln.text)}</span></button>` : ""}
    <div class="clock"><div class="d">${DOW[now.getDay()]} ${now.getDate()} ${MON[now.getMonth()]} · ${esc(site?.name || "No site set")}</div><div class="t" id="clk">${dubaiHM(now)}</div><div class="st">${status}</div>
     <div class="punch"><button class="pbtn in" data-a="punch-in" aria-disabled="${!!a?.in}"><span>Time in</span><small>Selfie and location</small></button>
     <button class="pbtn out" data-a="punch-out" aria-disabled="${!a?.in || !!a?.out}"><span>Time out</span><small>Selfie and location</small></button></div></div>
    ${unreadMsg ? `<button class="act" data-wtab="msgs" style="background:var(--warn-bg);border-color:transparent"><span class="ic">✉</span>You have ${unreadMsg} unread message${unreadMsg > 1 ? "s or notices" : " or notice"}<span class="ar">›</span></button>` : ""}
    <div class="tiles"><div class="tile"><small>Annual leave left</small><strong>${leaveLeft(w, S.reqs)}</strong> <small style="display:inline">of ${entitlement(w)}</small></div>
     <div class="tile"><small>Sick days this year</small><strong>${sickUsed(w, S.reqs)}</strong></div>
     <div class="tile"><small>Loan balance</small><strong style="font-size:15px">${aed(loanBal)}</strong></div></div>
    <div class="lyear">${w.joined ? `Your leave year: <b>${fdy(y.s)} to ${fdy(y.e)}</b>. It starts again on your work anniversary.` : "The office hasn't entered your joining date yet."}</div>
    <div class="actions">
     <button class="act" data-a="s-annual"><span class="ic">✈</span>Apply for annual leave<span class="ar">›</span></button>
     <button class="act" data-a="s-sick"><span class="ic">✚</span>Apply for sick leave<span class="ar">›</span></button>
     <button class="act" data-a="s-absent"><span class="ic">◷</span>Request to be absent<span class="ar">›</span></button>
     <button class="act" data-a="s-loan"><span class="ic">◈</span>Request a loan<span class="ar">›</span></button>
     <button class="act" data-a="s-docreq"><span class="ic">▤</span>Request a document<span class="ar">›</span></button></div>
    ${myFinesHTML()}
    <div class="hist"><h4>My requests</h4>${mine.length ? mine.map(r => `<div class="hrow"><span>${esc(reqTitle(r))}</span>${stTag(r.status)}</div>`).join("") : `<p class="lock">No requests yet.</p>`}
    <p class="lock">Requests can't be edited or deleted once sent. Ask the office if something needs changing.</p></div>`;
  } else if (S.wtab === "msgs") {
    main = `<div class="sec-h"><h2>Messages</h2></div><div class="sub-h">General notices</div>
    <div class="list">${S.notices.length ? S.notices.map(n => `<button class="r msg ${S.seen.includes(n.id) ? "" : "unread"}" data-notice="${n.id}"><div class="main"><div class="t">${S.seen.includes(n.id) ? "" : '<span class="ndot"></span>'}${esc(n.title)}</div><div class="s">${esc(n.text.slice(0, 70))}${n.text.length > 70 ? "…" : ""}</div></div><span class="s">${esc(when(n.createdAt))}</span></button>`).join("") : `<div class="r"><div class="main s">No notices.</div></div>`}</div>
    <div class="sub-h">Personal messages · only you can see these</div>
    <div class="list">${S.msgs.length ? S.msgs.map(m => `<button class="r msg ${m.readAt ? "" : "unread"}" data-msg="${m.id}"><div class="main"><div class="t">${m.readAt ? "" : '<span class="ndot"></span>'}${esc(m.title)}</div><div class="s">${esc(m.text.slice(0, 70))}${m.text.length > 70 ? "…" : ""}</div></div><span class="s">${esc(when(m.createdAt))}</span></button>`).join("") : `<div class="r"><div class="main s">No messages yet.</div></div>`}</div>`;
  } else {
    const pend = S.reqs.filter(r => r.type === "Document" && r.status === "Pending");
    main = `<div class="sec-h"><h2>Documents</h2><button class="btn pri sm" data-a="s-docreq">Request a document</button></div>
    ${pend.length ? `<div class="list">${pend.map(r => `<div class="r"><div class="main"><div class="t">${esc(r.doc)}</div><div class="s">Requested · the office will upload it here</div></div>${stTag("Pending")}</div>`).join("")}</div>` : ""}
    <div class="list">${S.docs.length ? S.docs.map(x => `<div class="r"><div class="thumb">${esc((x.fileName || "").split(".").pop().slice(0, 4).toUpperCase() || "DOC")}</div><div class="main"><div class="t">${esc(x.name)}</div><div class="s">${esc(x.fileName)} · ${esc(when(x.createdAt))}</div></div><button class="btn sm" data-open="${x.id}">Open</button></div>`).join("") : `<div class="r"><div class="main s">No documents yet.</div></div>`}</div>
    <p class="lock">Documents are added by the office. You can open and save them, but not change or delete them.</p>`;
  }
  return `<div class="phone-stage"><div class="phone">
   <div class="ph-top">${LOGO}<button class="bell" data-a="s-notes" aria-label="Updates${unseenCount() ? ", " + unseenCount() + " new" : ""}">${BELL}${unseenCount() ? `<span class="dot">${unseenCount()}</span>` : ""}</button></div>
   <div class="me"><div class="av">${esc(initials(w.name))}</div><div><b>${esc(w.name)}</b><span>${esc(w.position)} · <span class="num">${esc(w.id)}</span></span></div></div>
   ${main}
   <nav class="wnav" aria-label="App sections">
    <button class="${S.wtab === "home" ? "on" : ""}" data-wtab="home"><span>⌂</span>Home</button>
    <button class="${S.wtab === "msgs" ? "on" : ""}" data-wtab="msgs"><span>✉${unreadMsg ? `<i>${unreadMsg}</i>` : ""}</span>Messages</button>
    <button class="${S.wtab === "docs" ? "on" : ""}" data-wtab="docs"><span>▤</span>Documents</button></nav>
   ${S.sheet ? sheetHTML() : ""}</div></div>`;
}
function myFinesHTML() {
  if (!S.fines.length) return "";
  const tot = S.fines.reduce((t, f) => t + owed(f), 0);
  return `<div class="hist"><h4>My car fines · ${aed(tot)} still owed</h4>${S.fines.map(f => { const pr = fineReq(f); return `<div class="fine-card">
   <div class="hrow" style="border:0;padding:0"><span><b>${esc(f.type)}</b> · ${aed(f.amount)}</span>${f.status === "Unpaid" ? '<span class="tag bad">Unpaid</span>' : f.status === "Installments" ? '<span class="tag warn">Installments</span>' : `<span class="tag ok">${esc(f.status)}</span>`}</div>
   <div class="s">${fd(f.date)}${f.time ? " " + esc(f.time) : ""}${f.place ? " · " + esc(f.place) : ""} · <span class="num">${esc(f.plate)}</span>${f.no ? " · fine no. " + esc(f.no) : ""}</div>
   ${f.status === "Installments" ? `<div class="calc">${aed(f.monthly)} a month · <b>${aed(f.remaining)} left</b></div>` : ""}
   <div class="row-btns">${f.fileId ? `<button class="btn sm" data-fineproof="${f.id}">See the fine</button>` : ""}${f.status === "Unpaid" ? (pr ? '<span class="tag warn">Installments requested</span>' : `<button class="btn sm pri" data-reqinst="${f.id}">Request installments</button>`) : ""}</div></div>`; }).join("")}</div>`;
}
function sheetHTML() {
  const sh = S.sheet, w = S.me; let body = "";
  const errLine = S.err ? `<div class="err">${esc(S.err)}</div>` : "";
  if (sh === "notes") {
    const since = +S.notesSince || 0, list = workerUpdates();
    body = `<h3>Updates</h3>
    <div class="list">${list.length ? list.map(u => `<div class="r"><div class="main"><div class="t">${u.at > since ? '<span class="ndot"></span>' : ""}${esc(u.t)}</div><div class="s">${esc(u.x)}</div></div><span class="s">${esc(when(new Date(u.at)))}</span></div>`).join("") : `<div class="r"><div class="main s">Nothing yet. Approvals, messages, notices and documents show up here.</div></div>`}</div>
    <p class="hint">Open the app to check for updates. The red number on the bell shows what's new since you last looked.</p>
    <div class="row-btns"><button class="btn grow" data-a="close">Close</button></div>`;
  } else if (sh === "in" || sh === "out") {
    const P = S.punch || {}, site = siteOf(w);
    const L = P.loc;
    body = `<h3>${sh === "in" ? "Time in" : "Time out"}</h3>
    <div class="cam"><div class="shot">${P.photo ? `<img src="${P.photo}" alt="Your photo">` : "No photo yet"}</div>
     <div style="display:flex;flex-direction:column;gap:6px;min-width:0"><label class="btn sm" for="cam-in" style="text-align:center">${P.photo ? "Retake selfie" : "Take selfie"}</label><input id="cam-in" class="sr" type="file" accept="image/*" capture="user"></div></div>
    <div class="loc ${L ? (L.dist == null ? "" : L.dist <= (site?.radius || CFG.defaultRadius) ? "ok" : "bad") : ""}">${P.locErr ? esc(P.locErr) : L ? `📍 ${L.dist == null ? "Location found" : fmtDist(L.dist) + " from " + esc(site.name) + (L.dist <= (site.radius || CFG.defaultRadius) ? " · on site" : " · outside site")} (±${Math.round(L.acc)} m)` : "Getting your location…"}</div>
    ${P.locErr ? `<button class="link" data-a="retry-loc">Try location again</button>` : ""}
    ${errLine}
    <div class="row-btns"><button class="btn grow" data-a="close">Cancel</button><button class="btn pri grow" data-a="confirm-punch" ${P.busy ? "disabled" : ""}>${P.busy ? "Saving…" : "Confirm " + (sh === "in" ? "time in" : "time out")}</button></div>`;
  } else if (["annual", "sick", "absent"].includes(sh)) {
    const t = { annual: "Apply for annual leave", sick: "Apply for sick leave", absent: "Request to be absent" }[sh], td = dubaiDate();
    body = `<h3>${t}</h3>
    <div class="two"><label class="f" for="r-from">From<input id="r-from" type="date" value="${td}"></label><label class="f" for="r-to">To<input id="r-to" type="date" value="${td}"></label></div>
    ${sh === "annual" ? `<div class="calc" id="r-calc"></div>` : ""}
    ${sh === "sick" ? `<label class="f" for="r-cert">Medical certificate (photo or PDF)<input id="r-cert" type="file" accept="image/*,application/pdf"></label><div class="hint" id="cert-picked">${S.certFile ? "Selected: " + esc(S.certFile.name) : ""}</div>` : ""}
    <label class="f" for="r-why">Reason<textarea id="r-why" placeholder="${sh === "sick" ? "Fever, saw the clinic" : "Family visit"}"></textarea></label>
    ${errLine}<div class="row-btns"><button class="btn grow" data-a="close">Cancel</button><button class="btn pri grow" data-a="send-leave">Send request</button></div>`;
  } else if (sh === "loan") {
    body = `<h3>Request a loan</h3>
    <div class="two"><label class="f" for="l-amt">Amount (AED)<input id="l-amt" type="number" min="100" step="50" value="1000" inputmode="numeric"></label>
    <label class="f" for="l-mo">Pay back over<select id="l-mo">${[1, 2, 3, 4, 5, 6, 8, 10, 12].map(m => `<option ${m === 5 ? "selected" : ""} value="${m}">${m} month${m > 1 ? "s" : ""}</option>`).join("")}</select></label></div>
    <div class="calc" id="l-calc"></div>
    <label class="f" for="l-why">Reason<textarea id="l-why" placeholder="Sending money home"></textarea></label>
    ${errLine}<div class="row-btns"><button class="btn grow" data-a="close">Cancel</button><button class="btn pri grow" data-a="send-loan">Send request</button></div>`;
  } else if (sh.startsWith("inst:")) {
    const f = S.fines.find(x => x.id === sh.slice(5)) || { amount: 0, type: "", date: dubaiDate() };
    body = `<h3>Request installments</h3><div class="hint">${esc(f.type)} fine of ${aed(f.amount)} on ${fd(f.date)}</div>
    <label class="f" for="in-mo">Pay it over<select id="in-mo">${[2, 3, 4, 5, 6].map(m => `<option value="${m}" ${m === 3 ? "selected" : ""}>${m} months</option>`).join("")}</select></label>
    <div class="calc" id="in-calc"></div>
    <label class="f" for="in-why">Reason<textarea id="in-why" placeholder="Can't pay it all this month"></textarea></label>
    ${errLine}<div class="row-btns"><button class="btn grow" data-a="close">Cancel</button><button class="btn pri grow" data-a="send-inst">Send request</button></div>`;
  } else if (sh === "docreq") {
    body = `<h3>Request a document</h3>
    <label class="f" for="d-type">Document<select id="d-type">${DOC_TYPES.map(t => `<option>${t}</option>`).join("")}</select></label>
    <label class="f" for="d-other">If other, which document?<input id="d-other" placeholder="Leave salary letter"></label>
    <label class="f" for="d-why">What is it for?<textarea id="d-why" placeholder="For opening a bank account"></textarea></label>
    ${errLine}<div class="row-btns"><button class="btn grow" data-a="close">Cancel</button><button class="btn pri grow" data-a="send-doc">Send request</button></div>`;
  } else if (sh.startsWith("notice:")) {
    const n = S.notices.find(x => x.id === sh.slice(7)) || { title: "", text: "" };
    body = `<span class="tag warn" style="align-self:flex-start">General notice · all workers</span><h3>${esc(n.title)}</h3><div class="hint">From the office · ${esc(when(n.createdAt))}</div><div class="msgbody">${esc(n.text)}</div><div class="row-btns"><button class="btn pri grow" data-a="close">Got it</button></div>`;
  } else if (sh.startsWith("msg:")) {
    const m = S.msgs.find(x => x.id === sh.slice(4)) || { title: "", text: "" };
    body = `<h3>${esc(m.title)}</h3><div class="hint">From the office · ${esc(when(m.createdAt))}</div><div class="msgbody">${esc(m.text)}</div><div class="row-btns"><button class="btn pri grow" data-a="close">Got it</button></div>`;
  }
  return `<div class="scrim" data-a="scrim"><div class="sheet" role="dialog" aria-modal="true">${body}</div></div>`;
}
function calcs() {
  const ic = $("in-calc");
  if (ic && S.sheet?.startsWith("inst:")) { const f = S.fines.find(x => x.id === S.sheet.slice(5)), m = +val("in-mo") || 3; if (f) ic.innerHTML = `About <b>${aed(Math.ceil(f.amount / m))} a month</b> taken from salary for ${m} months. The office decides the final plan.`; }
  const fm = $("fi-match");
  if (fm && S.dlg?.k === "fine") { const c = S.cars.find(x => x.id === val("fi-car")), d = val("fi-date"), w = c && d ? driverOn(c, d) : null; fm.innerHTML = w ? `Goes to <b>${esc(wName(w))}</b> · he had ${esc(c.plate)} on ${fd(d)}` : c ? "Nobody had this car on that date" : "Add a car first"; fm.style.color = w ? "" : "var(--bad)"; }
  const c = $("r-calc");
  if (c && S.me) { const f = val("r-from"), t = val("r-to"); if (f && t && t >= f) { const n = days(f, t), left = leaveLeft(S.me, S.reqs); c.innerHTML = `${n} day${n > 1 ? "s" : ""} requested · you have ${left} left this leave year · <b>${left - n} after this</b>`; c.style.color = left - n < 0 ? "var(--bad)" : ""; } else c.textContent = "Pick the start and end dates"; }
  const l = $("l-calc");
  if (l) { const a = +val("l-amt") || 0, m = +val("l-mo") || 1; l.innerHTML = `Deducted from salary: <b>${aed(a / m)} per month</b> for ${m} month${m > 1 ? "s" : ""}`; }
}
function getLocation() {
  const P = S.punch; if (!P) return;
  P.loc = null; P.locErr = null; render();
  if (!navigator.geolocation) { P.locErr = "This phone can't share its location."; render(); return; }
  navigator.geolocation.getCurrentPosition(pos => {
    if (S.punch !== P) return;
    const site = siteOf(S.me), { latitude: lat, longitude: lng, accuracy: acc } = pos.coords;
    P.loc = { lat, lng, acc, dist: site?.lat != null ? distM(lat, lng, site.lat, site.lng) : null }; render();
  }, e => { if (S.punch !== P) return; P.locErr = e.code === 1 ? "Location is blocked. Allow location for this app in your phone settings, then try again." : "Couldn't get your location. Go outside or near a window and try again."; render(); }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
}

/* ---------- admin screens ---------- */
function adminTop() {
  return `<div class="bar"><div class="brand">${LOGO}<div class="sub"><h1>Labour app</h1><small>${esc(auth.currentUser?.email || "")}</small></div></div>
  <div class="row-btns"><button class="bell" data-a="a-notes" aria-label="Waiting for you${adminPending().length ? ", " + adminPending().length : ""}">${BELL}${adminPending().length ? `<span class="dot">${adminPending().length}</span>` : ""}</button><button class="btn sm" data-a="logout">Log out</button></div></div>`;
}
function adminHTML() {
  const pend = S.reqs.filter(r => r.status === "Pending" && r.type !== "Document").length, dpend = S.reqs.filter(r => r.status === "Pending" && r.type === "Document").length;
  const T = [["today", "Today"], ["requests", "Requests"], ["messages", "Messages"], ["documents", "Documents"], ["workers", "Workers"], ["loans", "Loans"], ["cars", "Cars and fines"], ["timesheet", "Monthly timesheet"]];
  const body = { today: aToday, requests: aReqs, messages: aMsgs, documents: aDocs, workers: aWorkers, loans: aLoans, cars: aCars, timesheet: aTs }[S.tab]();
  return `<div class="board"><div class="tabs" role="tablist">${T.map(([k, l]) => `<button class="tab ${S.tab === k ? "on" : ""}" data-tab="${k}" role="tab" aria-selected="${S.tab === k}">${l}${k === "requests" && pend ? `<span class="n">${pend}</span>` : ""}${k === "documents" && dpend ? `<span class="n">${dpend}</span>` : ""}${k === "workers" && S.links.length ? `<span class="n">${S.links.length}</span>` : ""}</button>`).join("")}</div>${body}</div>${S.dlg ? dlgHTML() : ""}`;
}
const armBtn = key => `<button class="btn sm del ${S.arm === key ? "armed" : ""}" data-arm="${key}">${S.arm === key ? "Tap again" : "Delete"}</button>`;
function aToday() {
  const active = S.workers.filter(w => w.active !== false), td = dubaiDate();
  const A = id => S.todayAtt.find(a => a.wid === id);
  const onLeave = id => S.reqs.find(r => r.wid === id && r.status === "Approved" && r.from && r.from <= td && r.to >= td);
  const ins = active.filter(w => A(w.id)?.in), leave = active.filter(w => !A(w.id)?.in && onLeave(w.id)), miss = active.filter(w => !A(w.id)?.in && !onLeave(w.id));
  const isOff = OFF.includes(todayD().getDay());
  const radius = w => siteOf(w)?.radius || CFG.defaultRadius;
  const dOf = w => { const s = siteOf(w), i = A(w.id).in; return s?.lat != null && i.lat != null ? distM(i.lat, i.lng, s.lat, s.lng) : null; };
  const off = ins.filter(w => dOf(w) != null && dOf(w) > radius(w)).length, pendAll = S.reqs.filter(r => r.status === "Pending").length + S.links.length;
  const row = w => {
    const a = A(w.id), lv = onLeave(w.id), site = siteOf(w);
    if (!a?.in) return `<div class="r"><div class="thumb ${isOff ? "" : "miss"}">${esc(initials(w.name))}</div><div class="main"><div class="t">${esc(w.name)}</div><div class="s">${esc(w.position)} · ${esc(site?.name || "No site")}</div></div>${lv ? `<span class="tag br">${esc(lv.type)}</span>` : isOff ? `<span class="tag">Day off</span>` : `<span class="tag bad">No time in</span>`}<button class="btn sm" data-edatt="${w.id}">Add time</button></div>`;
    const i = a.in, o = a.out;
    i.dist = site?.lat != null && i.lat != null ? distM(i.lat, i.lng, site.lat, site.lng) : null;
    return `<div class="r"><div class="thumb">${i.photo ? `<img data-photo="${w.id}_${td}_in" alt="Time-in photo of ${esc(w.name)}" data-big="${w.id}" style="cursor:zoom-in">` : esc(initials(w.name))}</div>
    <div class="main"><div class="t">${esc(w.name)}</div><div class="s">${esc(w.position)} · ${esc(site?.name || "No site")}${i.byAdmin ? " · time added by admin" : ""}</div></div>
    <div class="times"><span class="tag num">In ${dubaiHM(tsDate(i.at))}</span>${o ? `<span class="tag num">Out ${dubaiHM(tsDate(o.at))}</span>` : `<span class="tag warn">Still on site</span>`}
    ${i.dist != null ? `<span class="tag ${i.dist <= radius(w) ? "ok" : "bad"}">${fmtDist(i.dist)} from site</span>` : ""}
    ${i.lat != null ? `<a class="maplink" href="https://maps.google.com/?q=${i.lat},${i.lng}" target="_blank" rel="noopener">Map in</a>` : ""}${o?.lat != null ? `<a class="maplink" href="https://maps.google.com/?q=${o.lat},${o.lng}" target="_blank" rel="noopener">Map out</a>` : ""}
    <button class="btn sm" data-edatt="${w.id}">Edit</button></div></div>`;
  };
  const now = todayD();
  return `<div class="sec-h"><div><h2>${DOW[now.getDay()]} ${now.getDate()} ${MON[now.getMonth()]}</h2><p>Who's in, who isn't, and where they timed in from. Red distance means outside the site radius. Tap a photo to see it bigger.</p></div></div>
  ${S.links.length ? `<button class="notice fresh" data-tab="workers"><span class="nl">Phones waiting for approval</span><b>${S.links.length} new phone login${S.links.length > 1 ? "s" : ""}</b><span class="nx">Open Workers to approve them.</span></button>` : ""}
  <div class="stats"><div class="stat"><small>Timed in</small><strong>${ins.length}</strong></div><div class="stat ${miss.length && !isOff ? "bad" : ""}"><small>Not in yet</small><strong>${miss.length}</strong></div>
  <div class="stat"><small>On leave</small><strong>${leave.length}</strong></div><div class="stat ${off ? "bad" : ""}"><small>Outside site</small><strong>${off}</strong></div>
  <div class="stat ${pendAll ? "warn" : ""}"><small>Waiting for you</small><strong>${pendAll}</strong></div></div>
  <div class="list">${active.length ? [...miss, ...ins, ...leave].map(row).join("") : `<div class="r"><div class="main s">No workers yet. Add them in the Workers tab.</div></div>`}</div>`;
}
function reqLine(r) { const w = wk(r.wid); if (r.type === "Fine installment") { const f = S.fines.find(x => x.id === r.fineId); return `${f ? esc(f.type) + " fine on " + fd(f.date) + " · " + esc(f.plate) + " · " : ""}${aed(r.amount)} over ${r.months} months · about ${aed(Math.ceil(r.amount / r.months))}/month`; } return r.type === "Loan" ? `${aed(r.amount)} over ${r.months} months · ${aed(r.amount / r.months)}/month` : `${fd(r.from)}${r.to !== r.from ? " to " + fd(r.to) : ""} · ${days(r.from, r.to)} day${days(r.from, r.to) > 1 ? "s" : ""}${r.type === "Annual leave" && w ? " · " + leaveLeft(w, S.reqs) + " left this leave year" : ""}`; }
function aReqs() {
  const list = S.reqs.filter(r => r.type !== "Document").sort((a, b) => (a.status !== "Pending") - (b.status !== "Pending") || (tsDate(b.createdAt) || 0) - (tsDate(a.createdAt) || 0));
  return `<div class="sec-h"><div><h2>Requests</h2><p>Approving annual leave takes it off that worker's balance for their current leave year. Workers are notified either way.</p></div></div>
  <div class="list">${list.length ? list.map(r => `<div class="r"><div class="main"><div class="t">${esc(wName(r.wid))} · ${esc(r.type)}</div><div class="s">${reqLine(r)}${r.reason ? " · " + esc(r.reason) : ""} · sent ${esc(when(r.createdAt))}</div></div>
   ${r.certFileId ? `<button class="btn sm" data-cert="${r.id}">Certificate</button>` : ""}
   ${r.status === "Pending" ? `<div class="row-btns"><button class="btn sm okb" data-ok="${r.id}">Approve</button><button class="btn sm nob" data-no="${r.id}">Reject</button></div>` : stTag(r.status)}
   <button class="btn sm" data-edreq="${r.id}">Edit</button></div>`).join("") : `<div class="r"><div class="main s">No requests yet.</div></div>`}</div>`;
}
function aMsgs() {
  const gen = S.compMode === "all", active = S.workers.filter(w => w.active !== false);
  const seenCount = id => S.allSeen.filter(s => (s.ids || []).includes(id) && active.some(w => w.id === s.id)).length;
  return `<div class="sec-h"><div><h2>Messages and notices</h2><p>A personal message goes to one worker only. A general notice goes to everyone and stays pinned on their home screen until you post a newer one. Phones are notified either way.</p></div></div>
  <form class="compose" id="compose" novalidate>
   <label class="f" for="c-mode">Send as<select id="c-mode"><option value="one" ${gen ? "" : "selected"}>Personal message · one worker</option><option value="all" ${gen ? "selected" : ""}>General notice · all workers</option></select></label>
   ${gen ? `<div class="f">To<div class="calc">All ${active.length} workers</div></div>` : `<label class="f" for="c-to">To<select id="c-to"><option value="">Choose a worker</option>${active.map(w => `<option value="${w.id}">${esc(w.name)} · ${esc(w.id)}</option>`).join("")}</select></label>`}
   <label class="f" for="c-title">Subject<input id="c-title" placeholder="${gen ? "Office closed for National Day" : "Visa medical booked"}"></label>
   <label class="f wide" for="c-text">Message<textarea id="c-text"></textarea></label>
   ${S.err && S.tab === "messages" ? `<div class="err wide">${esc(S.err)}</div>` : ""}
   <div class="row-btns wide"><button class="btn pri" type="submit">${gen ? "Post notice to all" : "Send message"}</button></div></form>
  <div class="sub-h">General notices</div>
  <div class="list">${S.notices.length ? S.notices.map(n => `<div class="r"><div class="main"><div class="t">${esc(n.title)}</div><div class="s">${esc(n.text.slice(0, 120))}${n.text.length > 120 ? "…" : ""} · ${esc(when(n.createdAt))}</div></div><span class="tag ${seenCount(n.id) >= active.length ? "ok" : "warn"}">Seen by ${seenCount(n.id)} of ${active.length}</span>${armBtn("ntc|" + n.id)}</div>`).join("") : `<div class="r"><div class="main s">No notices posted.</div></div>`}</div>
  <div class="sub-h">Personal messages</div>
  <div class="list">${S.msgs.length ? S.msgs.map(m => `<div class="r"><div class="main"><div class="t">${esc(wName(m.wid))} · ${esc(m.title)}</div><div class="s">${esc(m.text.slice(0, 120))}${m.text.length > 120 ? "…" : ""} · ${esc(when(m.createdAt))}</div></div>${m.readAt ? `<span class="tag ok">Seen ${esc(when(m.readAt))}</span>` : '<span class="tag warn">Not seen yet</span>'}${armBtn("msg|" + m.id)}</div>`).join("") : `<div class="r"><div class="main s">No messages sent yet.</div></div>`}</div>`;
}
function aDocs() {
  const pend = S.reqs.filter(r => r.type === "Document" && r.status === "Pending");
  return `<div class="sec-h"><div><h2>Documents</h2><p>Upload a document to a worker's account (payslips, contract copies, letters) or answer a document request. The worker is notified and can open it from their phone.</p></div><button class="btn pri sm" data-a="share-doc">Upload a document</button></div>
  <div class="sub-h">Requested by workers</div>
  <div class="list">${pend.length ? pend.map(r => `<div class="r"><div class="main"><div class="t">${esc(wName(r.wid))} · ${esc(r.doc)}</div><div class="s">${esc(r.reason || "")} · ${esc(when(r.createdAt))}</div></div><button class="btn sm okb" data-fulfil="${r.id}">Upload and send</button><button class="btn sm nob" data-no="${r.id}">Decline</button></div>`).join("") : `<div class="r"><div class="main s">No document requests waiting.</div></div>`}</div>
  <div class="sub-h">In workers' accounts</div>
  <div class="list">${S.docs.length ? S.docs.map(x => `<div class="r"><div class="thumb">${esc((x.fileName || "").split(".").pop().slice(0, 4).toUpperCase() || "DOC")}</div><div class="main"><div class="t">${esc(wName(x.wid))} · ${esc(x.name)}</div><div class="s">${esc(x.fileName)} · ${esc(when(x.createdAt))}${x.openedAt ? " · opened" : ""}</div></div><button class="btn sm" data-open="${x.id}">Open</button>${armBtn("doc|" + x.id)}</div>`).join("") : `<div class="r"><div class="main s">No documents uploaded yet.</div></div>`}</div>`;
}
function aWorkers() {
  const loanBal = id => S.loans.filter(l => l.wid === id).reduce((s, l) => s + (l.amount || 0) - (l.paid || 0), 0);
  return `<div class="sec-h"><div><h2>Workers</h2><p>Workers log in with their name and position. The first time, you approve their phone here. The joining date sets their leave year: 2 days a month after 6 months' service, 30 days a year after the first year.</p></div><button class="btn pri sm" data-a="addw">Add worker</button></div>
  ${S.links.length ? `<div class="sub-h">Phones waiting for approval</div><div class="list">${S.links.map(l => { const w = wk(l.wid); return `<div class="r"><div class="main"><div class="t">${esc(l.name)} · ${esc(l.position)}</div><div class="s">${w ? "Matches " + esc(w.name) + " (" + esc(w.id) + ")" : "No matching worker"}${w?.deviceUid ? " · this replaces their old phone" : ""} · ${esc(when(l.at))}<br>${esc((l.ua || "").slice(0, 90))}</div></div>${w ? `<button class="btn sm okb" data-linkok="${l.id}">Approve phone</button>` : ""}<button class="btn sm nob" data-linkno="${l.id}">Reject</button></div>`; }).join("")}</div>` : ""}
  <div class="sub-h">All workers</div>
  <div class="list">${S.workers.length ? S.workers.map(w => { const y = leaveYear(w), site = siteOf(w); return `<div class="r"><div class="thumb">${esc(initials(w.name))}</div><div class="main"><div class="t">${esc(w.name)}${w.active === false ? " · inactive" : ""}</div><div class="s"><span class="num">${esc(w.id)}</span> · ${esc(w.position)} · ${esc(site?.name || "No site")} · joined ${w.joined ? fdy(w.joined) : "not set"}</div>${w.joined ? `<div class="s">Leave year ${fdy(y.s)} – ${fdy(y.e)}</div>` : ""}</div>
  <div class="times"><span class="tag ${entitlement(w) ? "ok" : "warn"}">${entitlement(w) ? leaveLeft(w, S.reqs) + " of " + entitlement(w) + " days left" : "Not eligible yet"}</span>${loanBal(w.id) ? `<span class="tag br">Loan ${aed(loanBal(w.id))}</span>` : ""}<span class="tag ${w.deviceUid ? "ok" : ""}">${w.deviceUid ? "Phone linked" : "No phone yet"}</span><button class="btn sm" data-edw="${w.id}">Edit</button></div></div>`; }).join("") : `<div class="r"><div class="main s">No workers yet. Add the first one.</div></div>`}</div>
  <div class="sec-h"><div><h2>Storage</h2><p>The free plan holds 1 GB. Selfies are the biggest part: about 15 MB a month for 10 workers. Clear old ones once or twice a year; time records stay.</p></div><button class="btn sm" data-a="clean-photos">${S.arm === "clean" ? "Tap again to clear" : "Clear selfies older than 6 months"}</button></div>
  <div class="sec-h"><div><h2>Sites</h2><p>Pin each site so time-ins show how far away the worker was. Stand at the site and tap "Use my location", or paste the coordinates from Google Maps.</p></div><button class="btn sm" data-a="addsite">Add site</button></div>
  <div class="list">${S.sites.length ? S.sites.map(s => `<div class="r"><div class="main"><div class="t">${esc(s.name)}</div><div class="s">${s.lat != null ? `<span class="num">${(+s.lat).toFixed(5)}, ${(+s.lng).toFixed(5)}</span> · radius ${s.radius || CFG.defaultRadius} m` : "Not pinned yet"}</div></div><button class="btn sm" data-edsite="${s.id}">Edit</button></div>`).join("") : `<div class="r"><div class="main s">No sites yet.</div></div>`}</div>`;
}
function fineTag(f) { const st = f.status; return `<span class="tag ${st === "Unpaid" ? "bad" : st === "Installments" ? "warn" : st === "Waived" ? "" : "ok"}">${st === "Installments" ? aed(f.remaining) + " left" : esc(st)}</span>`; }
function aCars() {
  const open = S.fines.filter(f => owed(f) > 0), mon = dubaiDate().slice(0, 7), td = dubaiDate();
  const byDriver = {}; open.forEach(f => { byDriver[f.wid] = (byDriver[f.wid] || 0) + owed(f); });
  const sorted = S.fines.slice().sort((a, b) => (owed(b) > 0) - (owed(a) > 0) || b.date.localeCompare(a.date));
  return `<div class="sec-h"><div><h2>Cars and fines</h2><p>Add each company car and assign it to a labourer or driver. When you add a fine, the app finds who had the car on that date and puts it on him. He sees his own fines and can ask to pay in installments; only the office can add, change or delete anything here.</p></div>
  <div class="row-btns"><button class="btn sm" data-a="car-import">Import list from Excel</button><button class="btn sm" data-a="car-add">Add car</button><button class="btn pri sm" data-a="fine-add">Add fine</button></div></div>
  <div class="stats"><div class="stat ${open.length ? "bad" : ""}"><small>Still owed</small><strong>${aed(open.reduce((t, f) => t + owed(f), 0))}</strong></div>
  <div class="stat"><small>On installments</small><strong>${S.fines.filter(f => f.status === "Installments").length}</strong></div>
  <div class="stat"><small>Fines this month</small><strong>${S.fines.filter(f => f.date.startsWith(mon)).length}</strong></div>
  <div class="stat"><small>Cars</small><strong>${S.cars.length}</strong></div></div>
  <div class="sub-h">Fines</div>
  <div class="list">${sorted.length ? sorted.map(f => { const pr = fineReq(f); return `<div class="r"><div class="main"><div class="t">${esc(f.wid ? wName(f.wid) : "No driver on record")} · ${aed(f.amount)} · ${esc(f.type)}</div><div class="s"><span class="num">${esc(f.plate)}</span> · ${fd(f.date)}${f.time ? " " + esc(f.time) : ""}${f.place ? " · " + esc(f.place) : ""}${f.no ? ` · fine no. <span class="num">${esc(f.no)}</span>` : ""}${f.status === "Installments" ? " · " + aed(f.monthly) + " a month" : ""}</div></div>
   ${pr ? `<button class="tag warn" data-tab="requests" style="border:0;cursor:pointer">Installments requested</button>` : ""}${fineTag(f)}${f.fileId ? `<button class="btn sm" data-fineproof="${f.id}">Proof</button>` : ""}<button class="btn sm" data-edfine="${f.id}">Edit</button></div>`; }).join("") : `<div class="r"><div class="main s">No fines yet.</div></div>`}</div>
  <div class="sub-h">Cars</div>
  <div class="list">${S.cars.length ? S.cars.map(c => { const d = driverOn(c, td), last = (c.asg || []).filter(x => x.from <= td).sort((a, b) => b.from.localeCompare(a.from))[0]; return `<div class="r"><div class="main"><div class="t num">${esc(c.plate)}</div><div class="s">${esc(c.model || "")}${(c.asg || []).length > 1 ? " · " + c.asg.length + " drivers on record" : ""}</div></div>
   <div class="times"><span class="tag br">${d ? esc(wName(d)) + " · since " + fd(last.from) : "Not assigned"}</span><button class="btn sm" data-reassign="${c.id}">Reassign</button><button class="btn sm" data-carhist="${c.id}">History</button><button class="btn sm" data-edcar="${c.id}">Edit</button></div></div>`; }).join("") : `<div class="r"><div class="main s">No cars yet. Add the first one.</div></div>`}</div>
  <div class="sub-h">Still owed by driver</div>
  <div class="list">${Object.keys(byDriver).length ? Object.entries(byDriver).sort((a, b) => b[1] - a[1]).map(([w, v]) => `<div class="r"><div class="main"><div class="t">${esc(wName(w))}</div><div class="s">${open.filter(f => f.wid === w).length} open fine${open.filter(f => f.wid === w).length > 1 ? "s" : ""}</div></div><span class="tag bad">${aed(v)}</span></div>`).join("") : `<div class="r"><div class="main s">Nothing owed.</div></div>`}</div>`;
}
function aLoans() {
  const open = S.loans.filter(l => l.amount > l.paid), tot = open.reduce((s, l) => s + l.amount - l.paid, 0);
  return `<div class="sec-h"><div><h2>Loans</h2><p>Approved loans and what's still owed. Update "paid" after each salary run.</p></div></div>
  <div class="stats"><div class="stat"><small>Total outstanding</small><strong>${aed(tot)}</strong></div><div class="stat"><small>Deductions this month</small><strong>${aed(open.reduce((s, l) => s + Math.min(l.amount / l.months, l.amount - l.paid), 0))}</strong></div></div>
  <div class="list">${S.loans.length ? S.loans.map(l => { const pct = Math.round((l.paid || 0) / l.amount * 100); return `<div class="r"><div class="main"><div class="t">${esc(wName(l.wid))}</div><div class="s">${aed(l.amount)} over ${l.months} months · ${aed(l.amount / l.months)} a month · paid ${aed(l.paid)}</div><div style="height:6px;background:var(--chip);border-radius:3px;margin-top:6px;max-width:320px"><div style="height:6px;width:${pct}%;background:var(--brand);border-radius:3px"></div></div></div><span class="tag br">${aed(l.amount - (l.paid || 0))} left</span><button class="btn sm" data-edloan="${l.id}">Edit</button></div>`; }).join("") : `<div class="r"><div class="main s">No loans yet.</div></div>`}</div>`;
}
function tsData() {
  const [y, m] = S.tsMonth.split("-").map(Number), last = new Date(y, m, 0).getDate(), td = dubaiDate(), ds = [];
  for (let d = 1; d <= last; d++) { const dt = new Date(y, m - 1, d), s = iso(dt); if (s > td) break; ds.push({ d, s, w: dt.getDay() }); }
  const att = S.ts?.month === S.tsMonth ? S.ts.rows : [];
  const mark = (wid, s, dow) => {
    const a = att.find(x => x.wid === wid && x.date === s);
    if (a?.in) return "P";
    const r = S.reqs.find(q => q.wid === wid && q.status === "Approved" && q.from && q.from <= s && q.to >= s);
    if (r) return r.type === "Sick leave" ? "S" : r.type === "Annual leave" ? "L" : "A";
    if (OFF.includes(dow)) return "O";
    return "A";
  };
  const hours = (wid) => att.filter(x => x.wid === wid && x.in?.at && x.out?.at).reduce((h, x) => h + (tsDate(x.out.at) - tsDate(x.in.at)) / 36e5, 0);
  return { ds, mark, hours, y, m };
}
function aTs() {
  const loaded = S.ts?.month === S.tsMonth;
  if (!loaded && !S.ts?.loading) loadTs();
  const { ds, mark, hours, y, m } = tsData(), ws = S.workers.filter(w => w.active !== false);
  return `<div class="sec-h"><div><h2>${MON[m - 1]} ${y} timesheet</h2><p>Built from time-ins and approved leave. ${OFF.map(d => DOW[d]).join(", ")} off. Download it for payroll at month end.</p></div>
  <div class="inline-form"><label class="f" for="ts-month">Month<input id="ts-month" type="month" value="${S.tsMonth}"></label><button class="btn sm" data-a="ts-csv">Download CSV</button></div></div>
  <div class="legend"><span><span class="m P">P</span> Present</span><span><span class="m A">A</span> Absent</span><span><span class="m L">L</span> Annual leave</span><span><span class="m S">S</span> Sick</span><span><span class="m O">–</span> Off</span></div>
  ${loaded ? `<div class="ts"><table><thead><tr><th class="nm">Worker</th>${ds.map(x => `<th class="num">${x.d}<br><span style="font-weight:400">${DOW[x.w][0]}</span></th>`).join("")}<th>Days</th><th>Abs</th><th>Hours</th></tr></thead><tbody>
  ${ws.map(w => { const k = ds.map(x => mark(w.id, x.s, x.w)); return `<tr><td class="nm">${esc(w.name)}</td>${k.map(c => `<td><span class="m ${c}">${c === "O" ? "–" : c}</span></td>`).join("")}<td class="num"><b>${k.filter(c => c === "P").length}</b></td><td class="num">${k.filter(c => c === "A").length}</td><td class="num">${hours(w.id).toFixed(1)}</td></tr>`; }).join("")}
  </tbody></table></div>` : `<div class="center" style="margin:0;border:0"><div class="spin" aria-label="Loading"></div></div>`}`;
}
async function loadTs() {
  const month = S.tsMonth; S.ts = { month: null, loading: true };
  try { const s = await getDocs(query(collection(db, "attendance"), where("date", ">=", month + "-01"), where("date", "<=", month + "-31"))); S.ts = { month, rows: snapList(s) }; }
  catch (e) { S.ts = { month: null }; fail(e); }
  render();
}

/* ---------- admin dialogs ---------- */
function delBtn() { return `<button class="btn del ${S.arm === "dlg" ? "armed" : ""}" data-a="dlg-del">${S.arm === "dlg" ? "Tap again to delete" : "Delete"}</button>`; }
function dlgHTML() {
  const d = S.dlg, errLine = S.err ? `<div class="err">${esc(S.err)}</div>` : ""; let h = "";
  if (d.k === "notes") {
    const list = adminPending();
    h = `<h3>Waiting for you</h3>
    <div class="list">${list.length ? list.map(u => `<div class="r"><div class="main"><div class="t">${esc(u.t)}</div><div class="s">${esc(u.x)}</div></div><span class="s">${esc(when(new Date(u.at)))}</span></div>`).join("") : `<div class="r"><div class="main s">Nothing waiting. You're all caught up.</div></div>`}</div>
    <p class="hint">${CFG.emailjs?.serviceId ? "Each new request and new phone is also emailed to " + CFG.admins.map(esc).join(", ") + "." : "Email alerts are off. Add your EmailJS details to firebase-config.js to get an email for every new request."}</p>
    <div class="row-btns"><button class="btn grow" data-a="dlg-close">Close</button></div>`;
  } else if (d.k === "worker") {
    const w = d.id ? wk(d.id) : { id: nextId(), name: "", position: "", siteId: S.sites[0]?.id || "", joined: "", active: true };
    h = `<h3>${d.id ? "Edit worker" : "Add worker"}</h3>
    <div class="two"><label class="f" for="w-name">Full name<input id="w-name" value="${esc(w.name)}" placeholder="Mohammed Rafiq"><span class="hint">Exactly as the worker will type it.</span></label><label class="f" for="w-id">Employee ID<input id="w-id" class="num" value="${esc(w.id)}" ${d.id ? "disabled" : ""}></label></div>
    <div class="two"><label class="f" for="w-pos">Position<input id="w-pos" value="${esc(w.position)}" placeholder="Site helper" list="pos-list"></label><label class="f" for="w-site">Site<select id="w-site"><option value="">No site</option>${S.sites.map(s => `<option value="${s.id}" ${s.id === w.siteId ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label></div>
    <datalist id="pos-list">${[...new Set(S.workers.map(x => x.position).filter(Boolean))].map(p => `<option value="${esc(p)}">`).join("")}</datalist>
    <div class="two"><label class="f" for="w-joined">Joining date<input id="w-joined" type="date" value="${esc(w.joined)}"><span class="hint">Sets their leave year and balance.</span></label><label class="f" for="w-active">Status<select id="w-active"><option value="1" ${w.active !== false ? "selected" : ""}>Active</option><option value="0" ${w.active === false ? "selected" : ""}>Inactive (left the company)</option></select></label></div>
    ${d.id && w.deviceUid ? `<button class="link" data-a="reset-phone">Reset their phone (they'll need approval again)</button>` : ""}
    ${errLine}<div class="row-btns">${d.id ? delBtn() : ""}<button class="btn grow" data-a="dlg-close">Cancel</button><button class="btn pri grow" data-a="save-w">${d.id ? "Save" : "Add worker"}</button></div>`;
  } else if (d.k === "site") {
    const s = d.id ? S.sites.find(x => x.id === d.id) : { name: "", lat: "", lng: "", radius: CFG.defaultRadius };
    h = `<h3>${d.id ? "Edit site" : "Add site"}</h3>
    <label class="f" for="s-name">Site name<input id="s-name" value="${esc(s.name)}" placeholder="Al Barsha villa"></label>
    <div class="two"><label class="f" for="s-lat">Latitude<input id="s-lat" class="num" value="${s.lat ?? ""}" placeholder="25.11240"></label><label class="f" for="s-lng">Longitude<input id="s-lng" class="num" value="${s.lng ?? ""}" placeholder="55.20010"></label></div>
    <button class="link" data-a="site-here">Use my location (stand at the site)</button>
    <label class="f" for="s-rad">Allowed radius (metres)<input id="s-rad" type="number" min="50" step="50" value="${s.radius || CFG.defaultRadius}"></label>
    ${errLine}<div class="row-btns">${d.id ? delBtn() : ""}<button class="btn grow" data-a="dlg-close">Cancel</button><button class="btn pri grow" data-a="save-site">Save</button></div>`;
  } else if (d.k === "req") {
    const r = S.reqs.find(x => x.id === d.id);
    h = `<h3>Edit ${esc(r.type.toLowerCase())} · ${esc(wName(r.wid))}</h3>
    ${r.type === "Loan" || r.type === "Fine installment" ? `<div class="two"><label class="f" for="e-amt">Amount (AED)<input id="e-amt" type="number" value="${r.amount}"></label><label class="f" for="e-mo">Months<input id="e-mo" type="number" min="1" value="${r.months}"></label></div>`
      : r.type === "Document" ? `<label class="f" for="e-doc">Document<input id="e-doc" value="${esc(r.doc)}"></label>`
      : `<div class="two"><label class="f" for="e-from">From<input id="e-from" type="date" value="${r.from}"></label><label class="f" for="e-to">To<input id="e-to" type="date" value="${r.to}"></label></div>`}
    <label class="f" for="e-st">Status<select id="e-st">${(r.type === "Document" ? ["Pending", "Sent", "Declined"] : ["Pending", "Approved", "Rejected"]).map(s => `<option ${s === r.status ? "selected" : ""}>${s}</option>`).join("")}</select></label>
    <label class="f" for="e-why">Reason<textarea id="e-why">${esc(r.reason)}</textarea></label>
    ${errLine}<div class="row-btns">${delBtn()}<button class="btn grow" data-a="dlg-close">Cancel</button><button class="btn pri grow" data-a="save-req">Save</button></div>`;
  } else if (d.k === "att") {
    const a = S.todayAtt.find(x => x.wid === d.id) || {};
    h = `<h3>Time for ${esc(wName(d.id))} · ${fd(dubaiDate())}</h3>
    <div class="two"><label class="f" for="a-in">Time in<input id="a-in" type="time" value="${a.in ? dubaiHM(tsDate(a.in.at)) : ""}"></label><label class="f" for="a-out">Time out<input id="a-out" type="time" value="${a.out ? dubaiHM(tsDate(a.out.at)) : ""}"></label></div>
    <p class="hint">Use this when a worker forgot to time in or their phone died. The record is marked "time added by admin".</p>
    ${errLine}<div class="row-btns">${a.in ? delBtn() : ""}<button class="btn grow" data-a="dlg-close">Cancel</button><button class="btn pri grow" data-a="save-att">Save</button></div>`;
  } else if (d.k === "fine") {
    const f = d.id ? S.fines.find(x => x.id === d.id) : { carId: S.cars[0]?.id || "", date: dubaiDate(), time: "", no: "", type: "Speeding", place: "", amount: "", status: "Unpaid" };
    h = `<h3>${d.id ? "Edit fine" : "Add fine"}</h3>
    <div class="two"><label class="f" for="fi-car">Car<select id="fi-car">${S.cars.map(c => `<option value="${c.id}" ${c.id === f.carId ? "selected" : ""}>${esc(c.plate)} · ${esc(c.model || "")}</option>`).join("")}</select></label><label class="f" for="fi-type">Type<select id="fi-type">${FINE_TYPES.map(t => `<option ${t === f.type ? "selected" : ""}>${t}</option>`).join("")}</select></label></div>
    <div class="two"><label class="f" for="fi-date">Date of offence<input id="fi-date" type="date" value="${f.date}"></label><label class="f" for="fi-time">Time<input id="fi-time" type="time" value="${esc(f.time)}"></label></div>
    <div class="calc" id="fi-match"></div>
    <div class="two"><label class="f" for="fi-no">Fine number<input id="fi-no" class="num" value="${esc(f.no)}" placeholder="RTA-77120345"></label><label class="f" for="fi-amt">Amount (AED)<input id="fi-amt" type="number" min="1" value="${f.amount}"></label></div>
    <div class="two"><label class="f" for="fi-place">Location<input id="fi-place" value="${esc(f.place)}" placeholder="Sheikh Zayed Rd"></label><label class="f" for="fi-st">Status<select id="fi-st">${FINE_ST.map(t => `<option ${t === f.status ? "selected" : ""}>${t}</option>`).join("")}</select></label></div>
    <div class="two"><label class="f" for="fi-mon">Installment per month (AED)<input id="fi-mon" type="number" value="${f.monthly ?? ""}" placeholder="Only for installments"></label><label class="f" for="fi-rem">Remaining (AED)<input id="fi-rem" type="number" value="${f.remaining ?? ""}" placeholder="Update after each salary"><span class="hint">You update this by hand after each deduction.</span></label></div>
    <label class="f" for="fi-file">Fine screenshot or PDF${f.fileId ? " (leave empty to keep the current one)" : ""}<input id="fi-file" type="file" accept="image/*,application/pdf"></label><div class="hint" id="fi-picked">${d.file ? "Selected: " + esc(d.file.name) : ""}</div>
    ${errLine}<div class="row-btns">${d.id ? delBtn() : ""}<button class="btn grow" data-a="dlg-close">Cancel</button><button class="btn pri grow" data-a="save-fine" ${d.busy ? "disabled" : ""}>${d.busy ? "Saving…" : "Save fine"}</button></div>`;
  } else if (d.k === "car") {
    const c = d.id ? S.cars.find(x => x.id === d.id) : null;
    h = `<h3>${c ? "Edit car" : "Add car"}</h3><div class="two"><label class="f" for="ca-plate">Plate<input id="ca-plate" class="num" value="${esc(c?.plate || "")}" placeholder="Dubai N 48213"></label><label class="f" for="ca-model">Make and model<input id="ca-model" value="${esc(c?.model || "")}" placeholder="Toyota Hiace"></label></div>
    ${c ? `<p class="hint">To change who drives it, use Reassign.</p>` : `<div class="two"><label class="f" for="ca-w">Assigned to<select id="ca-w"><option value="">Nobody yet</option>${S.workers.filter(w => w.active !== false).map(w => `<option value="${w.id}">${esc(w.name)} · ${esc(w.position)}</option>`).join("")}</select></label><label class="f" for="ca-from">From date<input id="ca-from" type="date" value="${dubaiDate()}"></label></div>`}
    ${errLine}<div class="row-btns">${c ? delBtn() : ""}<button class="btn grow" data-a="dlg-close">Cancel</button><button class="btn pri grow" data-a="save-car">${c ? "Save" : "Add car"}</button></div>`;
  } else if (d.k === "reassign") {
    const c = S.cars.find(x => x.id === d.id), cur = driverOn(c, dubaiDate());
    h = `<h3>Reassign ${esc(c.plate)}</h3><p class="hint">Now with ${cur ? esc(wName(cur)) : "nobody"}. The old assignment stays on record, so older fines still go to the right person.</p>
    <label class="f" for="ra-w">Give the car to<select id="ra-w">${S.workers.filter(w => w.active !== false).map(w => `<option value="${w.id}">${esc(w.name)} · ${esc(w.position)}</option>`).join("")}</select></label>
    <label class="f" for="ra-from">From date<input id="ra-from" type="date" value="${dubaiDate()}"></label>
    ${errLine}<div class="row-btns"><button class="btn grow" data-a="dlg-close">Cancel</button><button class="btn pri grow" data-a="save-reassign">Reassign</button></div>`;
  } else if (d.k === "carhist") {
    const c = S.cars.find(x => x.id === d.id), a = (c.asg || []).slice().sort((x, y) => y.from.localeCompare(x.from)), td = dubaiDate();
    h = `<h3>${esc(c.plate)} · who drove it</h3><div class="list">${a.length ? a.map((x, i) => `<div class="r"><div class="main"><div class="t">${esc(wName(x.wid))}</div><div class="s">From ${fdy(x.from)}${i ? " to " + fdy(new Date(pd(a[i - 1].from).getTime() - 864e5)) : x.from > td ? " · starts later" : " · now"}</div></div><button class="btn sm del ${S.arm === "asg|" + c.id + "|" + x.from ? "armed" : ""}" data-arm="asg|${c.id}|${x.from}">${S.arm === "asg|" + c.id + "|" + x.from ? "Tap again" : "Remove"}</button></div>`).join("") : `<div class="r"><div class="main s">Never assigned.</div></div>`}</div>
    <p class="hint">Remove an entry only if it was a mistake. Fines are re-matched to whoever had the car on their date.</p>
    <div class="row-btns"><button class="btn grow" data-a="dlg-close">Close</button></div>`;
  } else if (d.k === "carimport") {
    const rows = d.rows;
    h = `<h3>Import cars from Excel</h3>${rows ? `<div class="list">${rows.map(r => `<div class="r"><div class="main"><div class="t num">${esc(r.plate || "(no plate)")}</div><div class="s">${esc(r.model)}${r.wid ? " · " + esc(wName(r.wid)) + " from " + fdy(r.from) : ""}</div></div>${r.err ? `<span class="tag bad">${esc(r.err)}</span>` : '<span class="tag ok">Ready</span>'}</div>`).join("")}</div>
    <p class="hint">${rows.filter(r => !r.err).length} of ${rows.length} rows are ready. Rows with a problem are skipped; fix them in Excel and import them again.</p>
    <div class="row-btns"><button class="btn grow" data-a="ci-back">Back</button><button class="btn pri grow" data-a="ci-save" ${rows.some(r => !r.err) ? "" : "disabled"}>Import ${rows.filter(r => !r.err).length} car${rows.filter(r => !r.err).length === 1 ? "" : "s"}</button></div>`
    : `<p class="hint">In Excel, select four columns, Plate, Make and model, Driver's full name, Driving since (date), and copy them. Paste below, one car per row. Names must match the Workers list exactly. Leave the name empty for a car nobody drives yet.</p>
    <label class="f" for="ci-text">Paste here<textarea id="ci-text" style="min-height:160px" class="num"></textarea></label>
    ${errLine}<div class="row-btns"><button class="btn grow" data-a="dlg-close">Cancel</button><button class="btn pri grow" data-a="ci-go">Check rows</button></div>`}`;
  } else if (d.k === "loan") {
    const l = S.loans.find(x => x.id === d.id);
    h = `<h3>Loan · ${esc(wName(l.wid))}</h3>
    <div class="two"><label class="f" for="o-amt">Amount (AED)<input id="o-amt" type="number" value="${l.amount}"></label><label class="f" for="o-mo">Months<input id="o-mo" type="number" min="1" value="${l.months}"></label></div>
    <label class="f" for="o-paid">Paid so far (AED)<input id="o-paid" type="number" value="${l.paid || 0}"></label>
    ${errLine}<div class="row-btns">${delBtn()}<button class="btn grow" data-a="dlg-close">Cancel</button><button class="btn pri grow" data-a="save-loan">Save</button></div>`;
  } else if (d.k === "senddoc") {
    const r = d.rid ? S.reqs.find(x => x.id === d.rid) : null;
    h = `<h3>${r ? "Send " + esc(r.doc.toLowerCase()) + " to " + esc(wName(r.wid)) : "Upload a document"}</h3>
    <label class="f" for="u-w">Worker<select id="u-w" ${r ? "disabled" : ""}>${S.workers.filter(w => w.active !== false).map(w => `<option value="${w.id}" ${r && r.wid === w.id ? "selected" : ""}>${esc(w.name)} · ${esc(w.id)}</option>`).join("")}</select></label>
    <label class="f" for="u-name">Document name<input id="u-name" value="${r ? esc(r.doc) : ""}" placeholder="Payslip October 2026"></label>
    <label class="f" for="u-file">File (PDF or photo, up to 5 MB)<input id="u-file" type="file" accept="application/pdf,image/*"></label><div class="hint" id="u-picked">${d.file ? "Selected: " + esc(d.file.name) : ""}</div>
    ${errLine}<div class="row-btns"><button class="btn grow" data-a="dlg-close">Cancel</button><button class="btn pri grow" data-a="save-doc" ${d.busy ? "disabled" : ""}>${d.busy ? "Uploading…" : "Send to worker"}</button></div>`;
  } else if (d.k === "photo") {
    const a = S.todayAtt.find(x => x.wid === d.id);
    h = `<h3>${esc(wName(d.id))} · ${fd(dubaiDate())}</h3><div class="two">${a?.in?.photo ? `<figure style="margin:0"><img data-photo="${d.id}_${dubaiDate()}_in" alt="Time-in photo" style="border-radius:12px;width:100%;min-height:120px;background:var(--chip)"><figcaption class="hint">In ${dubaiHM(tsDate(a.in.at))}</figcaption></figure>` : ""}${a?.out?.photo ? `<figure style="margin:0"><img data-photo="${d.id}_${dubaiDate()}_out" alt="Time-out photo" style="border-radius:12px;width:100%;min-height:120px;background:var(--chip)"><figcaption class="hint">Out ${dubaiHM(tsDate(a.out.at))}</figcaption></figure>` : ""}</div><div class="row-btns"><button class="btn grow" data-a="dlg-close">Close</button></div>`;
  }
  return `<div class="fscrim" data-a="fscrim"><div class="dlg" role="dialog" aria-modal="true">${h}</div></div>`;
}
function nextId() { const n = S.workers.map(w => +(w.id.match(/(\d+)$/)?.[1] || 0)); return "BYLD-" + String((n.length ? Math.max(...n) : 0) + 1).padStart(3, "0"); }

/* ---------- events ---------- */
document.addEventListener("input", e => { if (e.target.closest(".sheet,.dlg,.center,#compose")) { calcs(); if (S.err) { S.err = ""; const x = document.querySelector(".err"); if (x) x.remove(); } } });
document.addEventListener("change", async e => {
  const t = e.target;
  if (t.id === "cam-in") { const f = t.files[0]; if (!f || !S.punch) return; try { S.punch.photo = await shrinkImage(f, 360); S.err = ""; render(); } catch (_) { toast("Couldn't read that photo. Try again."); } }
  if (t.id === "fi-file" && S.dlg) { S.dlg.file = t.files[0] || null; const h = $("fi-picked"); if (h) h.textContent = S.dlg.file ? "Selected: " + S.dlg.file.name : ""; }
  if (t.id === "u-file" && S.dlg) { S.dlg.file = t.files[0] || null; const h = $("u-picked"); if (h) h.textContent = S.dlg.file ? "Selected: " + S.dlg.file.name : ""; }
  if (t.id === "r-cert") { S.certFile = t.files[0] || null; const h = $("cert-picked"); if (h) h.textContent = S.certFile ? "Selected: " + S.certFile.name : ""; }
  if (t.id === "c-mode") { S.compMode = t.value; S.err = ""; render(); }
  if (t.id === "ts-month" && t.value) { S.tsMonth = t.value; S.ts = null; render(); }
});
document.addEventListener("keydown", e => { if (e.key === "Escape" && (S.dlg || S.sheet)) { S.dlg = null; S.sheet = null; S.punch = null; render(); } if (e.key === "Enter" && e.target.closest(".center") && e.target.tagName === "INPUT") { const b = document.querySelector(".center .btn.pri"); b && b.click(); } });
document.addEventListener("submit", async e => {
  if (e.target.id !== "compose") return; e.preventDefault();
  const title = val("c-title"), text = val("c-text");
  if (!title || !text) { S.err = "Write a subject and a message."; render(); return; }
  try {
    if (S.compMode === "one") { const to = val("c-to"); if (!to) { S.err = "Choose who the message is for."; render(); return; } await addDoc(collection(db, "messages"), { wid: to, title, text, createdAt: serverTimestamp(), by: auth.currentUser.email }); toast("Message sent to " + wName(to)); }
    else { await addDoc(collection(db, "notices"), { title, text, createdAt: serverTimestamp(), by: auth.currentUser.email }); toast("Notice posted to all workers"); }
    $("c-title").value = ""; $("c-text").value = ""; S.err = ""; render();
  } catch (err) { fail(err); }
});

document.addEventListener("click", async e => {
  const t = e.target, on = sel => t.closest(sel);
  const tb = on("[data-tab]"); if (tb) { S.tab = tb.dataset.tab; S.err = ""; S.arm = null; render(); return; }
  const wt = on("[data-wtab]"); if (wt) { S.wtab = wt.dataset.wtab; S.sheet = null; render(); scrollTo(0, 0); return; }
  const mg = on("[data-msg]"); if (mg) { const m = S.msgs.find(x => x.id === mg.dataset.msg); S.sheet = "msg:" + m.id; render(); if (!m.readAt) updateDoc(doc(db, "messages", m.id), { readAt: serverTimestamp() }).catch(console.error); return; }
  const nt = on("[data-notice]"); if (nt) { const id = nt.dataset.notice; S.sheet = "notice:" + id; render(); if (!S.seen.includes(id)) setDoc(doc(db, "noticeSeen", S.wid), { ids: arrayUnion(id) }, { merge: true }).catch(console.error); return; }
  const op = on("[data-open]"); if (op) { const x = S.docs.find(d => d.id === op.dataset.open); try { await openFile(x.fileId, x.fileName); if (S.mode === "worker" && !x.openedAt) updateDoc(doc(db, "documents", x.id), { openedAt: serverTimestamp() }).catch(() => {}); } catch (err) { fail(err); } return; }
  const ce = on("[data-cert]"); if (ce) { const r = S.reqs.find(x => x.id === ce.dataset.cert); try { await openFile(r.certFileId, "certificate"); } catch (err) { fail(err); } return; }
  const bg = on("[data-big]"); if (bg) { S.dlg = { k: "photo", id: bg.dataset.big }; render(); return; }
  const ar = on("[data-arm]");
  if (ar) {
    const k = ar.dataset.arm; if (S.arm !== k) { S.arm = k; render(); return; } S.arm = null;
    const [ty, id, extra] = k.split("|");
    if (ty === "asg") { try { const c = S.cars.find(x => x.id === id); await saveAssignments(c, (c.asg || []).filter(x => x.from !== extra)); toast("Assignment removed"); } catch (err) { fail(err); } return; }
    try {
      if (ty === "msg") await deleteDoc(doc(db, "messages", id));
      if (ty === "ntc") await deleteDoc(doc(db, "notices", id));
      if (ty === "doc") { const x = S.docs.find(d => d.id === id); try { await deleteFile(x.fileId); } catch (_) {} await deleteDoc(doc(db, "documents", id)); }
      toast("Deleted");
    } catch (err) { fail(err); }
    return;
  }
  const ok = on("[data-ok]"), no = on("[data-no]");
  if (ok || no) {
    const r = S.reqs.find(x => x.id === (ok || no).dataset[ok ? "ok" : "no"]);
    const status = ok ? "Approved" : r.type === "Document" ? "Declined" : "Rejected";
    try {
      const b = writeBatch(db);
      b.update(doc(db, "requests", r.id), { status, decidedAt: serverTimestamp(), decidedBy: auth.currentUser.email });
      if (ok && r.type === "Fine installment" && S.fines.some(f => f.id === r.fineId)) b.update(doc(db, "fines", r.fineId), { status: "Installments", monthly: Math.ceil(r.amount / r.months), remaining: r.amount, updatedAt: serverTimestamp() });
      if (ok && r.type === "Loan") b.set(doc(collection(db, "loans")), { wid: r.wid, amount: r.amount, months: r.months, paid: 0, requestId: r.id, createdAt: serverTimestamp() });
      await b.commit(); toast(`${r.type} ${status.toLowerCase()} for ${wName(r.wid)}`);
    } catch (err) { fail(err); }
    return;
  }
  const lo = on("[data-linkok]");
  if (lo) {
    const l = S.links.find(x => x.id === lo.dataset.linkok), w = wk(l.wid);
    try { const b = writeBatch(db); b.update(doc(db, "links", l.id), { status: "approved", approvedAt: serverTimestamp(), approvedBy: auth.currentUser.email }); b.update(doc(db, "workers", w.id), { deviceUid: l.id }); if (w.deviceUid && w.deviceUid !== l.id) b.delete(doc(db, "links", w.deviceUid)); await b.commit(); toast("Phone approved for " + w.name); } catch (err) { fail(err); }
    return;
  }
  const ln = on("[data-linkno]"); if (ln) { try { await deleteDoc(doc(db, "links", ln.dataset.linkno)); toast("Phone rejected"); } catch (err) { fail(err); } return; }
  const ew = on("[data-edw]"); if (ew) { S.dlg = { k: "worker", id: ew.dataset.edw }; S.arm = null; S.err = ""; render(); return; }
  const es = on("[data-edsite]"); if (es) { S.dlg = { k: "site", id: es.dataset.edsite }; S.arm = null; S.err = ""; render(); return; }
  const er = on("[data-edreq]"); if (er) { S.dlg = { k: "req", id: er.dataset.edreq }; S.arm = null; S.err = ""; render(); return; }
  const ea = on("[data-edatt]"); if (ea) { S.dlg = { k: "att", id: ea.dataset.edatt }; S.arm = null; S.err = ""; render(); return; }
  const ef = on("[data-edfine]"); if (ef) { S.dlg = { k: "fine", id: ef.dataset.edfine }; S.arm = null; S.err = ""; render(); return; }
  const ec = on("[data-edcar]"); if (ec) { S.dlg = { k: "car", id: ec.dataset.edcar }; S.arm = null; S.err = ""; render(); return; }
  const rs = on("[data-reassign]"); if (rs) { S.dlg = { k: "reassign", id: rs.dataset.reassign }; S.err = ""; render(); return; }
  const chh = on("[data-carhist]"); if (chh) { S.dlg = { k: "carhist", id: chh.dataset.carhist }; S.arm = null; render(); return; }
  const ri = on("[data-reqinst]"); if (ri) { S.sheet = "inst:" + ri.dataset.reqinst; S.err = ""; render(); return; }
  const fp = on("[data-fineproof]"); if (fp) { const f = S.fines.find(x => x.id === fp.dataset.fineproof); try { await openFile(f.fileId, "fine"); } catch (err) { fail(err); } return; }
  const el = on("[data-edloan]"); if (el) { S.dlg = { k: "loan", id: el.dataset.edloan }; S.arm = null; S.err = ""; render(); return; }
  const fu = on("[data-fulfil]"); if (fu) { S.dlg = { k: "senddoc", rid: fu.dataset.fulfil }; S.err = ""; render(); return; }

  const b = on("[data-a]"); if (!b) return; const a = b.dataset.a;
  try { await action(a, b, t); } catch (err) { fail(err); }
});

async function action(a, b, t) {
  switch (a) {
    case "scrim": if (t === b) { S.sheet = null; S.punch = null; render(); } return;
    case "fscrim": if (t === b) { S.dlg = null; render(); } return;
    case "close": S.sheet = null; S.punch = null; S.err = ""; render(); return;
    case "dlg-close": S.dlg = null; S.err = ""; S.arm = null; render(); return;
    case "logout": stopAll(); await signOut(auth); return;
    case "to-admin": S.mode = "adminLogin"; S.err = ""; render(); return;
    case "to-worker": S.mode = "login"; S.err = ""; render(); return;
    case "admin-login": {
      const em = val("al-email").toLowerCase(), pw = $("al-pass").value;
      if (!em || !pw) { S.err = "Enter your email and password."; render(); return; }
      if (!ADMINS.includes(em)) { S.err = "This email isn't an admin account."; render(); return; }
      try { await signInWithEmailAndPassword(auth, em, pw); } catch (err) { S.err = err.code === "auth/too-many-requests" ? "Too many tries. Wait a few minutes." : "Wrong email or password."; render(); }
      return;
    }
    case "reset-pass": { const em = val("al-email"); if (!em) { S.err = "Type your email first, then tap Forgot password."; render(); return; } try { await sendPasswordResetEmail(auth, em); toast("Password reset email sent"); } catch (_) { toast("Couldn't send the reset email."); } return; }
    case "login": {
      const name = norm(val("lg-name")), pos = norm(val("lg-pos"));
      if (!name || !pos) { S.err = "Type your name and choose your position."; render(); return; }
      const m = S.dir.filter(d => norm(d.name) === name && norm(d.position) === pos);
      if (!m.length) { S.err = "We couldn't find that name with that position. Check the spelling, or ask the office."; render(); return; }
      if (m.length > 1) { S.err = "Two workers match. Ask the office to log you in."; render(); return; }
      await setDoc(doc(db, "links", auth.currentUser.uid), { wid: m[0].id, name: m[0].name, position: m[0].position, status: "pending", at: serverTimestamp(), ua: navigator.userAgent.slice(0, 160) });
      S.info = ""; emailAdmins("New phone waiting for approval", `${m[0].name} (${m[0].position}) is asking to use a new phone. Approve it in the Workers tab.`);
      return;
    }
    /* worker */
    case "s-notes": S.notesSince = +getLS(seenKey()) || 0; setLS(seenKey(), String(Date.now())); S.sheet = "notes"; render(); return;
    case "a-notes": S.dlg = { k: "notes" }; render(); return;
    case "punch-in": case "punch-out": {
      const k = a === "punch-in" ? "in" : "out";
      if (b.getAttribute("aria-disabled") === "true") { toast(k === "in" ? "You already timed in today" : "Time in first"); return; }
      S.punch = { kind: k }; S.sheet = k; S.err = ""; render(); getLocation(); return;
    }
    case "retry-loc": getLocation(); return;
    case "confirm-punch": {
      const P = S.punch;
      if (!P.photo) { S.err = "Take a selfie first."; render(); return; }
      if (!P.loc) { S.err = P.locErr ? "Location is needed to time in. Try location again." : "Still getting your location. Wait a second."; render(); return; }
      P.busy = true; render();
      const id = S.wid + "_" + dubaiDate();
      try {
        await setDoc(doc(db, "photos", id + "_" + P.kind), { wid: S.wid, date: dubaiDate(), kind: P.kind, data: P.photo });
        const rec = { at: serverTimestamp(), lat: +P.loc.lat.toFixed(6), lng: +P.loc.lng.toFixed(6), acc: Math.round(P.loc.acc), photo: true };
        if (P.kind === "in") await setDoc(doc(db, "attendance", id), { wid: S.wid, date: dubaiDate(), siteId: S.me.siteId || "", in: rec });
        else await updateDoc(doc(db, "attendance", id), { out: rec });
        toast(P.kind === "in" ? "Timed in" : "Timed out"); S.sheet = null; S.punch = null; render();
      } catch (err) { P.busy = false; render(); fail(err); }
      return;
    }
    case "s-annual": case "s-sick": case "s-absent": case "s-loan": case "s-docreq": S.sheet = a.slice(2); S.err = ""; S.certFile = null; render(); return;
    case "send-leave": {
      const f = val("r-from"), to = val("r-to"), why = val("r-why"), kind = S.sheet;
      if (!f || !to) { S.err = "Pick both dates."; render(); return; }
      if (to < f) { S.err = "The end date is before the start date."; render(); return; }
      if (kind === "annual" && days(f, to) > leaveLeft(S.me, S.reqs)) { S.err = "That's more days than you have left this leave year."; render(); return; }
      if (!why) { S.err = "Write a short reason."; render(); return; }
      const type = { annual: "Annual leave", sick: "Sick leave", absent: "Absent" }[kind];
      const data = { wid: S.wid, type, from: f, to, days: days(f, to), reason: why, status: "Pending", createdAt: serverTimestamp() };
      const file = kind === "sick" ? S.certFile : null;
      b.disabled = true; b.textContent = "Sending…";
      if (file) { if (file.size > 5 * 1024 * 1024) { S.err = "The certificate must be under 5 MB."; b.disabled = false; render(); return; } data.certFileId = await saveFile(file, S.wid, "cert"); }
      await addDoc(collection(db, "requests"), data);
      emailAdmins(`New ${type.toLowerCase()} request`, `${S.me.name}: ${fd(f)}${to !== f ? " to " + fd(to) : ""} · ${why}`);
      S.sheet = null; toast("Request sent to the office"); render(); return;
    }
    case "send-loan": {
      const amt = +val("l-amt"), mo = +val("l-mo"), why = val("l-why");
      if (!amt || amt < 100) { S.err = "Enter an amount of at least AED 100."; render(); return; }
      if (!why) { S.err = "Write a short reason."; render(); return; }
      b.disabled = true;
      await addDoc(collection(db, "requests"), { wid: S.wid, type: "Loan", amount: amt, months: mo, reason: why, status: "Pending", createdAt: serverTimestamp() });
      emailAdmins("New loan request", `${S.me.name}: ${aed(amt)} over ${mo} months · ${why}`);
      S.sheet = null; toast("Loan request sent to the office"); render(); return;
    }
    case "send-inst": {
      const f = S.fines.find(x => x.id === S.sheet.slice(5)), m = +val("in-mo"), why = val("in-why");
      if (!f) { S.sheet = null; render(); return; }
      if (!why) { S.err = "Write a short reason."; render(); return; }
      b.disabled = true;
      await addDoc(collection(db, "requests"), { wid: S.wid, type: "Fine installment", fineId: f.id, amount: f.amount, months: m, reason: why, status: "Pending", createdAt: serverTimestamp() });
      emailAdmins("New fine installment request", `${S.me.name}: ${f.type} fine of ${aed(f.amount)} (${f.plate}) over ${m} months · ${why}`);
      S.sheet = null; toast("Installment request sent to the office"); render(); return;
    }
    case "send-doc": {
      let ty = val("d-type"); const other = val("d-other"), why = val("d-why");
      if (ty === "Other") { if (!other) { S.err = "Write which document you need."; render(); return; } ty = other; }
      if (!why) { S.err = "Write what the document is for."; render(); return; }
      b.disabled = true;
      await addDoc(collection(db, "requests"), { wid: S.wid, type: "Document", doc: ty, reason: why, status: "Pending", createdAt: serverTimestamp() });
      emailAdmins("New document request", `${S.me.name}: ${ty} · ${why}`);
      S.sheet = null; toast("Document request sent to the office"); render(); return;
    }
    /* admin */
    case "clean-photos": {
      if (S.arm !== "clean") { S.arm = "clean"; render(); return; } S.arm = null;
      const cut = new Date(todayD()); cut.setMonth(cut.getMonth() - 6); const before = iso(cut); let total = 0;
      for (;;) { const s = await getDocs(query(collection(db, "photos"), where("date", "<", before), limit(400))); if (s.empty) break; const bt = writeBatch(db); s.docs.forEach(d => bt.delete(d.ref)); await bt.commit(); total += s.size; if (s.size < 400) break; }
      toast(total ? `Cleared ${total} selfie${total > 1 ? "s" : ""} from before ${fdy(before)}` : "No selfies older than 6 months"); render(); return;
    }
    case "addw": S.dlg = { k: "worker", id: null }; S.err = ""; render(); return;
    case "car-add": S.dlg = { k: "car", id: null }; S.err = ""; render(); return;
    case "car-import": S.dlg = { k: "carimport" }; S.err = ""; render(); return;
    case "ci-back": S.dlg.rows = null; render(); return;
    case "ci-go": {
      const text = $("ci-text").value; const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      if (!lines.length) { S.err = "Paste the rows from Excel first."; render(); return; }
      const seen = new Set(S.cars.map(c => norm(c.plate)));
      S.dlg.rows = lines.filter(l => !/^plate\b/i.test(l)).map(l => {
        const c = l.split(/\t|\s{2,}|;/).map(x => x.trim());
        const r = { plate: c[0] || "", model: c[1] || "", name: c[2] || "", since: c[3] || "" };
        if (!r.plate) r.err = "No plate";
        else if (seen.has(norm(r.plate))) r.err = "Already added";
        if (!r.err && r.name) { const m = S.workers.filter(w => norm(w.name) === norm(r.name)); if (m.length !== 1) r.err = m.length ? "Two workers with that name" : "Name not in Workers"; else r.wid = m[0].id; }
        if (!r.err && r.wid) { r.from = r.since ? parseDate(r.since) : dubaiDate(); if (!r.from) r.err = "Date not understood"; }
        if (!r.err) seen.add(norm(r.plate));
        return r;
      });
      render(); return;
    }
    case "ci-save": {
      const ok = S.dlg.rows.filter(r => !r.err); const bt = writeBatch(db);
      ok.forEach(r => bt.set(doc(collection(db, "cars")), { plate: r.plate, model: r.model, asg: r.wid ? [{ wid: r.wid, from: r.from }] : [], createdAt: serverTimestamp() }));
      await bt.commit(); toast(`Imported ${ok.length} car${ok.length === 1 ? "" : "s"}`); S.dlg = null; render(); return;
    }
    case "save-car": {
      const plate = val("ca-plate"), model = val("ca-model");
      if (!plate) { S.err = "Enter the plate number."; render(); return; }
      if (S.cars.some(c => c.id !== S.dlg.id && norm(c.plate) === norm(plate))) { S.err = "That plate is already added."; render(); return; }
      if (S.dlg.id) { await updateDoc(doc(db, "cars", S.dlg.id), { plate, model }); const bt = writeBatch(db); S.fines.filter(f => f.carId === S.dlg.id).forEach(f => bt.update(doc(db, "fines", f.id), { plate })); await bt.commit(); toast("Car saved"); }
      else { const w = val("ca-w"), from = val("ca-from"); if (w && !from) { S.err = "Pick the date he starts driving it."; render(); return; } await addDoc(collection(db, "cars"), { plate, model, asg: w ? [{ wid: w, from }] : [], createdAt: serverTimestamp() }); toast("Car added"); }
      S.dlg = null; S.err = ""; render(); return;
    }
    case "save-reassign": {
      const c = S.cars.find(x => x.id === S.dlg.id), w = val("ra-w"), from = val("ra-from");
      if (!from) { S.err = "Pick the date."; render(); return; }
      await saveAssignments(c, [...(c.asg || []).filter(x => x.from !== from), { wid: w, from }]);
      toast(c.plate + " is now with " + wName(w)); S.dlg = null; S.err = ""; render(); return;
    }
    case "fine-add":
      if (!S.cars.length) { toast("Add a car first"); return; }
      S.dlg = { k: "fine", id: null }; S.arm = null; S.err = ""; render(); return;
    case "save-fine": {
      const d = S.dlg, old = d.id ? S.fines.find(x => x.id === d.id) : null;
      const car = S.cars.find(x => x.id === val("fi-car"));
      const f = { carId: car?.id || "", plate: car?.plate || "", type: val("fi-type"), date: val("fi-date"), time: val("fi-time"), no: val("fi-no"), amount: +val("fi-amt"), place: val("fi-place"), status: val("fi-st") };
      if (!car) { S.err = "Choose the car."; render(); return; }
      if (!f.date || !(f.amount > 0)) { S.err = "Enter the date and the amount."; render(); return; }
      if (f.date > dubaiDate()) { S.err = "The date of the offence can't be in the future."; render(); return; }
      f.wid = driverOn(car, f.date);
      if (!f.wid) { S.err = "Nobody had this car on that date. Check the date, or the car's History."; render(); return; }
      const mon = val("fi-mon"), rem = val("fi-rem");
      if (f.status === "Installments") {
        f.monthly = +mon > 0 ? +mon : Math.ceil(f.amount / 3);
        f.remaining = rem === "" ? f.amount : +rem;
        if (!(f.remaining >= 0) || f.remaining > f.amount) { S.err = "Remaining must be between 0 and the fine amount."; render(); return; }
        if (f.remaining === 0) f.status = "Deducted from salary";
      } else { f.monthly = null; f.remaining = null; }
      if (d.file && d.file.size > 5 * 1024 * 1024) { S.err = "The file must be under 5 MB."; render(); return; }
      d.busy = true; render();
      try {
        if (d.file) { f.fileId = await saveFile(d.file, f.wid, "fine"); if (old?.fileId) deleteFile(old.fileId).catch(() => {}); }
        else if (old?.fileId && old.wid !== f.wid) await moveFile(old.fileId, f.wid);
        f.updatedAt = serverTimestamp();
        if (old) await updateDoc(doc(db, "fines", old.id), f);
        else await addDoc(collection(db, "fines"), { ...f, createdAt: serverTimestamp(), by: auth.currentUser.email });
        toast("Fine saved for " + wName(f.wid)); S.dlg = null; S.err = ""; render();
      } catch (err) { d.busy = false; render(); fail(err); }
      return;
    }
    case "addsite": S.dlg = { k: "site", id: null }; S.err = ""; render(); return;
    case "share-doc": S.dlg = { k: "senddoc", rid: null }; S.err = ""; render(); return;
    case "site-here": {
      if (!navigator.geolocation) { toast("This device can't share its location."); return; }
      toast("Getting your location…");
      navigator.geolocation.getCurrentPosition(p => { $("s-lat").value = p.coords.latitude.toFixed(6); $("s-lng").value = p.coords.longitude.toFixed(6); toast(`Location set (±${Math.round(p.coords.accuracy)} m)`); }, () => toast("Couldn't get your location."), { enableHighAccuracy: true, timeout: 20000 });
      return;
    }
    case "save-site": {
      const name = val("s-name"), lat = val("s-lat"), lng = val("s-lng"), rad = +val("s-rad") || CFG.defaultRadius;
      if (!name) { S.err = "Enter the site name."; render(); return; }
      if ((lat && isNaN(+lat)) || (lng && isNaN(+lng)) || (!!lat !== !!lng)) { S.err = "Enter both latitude and longitude as numbers, or leave both empty."; render(); return; }
      const data = { name, lat: lat ? +lat : null, lng: lng ? +lng : null, radius: rad };
      if (S.dlg.id) await setDoc(doc(db, "sites", S.dlg.id), data); else await addDoc(collection(db, "sites"), data);
      toast("Site saved"); S.dlg = null; render(); return;
    }
    case "save-w": {
      const d = { name: val("w-name"), position: val("w-pos"), siteId: val("w-site"), joined: val("w-joined"), active: val("w-active") === "1" };
      const id = S.dlg.id || val("w-id").toUpperCase();
      if (!d.name || !id) { S.err = "Enter the name and employee ID."; render(); return; }
      if (!/^[A-Z0-9-]+$/.test(id)) { S.err = "Use only letters, numbers and dashes in the ID."; render(); return; }
      if (!d.position) { S.err = "Enter the position. Workers choose it when they log in."; render(); return; }
      if (!d.joined) { S.err = "Enter the joining date. It sets the leave year."; render(); return; }
      if (d.joined > dubaiDate()) { S.err = "The joining date can't be in the future."; render(); return; }
      if (!S.dlg.id && wk(id)) { S.err = "That employee ID is already used."; render(); return; }
      if (S.workers.some(w => w.id !== id && norm(w.name) === norm(d.name) && norm(w.position) === norm(d.position))) { S.err = "Another worker has the same name and position. Add a middle name or initial so they can log in."; render(); return; }
      const bt = writeBatch(db);
      bt.set(doc(db, "workers", id), d, { merge: true });
      bt.set(doc(db, "directory", id), { name: d.name, position: d.position, active: d.active });
      await bt.commit(); toast(S.dlg.id ? "Worker saved" : "Worker added"); S.dlg = null; render(); return;
    }
    case "reset-phone": {
      const w = wk(S.dlg.id); const bt = writeBatch(db);
      if (w.deviceUid) bt.delete(doc(db, "links", w.deviceUid));
      bt.update(doc(db, "workers", w.id), { deviceUid: null });
      await bt.commit(); toast("Phone reset. They can log in again on any phone."); S.dlg = null; render(); return;
    }
    case "dlg-del": {
      if (S.arm !== "dlg") { S.arm = "dlg"; render(); return; }
      S.arm = null; const d = S.dlg;
      if (d.k === "worker") { const w = wk(d.id); const bt = writeBatch(db); bt.delete(doc(db, "workers", d.id)); bt.delete(doc(db, "directory", d.id)); if (w?.deviceUid) bt.delete(doc(db, "links", w.deviceUid)); await bt.commit(); toast("Worker deleted"); }
      if (d.k === "site") { await deleteDoc(doc(db, "sites", d.id)); toast("Site deleted"); }
      if (d.k === "req") { const r = S.reqs.find(x => x.id === d.id); if (r?.certFileId) { try { await deleteFile(r.certFileId); } catch (_) {} } await deleteDoc(doc(db, "requests", d.id)); toast("Request deleted"); }
      if (d.k === "att") { await deleteDoc(doc(db, "attendance", d.id + "_" + dubaiDate())); toast("Time record deleted"); }
      if (d.k === "loan") { await deleteDoc(doc(db, "loans", d.id)); toast("Loan deleted"); }
      if (d.k === "fine") { const f = S.fines.find(x => x.id === d.id); if (f?.fileId) { try { await deleteFile(f.fileId); } catch (_) {} } await deleteDoc(doc(db, "fines", d.id)); toast("Fine deleted"); }
      if (d.k === "car") { if (S.fines.some(f => f.carId === d.id)) { S.err = "This car has fines on record. Delete those fines first, or keep the car."; render(); return; } await deleteDoc(doc(db, "cars", d.id)); toast("Car deleted"); }
      S.dlg = null; render(); return;
    }
    case "save-req": {
      const r = S.reqs.find(x => x.id === S.dlg.id), up = { status: val("e-st"), reason: val("e-why") };
      if (r.type === "Loan" || r.type === "Fine installment") { up.amount = +val("e-amt"); up.months = +val("e-mo"); if (!up.amount || !up.months) { S.err = "Enter the amount and months."; render(); return; } }
      else if (r.type === "Document") { up.doc = val("e-doc"); }
      else { up.from = val("e-from"); up.to = val("e-to"); if (!up.from || !up.to || up.to < up.from) { S.err = "Check the dates."; render(); return; } up.days = days(up.from, up.to); }
      if (up.status !== r.status) { up.decidedAt = serverTimestamp(); up.decidedBy = auth.currentUser.email; }
      await updateDoc(doc(db, "requests", r.id), up); toast("Request saved"); S.dlg = null; render(); return;
    }
    case "save-att": {
      const i = val("a-in"), o = val("a-out"), wid = S.dlg.id, td = dubaiDate();
      if (!i) { S.err = "Enter at least the time in."; render(); return; }
      if (o && o < i) { S.err = "Time out is before time in."; render(); return; }
      const at = hm => Timestamp.fromDate(new Date(td + "T" + hm + ":00+04:00"));
      const cur = S.todayAtt.find(x => x.wid === wid) || {};
      const data = { wid, date: td, siteId: cur.siteId || wk(wid)?.siteId || "", in: { ...(cur.in || {}), at: at(i), byAdmin: true } };
      if (o) data.out = { ...(cur.out || {}), at: at(o), byAdmin: true };
      await setDoc(doc(db, "attendance", wid + "_" + td), data); toast("Time saved"); S.dlg = null; render(); return;
    }
    case "save-loan": {
      const l = S.loans.find(x => x.id === S.dlg.id), am = +val("o-amt"), mo = +val("o-mo"), paid = +val("o-paid");
      if (!am || !mo) { S.err = "Enter the amount and months."; render(); return; }
      if (paid < 0 || paid > am) { S.err = "Paid must be between 0 and the loan amount."; render(); return; }
      await updateDoc(doc(db, "loans", l.id), { amount: am, months: mo, paid }); toast("Loan saved"); S.dlg = null; render(); return;
    }
    case "save-doc": {
      const d = S.dlg, r = d.rid ? S.reqs.find(x => x.id === d.rid) : null, wid = r ? r.wid : val("u-w"), name = val("u-name"), file = d.file;
      if (!wid) { S.err = "Choose the worker."; render(); return; }
      if (!name) { S.err = "Enter the document name."; render(); return; }
      if (!file) { S.err = "Choose the file to upload."; render(); return; }
      if (file.size > 5 * 1024 * 1024) { S.err = "The file must be under 5 MB. Scan it in black and white or at a lower quality."; render(); return; }
      d.busy = true; render();
      try {
        const fileId = await saveFile(file, wid, "document");
        const bt = writeBatch(db);
        bt.set(doc(collection(db, "documents")), { wid, name, fileId, fileName: file.name, size: file.size, createdAt: serverTimestamp(), by: auth.currentUser.email, requestId: r?.id || null });
        if (r) bt.update(doc(db, "requests", r.id), { status: "Sent", decidedAt: serverTimestamp(), decidedBy: auth.currentUser.email });
        await bt.commit(); toast(name + " sent to " + wName(wid)); S.dlg = null; render();
      } catch (err) { d.busy = false; render(); fail(err); }
      return;
    }
    case "ts-csv": {
      if (S.ts?.month !== S.tsMonth) { toast("Still loading the month"); return; }
      const { ds, mark, hours } = tsData(), ws = S.workers.filter(w => w.active !== false);
      const rows = [["Employee ID", "Name", "Position", ...ds.map(x => x.s), "Present", "Absent", "Annual leave", "Sick", "Hours"]];
      ws.forEach(w => { const k = ds.map(x => mark(w.id, x.s, x.w)); rows.push([w.id, w.name, w.position, ...k.map(c => c === "O" ? "Off" : c), k.filter(c => c === "P").length, k.filter(c => c === "A").length, k.filter(c => c === "L").length, k.filter(c => c === "S").length, hours(w.id).toFixed(1)]); });
      const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
      const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" }));
      const link = document.createElement("a"); link.href = url; link.download = `BYLD-timesheet-${S.tsMonth}.csv`; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
      return;
    }
  }
}

/* live clock */
setInterval(() => { const c = $("clk"); if (c) c.textContent = dubaiHM(new Date()); }, 15000);
/* the date changes at midnight Dubai time: re-subscribe so "today" moves on */
let lastDay = dubaiDate();
setInterval(() => { const d = dubaiDate(); if (d !== lastDay) { lastDay = d; location.reload(); } }, 60000);
