import { useEffect, useState, type FormEvent } from "react";
import { Navigate, NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { api, ApiError, type AdminBusiness } from "../api";
import { todayIn } from "../dates";
import { useI18n } from "../i18n";
import { ErrorNote, Icon, LangSwitch, Spinner, useAction, useLoad } from "../ui";
import { BusinessDetail, CreateBusiness } from "./AdminBusiness";

interface Dashboard {
  month: string; businesses_total: number; businesses_active: number;
  totals: { total: number; confirmed: number; cancelled: number; completed: number; no_show: number };
  businesses: { id: string; name: string; active: boolean; total: number; confirmed: number; cancelled: number; completed: number; no_show: number }[];
}

export function AdminApp() {
  const [state, setState] = useState<"loading" | "in" | "out">("loading");
  const [username, setUsername] = useState("");

  useEffect(() => {
    api.get<{ username: string }>("/panel/admin/me").then(
      (me) => (setUsername(me.username), setState("in")),
      () => setState("out"),
    );
  }, []);

  if (state === "loading") return <Spinner />;
  return (
    <Routes>
      <Route path="login" element={<Login onDone={(u) => (setUsername(u), setState("in"))} />} />
      <Route
        path="*"
        element={state === "out" ? <Navigate to="/admin/login" replace /> : <Shell username={username} onLogout={() => setState("out")} />}
      />
    </Routes>
  );
}

function Login({ onDone }: { onDone: (username: string) => void }) {
  const { t, err } = useI18n();
  const nav = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const { pending, error, run } = useAction();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const me = await run(() => api.post<{ username: string }>("/panel/admin/login", { username, password }));
    if (me) {
      onDone(me.username);
      nav("/admin", { replace: true });
    }
  };
  return (
    <div className="login">
      <form className="card stack" onSubmit={submit}>
        <div className="brand"><span className="brand-mark"><Icon name="cal" /></span><div><b>{t("app.name")}</b><small>{t("adm.title")}</small></div></div>
        <div className="field"><label>{t("common.username")}</label><input className="input ltr-input" dir="ltr" autoComplete="username" autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} required /></div>
        <div className="field"><label>{t("common.password")}</label><input className="input ltr-input" dir="ltr" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
        {error != null && <ErrorNote error={error} />}
        <button className="btn primary block" disabled={pending}>{t("common.signin")}</button>
        <div className="row between"><LangSwitch /><span className="muted" aria-hidden>{err({ code: "" }) && ""}</span></div>
      </form>
    </div>
  );
}

function Shell({ username, onLogout }: { username: string; onLogout: () => void }) {
  const { t } = useI18n();
  const nav = useNavigate();
  const logout = async () => {
    await api.post("/panel/admin/logout").catch(() => undefined);
    onLogout();
    nav("/admin/login", { replace: true });
  };
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><Icon name="cal" /></span><div><b>{t("app.name")}</b><small>{t("adm.title")}</small></div></div>
        <nav className="nav">
          <NavLink to="/admin" end><Icon name="chart" /><span>{t("adm.dashboard")}</span></NavLink>
          <NavLink to="/admin/businesses"><Icon name="building" /><span>{t("adm.businesses")}</span></NavLink>
          <a href="/docs/guide/en" target="_blank" rel="noreferrer"><Icon name="book" /><span>{t("adm.docs")}</span></a>
        </nav>
        <div className="grow" />
        <button className="navlink nav btn ghost" style={{ justifyContent: "flex-start" }} onClick={logout}><Icon name="logout" /><span className="hide-narrow">{t("common.logout")} <span className="muted ltr">({username})</span></span></button>
      </aside>
      <main className="main">
        <Routes>
          <Route index element={<DashboardPage />} />
          <Route path="businesses" element={<BusinessesPage />} />
          <Route path="businesses/:id" element={<BusinessDetail />} />
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Routes>
      </main>
      <nav className="tabbar" aria-label="menu">
        <NavLink to="/admin" end><Icon name="chart" /></NavLink>
        <NavLink to="/admin/businesses"><Icon name="building" /></NavLink>
        <span />
        <a href="/docs/guide/en" target="_blank" rel="noreferrer"><Icon name="book" /></a>
        <button onClick={logout} aria-label={t("common.logout")}><Icon name="logout" /></button>
      </nav>
    </div>
  );
}

function TopBar({ title, month, onMonth }: { title: string; month?: string; onMonth?: (m: string) => void }) {
  const { t } = useI18n();
  return (
    <header className="topbar">
      <h1>{title}</h1>
      <span className="spacer" />
      {month && onMonth && (
        <label className="row" style={{ gap: 8 }}>
          <span className="muted">{t("adm.month")}</span>
          <input className="input ltr-input" style={{ width: 160 }} type="month" value={month} onChange={(e) => e.target.value && onMonth(e.target.value)} />
        </label>
      )}
      <LangSwitch />
    </header>
  );
}

const currentMonth = () => todayIn("Asia/Amman").slice(0, 7);

function DashboardPage() {
  const { t } = useI18n();
  const nav = useNavigate();
  const [month, setMonth] = useState(currentMonth);
  const { data, error, loading } = useLoad(() => api.get<Dashboard>("/panel/admin/dashboard", { month }), [month]);

  return (
    <>
      <TopBar title={t("adm.dashboard")} month={month} onMonth={setMonth} />
      {loading && !data && <Spinner />}
      {error != null && <ErrorNote error={error} />}
      {data && (
        <>
          <div className="stats">
            <div className="stat"><b>{data.businesses_total}</b><small>{t("adm.businessesTotal")}</small></div>
            <div className="stat"><b>{data.totals.total}</b><small>{t("adm.bookingsTotal")}</small></div>
            <div className="stat"><b style={{ color: "var(--success-ink)" }}>{data.totals.confirmed}</b><small>{t("status.confirmed")}</small></div>
            <div className="stat"><b style={{ color: "var(--violet-ink)" }}>{data.totals.completed}</b><small>{t("status.completed")}</small></div>
            <div className="stat"><b style={{ color: "var(--danger-ink)" }}>{data.totals.cancelled}</b><small>{t("status.cancelled")}</small></div>
            <div className="stat"><b style={{ color: "var(--warning-ink)" }}>{data.totals.no_show}</b><small>{t("status.no_show")}</small></div>
          </div>
          <section className="card">
            <h2>{t("adm.perBusiness")} <small className="muted" style={{ fontWeight: 500 }}>— {t("adm.madeIn")}</small></h2>
            {data.businesses.length === 0 ? (
              <div className="empty">{t("common.none")}</div>
            ) : (
              <div className="table-wrap">
                <table className="tbl">
                  <thead><tr><th>{t("adm.businessName")}</th><th className="num">{t("adm.bookingsTotal")}</th><th className="num">{t("status.confirmed")}</th><th className="num">{t("status.completed")}</th><th className="num">{t("status.cancelled")}</th><th className="num">{t("status.no_show")}</th></tr></thead>
                  <tbody>
                    {data.businesses.map((b) => (
                      <tr key={b.id} className="click" onClick={() => nav(`/admin/businesses/${b.id}`)}>
                        <td><b>{b.name}</b> {!b.active && <span className="pill off">{t("common.inactive")}</span>}</td>
                        <td className="num">{b.total}</td><td className="num">{b.confirmed}</td><td className="num">{b.completed}</td><td className="num">{b.cancelled}</td><td className="num">{b.no_show}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}

function BusinessesPage() {
  const { t } = useI18n();
  const nav = useNavigate();
  const [month, setMonth] = useState(currentMonth);
  const [creating, setCreating] = useState(false);
  const { data, error, loading, reload } = useLoad(() => api.get<{ businesses: AdminBusiness[] }>("/panel/admin/businesses", { month }), [month]);

  return (
    <>
      <TopBar title={t("adm.businesses")} month={month} onMonth={setMonth} />
      <div className="row"><button className="btn primary" onClick={() => setCreating(true)}><Icon name="plus" />{t("adm.addBusiness")}</button></div>
      {loading && !data && <Spinner />}
      {error != null && <ErrorNote error={error} />}
      {data && (
        <section className="card">
          {data.businesses.length === 0 ? (
            <div className="empty">{t("common.none")}</div>
          ) : (
            <div className="table-wrap">
              <table className="tbl">
                <thead><tr><th>{t("adm.businessName")}</th><th>{t("adm.username")}</th><th>{t("adm.status")}</th><th className="num">{t("adm.bookingsTotal")}</th><th className="num">{t("status.confirmed")}</th><th className="num">{t("status.cancelled")}</th><th className="num">{t("status.completed")}</th></tr></thead>
                <tbody>
                  {data.businesses.map((b) => (
                    <tr key={b.id} className="click" onClick={() => nav(`/admin/businesses/${b.id}`)}>
                      <td><b>{b.name}</b> {b.is_test && <span className="pill test">{t("adm.test")}</span>}</td>
                      <td><span className="ltr">{b.username}</span></td>
                      <td>{b.active ? <span className="pill st-confirmed">{t("common.active")}</span> : <span className="pill off">{t("common.inactive")}</span>}</td>
                      <td className="num">{b.total}</td><td className="num">{b.confirmed}</td><td className="num">{b.cancelled}</td><td className="num">{b.completed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      {creating && <CreateBusiness onClose={() => setCreating(false)} onCreated={reload} />}
    </>
  );
}

export { ApiError };
