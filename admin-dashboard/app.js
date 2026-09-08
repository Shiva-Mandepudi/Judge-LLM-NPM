(() => {
  const secret = sessionStorage.getItem("judgeAdminSecret");
  if (!secret) { location.replace("/"); return; }

  const actor = sessionStorage.getItem("judgeAdminActor") || "dashboard-user";
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
  const date = (value) => value ? new Date(value).toLocaleString() : "—";
  const pct = (value) => value == null ? "—" : `${(Number(value) * 100).toFixed(1)}%`;
  const pretty = (value) => esc(JSON.stringify(value, null, 2));
  const api = async (url, options = {}) => {
    const response = await fetch(url, { ...options, headers: { "content-type": "application/json", "x-judge-admin-secret": secret, "x-judge-actor": actor, ...(options.headers || {}) } });
    if (response.status === 403) { sessionStorage.removeItem("judgeAdminSecret"); sessionStorage.removeItem("judgeAdminActor"); location.replace("/"); throw new Error("Access denied"); }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.details || body.error || `HTTP ${response.status}`);
    return body;
  };
  const signOut = () => { sessionStorage.removeItem("judgeAdminSecret"); sessionStorage.removeItem("judgeAdminActor"); location.replace("/"); };
  document.querySelectorAll("[data-nav]").forEach((link) => { if (location.pathname.endsWith(link.getAttribute("href"))) link.classList.add("active"); });
  $("menu-button")?.addEventListener("click", () => $("main-nav")?.classList.toggle("open"));
  $("sign-out")?.addEventListener("click", signOut);
  window.JudgeUI = { $, esc, date, pct, pretty, api, signOut };
})();
