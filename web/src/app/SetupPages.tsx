import { useState, type FormEvent, type ReactNode } from "react";
import { api, type BusinessInfo, type DayOff, type Me, type Service, type Staff, type Zone } from "../api";
import { fullDate, localParts, todayIn } from "../dates";
import { useI18n } from "../i18n";
import { Avatar, ErrorNote, Field, Icon, LangSwitch, Modal, Spinner, useAction, useLoad, useToast } from "../ui";
import { ChangePassword } from "./BusinessApp";
import { nameOf } from "./CalendarPage";

function PageHead({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <header className="topbar">
      <h1>{title}</h1>
      <span className="spacer" />
      {action}
      <LangSwitch />
    </header>
  );
}

/** "a, b, c" -> ["a","b","c"] */
const splitAliases = (s: string) => s.split(/[,،]/).map((x) => x.trim()).filter(Boolean);

// =====================================================================================================================
// Team
// =====================================================================================================================
const WEEK_ORDER = [6, 0, 1, 2, 3, 4, 5]; // Saturday first
type Hours = Record<number, { start: string; end: string }[]>;
const DEFAULT_WEEK: Hours = { 6: [{ start: "09:00", end: "18:00" }], 0: [{ start: "09:00", end: "18:00" }], 1: [{ start: "09:00", end: "18:00" }], 2: [{ start: "09:00", end: "18:00" }], 3: [{ start: "09:00", end: "18:00" }], 4: [{ start: "09:00", end: "18:00" }], 5: [] };

const toHours = (list: Staff["hours"]): Hours => {
  const h: Hours = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  for (const x of list) h[x.weekday]!.push({ start: x.start, end: x.end });
  return h;
};
const fromHours = (h: Hours) => WEEK_ORDER.flatMap((weekday) => (h[weekday] ?? []).map((i) => ({ weekday, ...i })));

export function TeamPage() {
  const { t, lang } = useI18n();
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Staff | "new" | null>(null);
  const staff = useLoad(() => api.get<{ staff: Staff[] }>("/panel/app/staff", { include_inactive: "true" }), []);
  const services = useLoad(() => api.get<{ services: Service[] }>("/panel/app/services"), []);
  const zones = useLoad(() => api.get<{ zones: Zone[] }>("/panel/app/zones"), []);
  const list = (staff.data?.staff ?? []).filter((s) => showInactive || s.active);

  return (
    <>
      <PageHead title={t("team.title")} action={<button className="btn primary" onClick={() => setEditing("new")}><Icon name="plus" />{t("team.add")}</button>} />
      <label className="check"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />{t("common.showInactive")}</label>
      {staff.loading && !staff.data && <Spinner />}
      {staff.error != null && <ErrorNote error={staff.error} />}
      <div className="cards">
        {list.map((s) => {
          const days = new Set(s.hours.map((h) => h.weekday)).size;
          return (
            <section key={s.id} className="card stack" style={s.active ? undefined : { opacity: 0.6 }}>
              <div className="row" style={{ flexWrap: "nowrap" }}>
                <Avatar name={nameOf(s, lang)} color={s.color} size={44} />
                <div style={{ minWidth: 0, flex: 1 }}><b>{nameOf(s, lang)}</b><div className="muted ltr">{s.phone ?? ""}</div></div>
                {!s.active && <span className="pill off">{t("common.inactive")}</span>}
              </div>
              <div className="muted">{t("team.hoursSummary", { days })} · {s.service_ids.length} {t("nav.services")}</div>
              <div className="row"><button className="btn" onClick={() => setEditing(s)}>{t("common.edit")}</button></div>
            </section>
          );
        })}
      </div>
      {editing && (
        <StaffForm
          staff={editing === "new" ? null : editing}
          services={services.data?.services ?? []}
          zones={zones.data?.zones ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => (setEditing(null), staff.reload())}
        />
      )}
    </>
  );
}

function StaffForm({ staff, services, zones, onClose, onSaved }: { staff: Staff | null; services: Service[]; zones: Zone[]; onClose: () => void; onSaved: () => void }) {
  const { t, lang } = useI18n();
  const [f, setF] = useState({ name_ar: staff?.name_ar ?? "", name_en: staff?.name_en ?? "", phone: staff?.phone ?? "", color: staff?.color ?? "#4466F2" });
  const [serviceIds, setServiceIds] = useState<string[]>(staff?.service_ids ?? services.map((s) => s.id));
  const [zoneIds, setZoneIds] = useState<string[]>(staff?.zone_ids ?? zones.map((z) => z.id));
  const [hours, setHours] = useState<Hours>(staff ? toHours(staff.hours) : DEFAULT_WEEK);
  const { pending, error, run } = useAction();
  const toggle = (list: string[], set: (v: string[]) => void, id: string) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    const base = { name_ar: f.name_ar, name_en: f.name_en || null, phone: f.phone || null, color: f.color, service_ids: serviceIds, zone_ids: zoneIds };
    const ok = await run(async () => {
      if (!staff) return api.post("/panel/app/staff", { ...base, hours: fromHours(hours) });
      await api.patch(`/panel/app/staff/${staff.id}`, base);
      return api.put(`/panel/app/staff/${staff.id}/hours`, { hours: fromHours(hours) });
    });
    if (ok) onSaved();
  };
  const toggleActive = async () => {
    if (!staff) return;
    if (await run(() => (staff.active ? api.del(`/panel/app/staff/${staff.id}`) : api.patch(`/panel/app/staff/${staff.id}`, { active: true })))) onSaved();
  };
  const setInterval = (wd: number, i: number, key: "start" | "end", v: string) =>
    setHours((h) => ({ ...h, [wd]: (h[wd] ?? []).map((x, j) => (j === i ? { ...x, [key]: v } : x)) }));

  return (
    <Modal title={staff ? t("team.edit") : t("team.add")} onClose={onClose} wide>
      <form className="stack" onSubmit={save}>
        <div className="grid2">
          <Field label={t("common.name_ar")}><input className="input" value={f.name_ar} onChange={(e) => setF({ ...f, name_ar: e.target.value })} required /></Field>
          <Field label={t("common.name_en")}><input className="input ltr-input" dir="ltr" value={f.name_en} onChange={(e) => setF({ ...f, name_en: e.target.value })} /></Field>
          <Field label={t("common.phone")}><input className="input ltr-input" dir="ltr" type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
          <Field label={t("team.color")}><input className="input" type="color" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} style={{ padding: 4 }} /></Field>
        </div>

        <Field label={t("team.services")}>
          {services.length === 0 ? <div className="note">{t("team.noServices")}</div> : services.map((s) => (
            <label key={s.id} className="check"><input type="checkbox" checked={serviceIds.includes(s.id)} onChange={() => toggle(serviceIds, setServiceIds, s.id)} />{nameOf(s, lang)}</label>
          ))}
        </Field>
        {zones.length > 0 && (
          <Field label={t("team.zones")}>
            <div className="row">{zones.map((z) => <label key={z.id} className="check" style={{ minWidth: 150 }}><input type="checkbox" checked={zoneIds.includes(z.id)} onChange={() => toggle(zoneIds, setZoneIds, z.id)} />{nameOf(z, lang)}</label>)}</div>
          </Field>
        )}

        <Field label={t("team.hours")}>
          <div className="hours-edit">
            {WEEK_ORDER.map((wd) => {
              const day = hours[wd] ?? [];
              return (
                <div key={wd} className="hours-day">
                  <label className="check"><input type="checkbox" checked={day.length > 0} onChange={(e) => setHours((h) => ({ ...h, [wd]: e.target.checked ? [{ start: "09:00", end: "18:00" }] : [] }))} />{t(`wd.${wd}`)}</label>
                  {day.length === 0 && <span className="muted">{t("team.dayOff")}</span>}
                  {day.map((iv, i) => (
                    <span key={i} className="iv">
                      <input className="input ltr-input" dir="ltr" type="time" value={iv.start} onChange={(e) => setInterval(wd, i, "start", e.target.value)} required />
                      –
                      <input className="input ltr-input" dir="ltr" type="time" value={iv.end} onChange={(e) => setInterval(wd, i, "end", e.target.value)} required />
                      {day.length > 1 && <button type="button" className="icon-btn" onClick={() => setHours((h) => ({ ...h, [wd]: day.filter((_, j) => j !== i) }))} aria-label={t("common.delete")}><Icon name="close" /></button>}
                    </span>
                  ))}
                  {day.length > 0 && <button type="button" className="btn ghost" onClick={() => setHours((h) => ({ ...h, [wd]: [...day, { start: "16:00", end: "20:00" }] }))}>{t("team.addInterval")}</button>}
                </div>
              );
            })}
          </div>
        </Field>

        {error != null && <ErrorNote error={error} />}
        <div className="modal-foot">
          {staff && <button type="button" className={`btn ${staff.active ? "danger" : "success"}`} onClick={toggleActive} disabled={pending}>{staff.active ? t("team.deactivate") : t("team.activate")}</button>}
          <button type="button" className="btn" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn primary" disabled={pending}>{t("common.save")}</button>
        </div>
      </form>
    </Modal>
  );
}

// =====================================================================================================================
// Services and zones: the same shape, a different set of fields
// =====================================================================================================================
export function ServicesPage() {
  const { t, lang } = useI18n();
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Service | "new" | null>(null);
  const { data, loading, error, reload } = useLoad(() => api.get<{ services: Service[] }>("/panel/app/services", { include_inactive: "true" }), []);
  const list = (data?.services ?? []).filter((s) => showInactive || s.active);

  return (
    <>
      <PageHead title={t("svc.title")} action={<button className="btn primary" onClick={() => setEditing("new")}><Icon name="plus" />{t("svc.add")}</button>} />
      <label className="check"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />{t("common.showInactive")}</label>
      {loading && !data && <Spinner />}
      {error != null && <ErrorNote error={error} />}
      <div className="cards">
        {list.map((s) => (
          <section key={s.id} className="card stack" style={s.active ? undefined : { opacity: 0.6 }}>
            <div className="row between"><b>{nameOf(s, lang)}</b>{!s.active && <span className="pill off">{t("common.inactive")}</span>}</div>
            <div className="muted">{s.duration_min} {t("common.minutes")}{s.aliases.length ? ` · ${s.aliases.join("، ")}` : ""}</div>
            <div className="row"><button className="btn" onClick={() => setEditing(s)}>{t("common.edit")}</button></div>
          </section>
        ))}
      </div>
      {editing && <ServiceForm service={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), reload())} />}
    </>
  );
}

function ServiceForm({ service, onClose, onSaved }: { service: Service | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const [f, setF] = useState({ name_ar: service?.name_ar ?? "", name_en: service?.name_en ?? "", aliases: (service?.aliases ?? []).join("، "), duration_min: String(service?.duration_min ?? 60) });
  const { pending, error, run } = useAction();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body = { name_ar: f.name_ar, name_en: f.name_en || null, aliases: splitAliases(f.aliases), duration_min: Number(f.duration_min) };
    if (await run(() => (service ? api.patch(`/panel/app/services/${service.id}`, body) : api.post("/panel/app/services", body)))) onSaved();
  };
  const toggleActive = async () => {
    if (service && (await run(() => (service.active ? api.del(`/panel/app/services/${service.id}`) : api.patch(`/panel/app/services/${service.id}`, { active: true }))))) onSaved();
  };
  return (
    <Modal title={service ? t("svc.edit") : t("svc.add")} onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <Field label={t("common.name_ar")}><input className="input" value={f.name_ar} onChange={(e) => setF({ ...f, name_ar: e.target.value })} required /></Field>
        <Field label={t("common.name_en")}><input className="input ltr-input" dir="ltr" value={f.name_en} onChange={(e) => setF({ ...f, name_en: e.target.value })} /></Field>
        <Field label={t("svc.duration")}><input className="input ltr-input" dir="ltr" type="number" min={5} max={720} step={5} value={f.duration_min} onChange={(e) => setF({ ...f, duration_min: e.target.value })} required /></Field>
        <Field label={t("svc.aliases")}><input className="input" value={f.aliases} onChange={(e) => setF({ ...f, aliases: e.target.value })} /></Field>
        {error != null && <ErrorNote error={error} />}
        <div className="modal-foot">
          {service && <button type="button" className={`btn ${service.active ? "danger" : "success"}`} onClick={toggleActive} disabled={pending}>{service.active ? t("team.deactivate") : t("team.activate")}</button>}
          <button type="button" className="btn" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn primary" disabled={pending}>{t("common.save")}</button>
        </div>
      </form>
    </Modal>
  );
}

export function ZonesPage() {
  const { t, lang } = useI18n();
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Zone | "new" | null>(null);
  const { data, loading, error, reload } = useLoad(() => api.get<{ zones: Zone[] }>("/panel/app/zones", { include_inactive: "true" }), []);
  const list = (data?.zones ?? []).filter((z) => showInactive || z.active);

  return (
    <>
      <PageHead title={t("zone.title")} action={<button className="btn primary" onClick={() => setEditing("new")}><Icon name="plus" />{t("zone.add")}</button>} />
      <label className="check"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />{t("common.showInactive")}</label>
      {loading && !data && <Spinner />}
      {error != null && <ErrorNote error={error} />}
      <div className="cards">
        {list.map((z) => (
          <section key={z.id} className="card stack" style={z.active ? undefined : { opacity: 0.6 }}>
            <div className="row between"><b>{nameOf(z, lang)}</b>{!z.active && <span className="pill off">{t("common.inactive")}</span>}</div>
            <div className="muted">{z.visit_fee_jod !== null ? <><span className="ltr">{Number(z.visit_fee_jod)}</span> {t("common.jod")}</> : "—"}{z.aliases.length ? ` · ${z.aliases.join("، ")}` : ""}</div>
            <div className="row"><button className="btn" onClick={() => setEditing(z)}>{t("common.edit")}</button></div>
          </section>
        ))}
      </div>
      {editing && <ZoneForm zone={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), reload())} />}
    </>
  );
}

function ZoneForm({ zone, onClose, onSaved }: { zone: Zone | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const [f, setF] = useState({ name_ar: zone?.name_ar ?? "", name_en: zone?.name_en ?? "", aliases: (zone?.aliases ?? []).join("، "), fee: zone?.visit_fee_jod !== null && zone ? String(Number(zone.visit_fee_jod)) : "" });
  const { pending, error, run } = useAction();
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const body = { name_ar: f.name_ar, name_en: f.name_en || null, aliases: splitAliases(f.aliases), visit_fee_jod: f.fee === "" ? null : Number(f.fee) };
    if (await run(() => (zone ? api.patch(`/panel/app/zones/${zone.id}`, body) : api.post("/panel/app/zones", body)))) onSaved();
  };
  const toggleActive = async () => {
    if (zone && (await run(() => (zone.active ? api.del(`/panel/app/zones/${zone.id}`) : api.patch(`/panel/app/zones/${zone.id}`, { active: true }))))) onSaved();
  };
  return (
    <Modal title={zone ? t("zone.edit") : t("zone.add")} onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <Field label={t("common.name_ar")}><input className="input" value={f.name_ar} onChange={(e) => setF({ ...f, name_ar: e.target.value })} required /></Field>
        <Field label={t("common.name_en")}><input className="input ltr-input" dir="ltr" value={f.name_en} onChange={(e) => setF({ ...f, name_en: e.target.value })} /></Field>
        <Field label={t("zone.fee")}><input className="input ltr-input" dir="ltr" type="number" min={0} step="0.5" value={f.fee} onChange={(e) => setF({ ...f, fee: e.target.value })} /></Field>
        <Field label={t("svc.aliases")}><input className="input" value={f.aliases} onChange={(e) => setF({ ...f, aliases: e.target.value })} /></Field>
        {error != null && <ErrorNote error={error} />}
        <div className="modal-foot">
          {zone && <button type="button" className={`btn ${zone.active ? "danger" : "success"}`} onClick={toggleActive} disabled={pending}>{zone.active ? t("team.deactivate") : t("team.activate")}</button>}
          <button type="button" className="btn" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn primary" disabled={pending}>{t("common.save")}</button>
        </div>
      </form>
    </Modal>
  );
}

// =====================================================================================================================
// Days off
// =====================================================================================================================
export function DaysOffPage() {
  const { t, lang } = useI18n();
  const today = todayIn("Asia/Amman");
  const [f, setF] = useState({ staff_id: "", date_from: today, date_to: today, reason: "" });
  const off = useLoad(() => api.get<{ days_off: DayOff[] }>("/panel/app/days-off"), []);
  const staff = useLoad(() => api.get<{ staff: Staff[] }>("/panel/app/staff"), []);
  const { pending, error, run } = useAction();

  const add = async (e: FormEvent) => {
    e.preventDefault();
    const body = { date_from: f.date_from, date_to: f.date_to, ...(f.staff_id && { staff_id: f.staff_id }), ...(f.reason && { reason: f.reason }) };
    if (await run(() => api.post("/panel/app/days-off", body))) (setF({ ...f, reason: "" }), off.reload());
  };
  const remove = async (id: string) => {
    if (await run(() => api.del(`/panel/app/days-off/${id}`))) off.reload();
  };
  const who = (id: string | null) => (id ? nameOf(staff.data?.staff.find((s) => s.id === id) ?? { name_ar: "?", name_en: null }, lang) : t("off.everyone"));

  return (
    <>
      <PageHead title={t("off.title")} />
      <section className="card">
        <form className="stack" onSubmit={add}>
          <h2>{t("off.add")}</h2>
          <div className="grid2">
            <Field label={t("off.who")}>
              <select className="input" value={f.staff_id} onChange={(e) => setF({ ...f, staff_id: e.target.value })}>
                <option value="">{t("off.everyone")}</option>
                {(staff.data?.staff ?? []).map((s) => <option key={s.id} value={s.id}>{nameOf(s, lang)}</option>)}
              </select>
            </Field>
            <Field label={t("off.reason")}><input className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} maxLength={200} /></Field>
            <Field label={t("off.from")}><input className="input ltr-input" dir="ltr" type="date" value={f.date_from} onChange={(e) => setF({ ...f, date_from: e.target.value, date_to: f.date_to < e.target.value ? e.target.value : f.date_to })} required /></Field>
            <Field label={t("off.to")}><input className="input ltr-input" dir="ltr" type="date" min={f.date_from} value={f.date_to} onChange={(e) => setF({ ...f, date_to: e.target.value })} required /></Field>
          </div>
          <div className="note">{t("off.note")}</div>
          {error != null && <ErrorNote error={error} />}
          <div><button className="btn primary" disabled={pending}><Icon name="plus" />{t("common.add")}</button></div>
        </form>
      </section>
      {off.loading && !off.data && <Spinner />}
      <section className="card">
        {(off.data?.days_off ?? []).length === 0 ? <div className="empty">{t("off.none")}</div> : (
          <div className="stack">
            {off.data!.days_off.map((d) => {
              const a = localParts(d.start_at, "Asia/Amman");
              const z = localParts(new Date(new Date(d.end_at).getTime() - 1).toISOString(), "Asia/Amman");
              return (
                <div key={d.id} className="row between">
                  <div><b>{who(d.staff_id)}</b><div className="muted">{a.date === z.date ? fullDate(a.date, lang) : `${fullDate(a.date, lang)} → ${fullDate(z.date, lang)}`}{d.reason ? ` · ${d.reason}` : ""}</div></div>
                  <button className="btn danger" onClick={() => remove(d.id)} disabled={pending}>{t("common.delete")}</button>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}

// =====================================================================================================================
// Settings
// =====================================================================================================================
const RULES = ["slot_step_min", "gap_min", "min_lead_min", "horizon_days", "change_cutoff_min"] as const;

export function SettingsPage({ me, onChanged }: { me: Me; onChanged: (me: Me) => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const { data, loading, error } = useLoad(() => api.get<BusinessInfo>("/panel/app/business"), []);
  const [s, setS] = useState<BusinessInfo["settings"] | null>(null);
  const { pending, error: saveError, run } = useAction();
  const values = s ?? data?.settings;

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!values) return;
    const ok = await run(() => api.patch("/panel/app/business", { settings: values }));
    if (ok) toast(t("common.saved"));
  };

  return (
    <>
      <PageHead title={t("set.title")} />
      {loading && !data && <Spinner />}
      {error != null && <ErrorNote error={error} />}
      {values && (
        <section className="card">
          <form className="stack" onSubmit={save}>
            <h2>{t("set.rules")}</h2>
            <div className="grid2">
              {RULES.map((k) => (
                <Field key={k} label={t(`set.${k}`)}>
                  <input className="input ltr-input" dir="ltr" type="number" min={0} value={values[k]} onChange={(e) => setS({ ...values, [k]: Number(e.target.value) })} required />
                </Field>
              ))}
              <Field label={t("set.display_digits")}>
                <select className="input" value={values.display_digits} onChange={(e) => setS({ ...values, display_digits: e.target.value as "latin" | "arabic" })}>
                  <option value="latin">{t("set.digits.latin")}</option>
                  <option value="arabic">{t("set.digits.arabic")}</option>
                </select>
              </Field>
            </div>
            {saveError != null && <ErrorNote error={saveError} />}
            <div><button className="btn primary" disabled={pending}>{t("common.save")}</button></div>
          </form>
        </section>
      )}
      {!me.by_admin && (
        <section className="card">
          <h2>{t("set.password")}</h2>
          <ChangePassword me={me} onDone={onChanged} />
        </section>
      )}
    </>
  );
}
