import { createContext, useContext, useEffect, useState, type FormEvent } from "react";
import { Navigate, NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { api, type Me } from "../api";
import { useI18n } from "../i18n";
import { ErrorNote, Icon, LangSwitch, Spinner, useAction, useToast } from "../ui";
import { CalendarPage } from "./CalendarPage";
import { DaysOffPage, ServicesPage, SettingsPage, TeamPage, ZonesPage } from "./SetupPages";

const MeCtx = createContext<Me | null>(null);
export const useMe = () => {
  const me = useContext(MeCtx);
  if (!me) throw new Error("useMe outside the business panel");
  return me;
};

export function BusinessApp() {
  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined = loading, null = signed out

  const load = () => api.get<Me>("/panel/app/me").then(setMe, () => setMe(null));
  useEffect(() => void load(), []);

  if (me === undefined) return <Spinner />;
  return (
    <Routes>
      <Route path="login" element={me ? <Navigate to="/app" replace /> : <Login onDone={setMe} />} />
      <Route
        path="*"
        element={
          me === null ? (
            <Navigate to="/app/login" replace />
          ) : me.must_change_password ? (
            <ChangePassword me={me} onDone={setMe} forced />
          ) : (
            <MeCtx.Provider value={me}>
              <Shell me={me} onLogout={() => setMe(null)} onChanged={setMe} />
            </MeCtx.Provider>
          )
        }
      />
    </Routes>
  );
}

function Login({ onDone }: { onDone: (me: Me) => void }) {
  const { t } = useI18n();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const { pending, error, run } = useAction();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const me = await run(() => api.post<Me>("/panel/app/login", { username: username.trim().toLowerCase(), password }));
    if (me) onDone(me);
  };
  return (
    <div className="login">
      <form className="card stack" onSubmit={submit}>
        <div className="brand"><span className="brand-mark"><Icon name="cal" /></span><div><b>{t("app.name")}</b></div></div>
        <div className="field"><label>{t("common.username")}</label><input className="input ltr-input" dir="ltr" autoComplete="username" autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} required /></div>
        <div className="field"><label>{t("common.password")}</label><input className="input ltr-input" dir="ltr" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></div>
        {error != null && <ErrorNote error={error} />}
        <button className="btn primary block" disabled={pending}>{t("common.signin")}</button>
        <LangSwitch />
      </form>
    </div>
  );
}

/** The password change form: forced after a temporary password, also reachable from Settings. */
export function ChangePassword({ me, onDone, forced }: { me: Me; onDone: (me: Me) => void; forced?: boolean }) {
  const { t } = useI18n();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const { pending, error, run } = useAction();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const updated = await run(() => api.post<Me>("/panel/app/password", { current_password: current, new_password: next }));
    if (updated) {
      setCurrent("");
      setNext("");
      toast(t("set.passwordChanged"));
      onDone(updated);
    }
  };
  const form = (
    <form className="stack" onSubmit={submit}>
      {forced && <div className="note warn">{t("set.mustChange")}</div>}
      <div className="field"><label>{t("set.currentPassword")}</label><input className="input ltr-input" dir="ltr" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required /></div>
      <div className="field"><label>{t("set.newPassword")}</label><input className="input ltr-input" dir="ltr" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={8} /></div>
      {error != null && <ErrorNote error={error} />}
      <button className="btn primary" disabled={pending}>{t("common.save")}</button>
    </form>
  );
  if (!forced) return form;
  return (
    <div className="login">
      <div className="card stack">
        <div className="brand"><span className="brand-mark"><Icon name="cal" /></span><div><b>{me.name}</b></div></div>
        {form}
        <LangSwitch />
      </div>
    </div>
  );
}

function Shell({ me, onLogout, onChanged }: { me: Me; onLogout: () => void; onChanged: (me: Me) => void }) {
  const { t } = useI18n();
  const nav = useNavigate();

  const logout = async () => {
    await api.post("/panel/app/logout").catch(() => undefined);
    onLogout();
    nav("/app/login", { replace: true });
  };
  const links = [
    { to: "/app", icon: "cal", label: t("nav.calendar"), end: true },
    { to: "/app/team", icon: "users", label: t("nav.team") },
    { to: "/app/services", icon: "wrench", label: t("nav.services") },
    ...(me.goes_to_customer ? [{ to: "/app/zones", icon: "pin", label: t("nav.zones") }] : []),
    { to: "/app/days-off", icon: "sun", label: t("nav.daysOff") },
    { to: "/app/settings", icon: "gear", label: t("nav.settings") },
  ];
  // the phone's bottom bar shows five places
  const tabs = links.filter((l) => ["/app", "/app/team", "/app/services", "/app/settings"].includes(l.to));

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><Icon name="cal" /></span><div><b>{me.name}</b><small>{t("app.name")}</small></div></div>
        <nav className="nav">
          {links.map((l) => <NavLink key={l.to} to={l.to} end={l.end}><Icon name={l.icon} /><span>{l.label}</span></NavLink>)}
        </nav>
        <div className="grow" />
        <button className="navlink nav btn ghost" style={{ justifyContent: "flex-start" }} onClick={logout}><Icon name="logout" /><span className="hide-narrow">{t("common.logout")}</span></button>
      </aside>

      <main className="main">
        {me.by_admin && (
          <div className="admin-banner">
            <span>{t("set.byAdmin")}</span>
            <button className="btn" onClick={() => nav("/admin")}>{t("set.backToAdmin")}</button>
          </div>
        )}
        <Routes>
          <Route index element={<CalendarPage />} />
          <Route path="team" element={<TeamPage />} />
          <Route path="services" element={<ServicesPage />} />
          <Route path="zones" element={me.goes_to_customer ? <ZonesPage /> : <Navigate to="/app" replace />} />
          <Route path="days-off" element={<DaysOffPage />} />
          <Route path="settings" element={<SettingsPage me={me} onChanged={onChanged} />} />
          <Route path="*" element={<Navigate to="/app" replace />} />
        </Routes>
      </main>

      <nav className="tabbar" aria-label="menu">
        <NavLink to="/app" end aria-label={t("nav.calendar")}><Icon name="cal" /></NavLink>
        <NavLink to="/app/team" aria-label={t("nav.team")}><Icon name="users" /></NavLink>
        <button className="fab-m" aria-label={t("cal.newBooking")} onClick={() => window.dispatchEvent(new Event("mawid:new-booking"))}><Icon name="plus" /></button>
        {tabs.filter((l) => l.to === "/app/services").map((l) => <NavLink key={l.to} to={l.to} aria-label={l.label}><Icon name={l.icon} /></NavLink>)}
        <NavLink to="/app/settings" aria-label={t("nav.settings")}><Icon name="gear" /></NavLink>
      </nav>
    </div>
  );
}
