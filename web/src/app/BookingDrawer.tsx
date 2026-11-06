import { useState, type FormEvent } from "react";
import { api, type Booking, type Calendar, type HistoryEntry, type Slot } from "../api";
import { addDays, clock, dayMonth, fullDate, localParts, timeOf } from "../dates";
import { useI18n } from "../i18n";
import { Avatar, ErrorNote, Field, Icon, Modal, Spinner, StatusPill, useAction, useLoad, useToast } from "../ui";
import { nameOf } from "./CalendarPage";

type Detail = Booking & { history: HistoryEntry[] };

export function BookingDrawer({ id, cal, onClose, onChanged }: { id: string; cal: Calendar; onClose: () => void; onChanged: () => void }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const { data: b, error, loading, reload } = useLoad(() => api.get<Detail>(`/panel/app/bookings/${id}`), [id]);
  const [mode, setMode] = useState<"view" | "edit" | "move" | "cancel">("view");
  const act = useAction();
  const tz = cal.timezone;

  const done = (message: string) => {
    toast(message);
    setMode("view");
    reload();
    onChanged();
  };
  const post = async (path: string, body: unknown, message: string) => {
    const r = await act.run(() => api.post(`/panel/app/bookings/${id}${path}`, body));
    if (r) done(message);
  };

  if (loading && !b) return <Modal drawer title={t("bk.title")} onClose={onClose}><Spinner /></Modal>;
  if (!b) return <Modal drawer title={t("bk.title")} onClose={onClose}><ErrorNote error={error} /></Modal>;

  const staff = cal.staff.find((s) => s.id === b.staff_id);
  const service = cal.services.find((s) => s.id === b.service_id);
  const zone = cal.zones.find((z) => z.id === b.zone_id);
  const start = localParts(b.start_at, tz);
  const open = b.status === "confirmed";

  return (
    <Modal drawer title={t("bk.title")} onClose={onClose}>
      <div className="row between">
        <StatusPill status={b.status} />
        <a className="btn" href={`tel:${b.customer_phone}`}><Icon name="phone" />{t("bk.call")}</a>
      </div>

      <dl className="kv">
        <dt>{t("bk.customer")}</dt><dd><b>{b.customer_name}</b><br /><span className="ltr muted">{b.customer_phone}</span></dd>
        <dt>{t("bk.when")}</dt><dd>{fullDate(start.date, lang)}<br /><bdi>{timeOf(b.start_at, tz, lang)}</bdi> – <bdi>{timeOf(b.end_at, tz, lang)}</bdi></dd>
        <dt>{t("bk.service")}</dt><dd>{service ? nameOf(service, lang) : b.service_name_ar}</dd>
        {b.description && <><dt>{t("bk.description")}</dt><dd>{b.description}</dd></>}
        {staff && <><dt>{t("bk.staff")}</dt><dd className="row" style={{ gap: 8 }}><Avatar name={nameOf(staff, lang)} color={staff.color} size={26} />{nameOf(staff, lang)}</dd></>}
        {zone && <><dt>{t("bk.zone")}</dt><dd>{nameOf(zone, lang)}</dd></>}
        {b.visit_fee_jod && <><dt>{t("bk.fee")}</dt><dd><span className="ltr">{Number(b.visit_fee_jod)}</span> {t("common.jod")}</dd></>}
        {b.address && <><dt>{t("bk.address")}</dt><dd>{b.address}</dd></>}
        {b.external_ref && <><dt>{t("bk.ref")}</dt><dd><span className="ltr">{b.external_ref}</span></dd></>}
        <dt>{t("bk.source")}</dt><dd>{t(`bk.source.${b.source}`)}</dd>
      </dl>

      {act.error != null && <ErrorNote error={act.error} />}

      {mode === "view" && (
        <div className="stack">
          {open && (
            <div className="row">
              <button className="btn primary" onClick={() => setMode("move")}>{t("bk.move")}</button>
              <button className="btn success" disabled={act.pending} onClick={() => post("/status", { status: "completed" }, t("bk.updated"))}>{t("bk.complete")}</button>
              <button className="btn" disabled={act.pending} onClick={() => post("/status", { status: "no_show" }, t("bk.updated"))}>{t("bk.noShow")}</button>
            </div>
          )}
          {open && (
            <Field label={t("bk.assign")}>
              <select className="input" value={b.staff_id} disabled={act.pending} onChange={(e) => post("/reschedule", { staff_id: e.target.value, start_at: b.start_at }, t("bk.moved"))}>
                {cal.staff.map((s) => <option key={s.id} value={s.id}>{nameOf(s, lang)}</option>)}
              </select>
            </Field>
          )}
          <div className="row">
            <button className="btn" onClick={() => setMode("edit")}>{t("common.edit")}</button>
            {open && <button className="btn danger" onClick={() => setMode("cancel")}>{t("bk.cancelBooking")}</button>}
          </div>
        </div>
      )}

      {mode === "edit" && <EditForm b={b} onCancel={() => setMode("view")} onSaved={() => done(t("bk.updated"))} />}
      {mode === "move" && <MoveForm b={b} onCancel={() => setMode("view")} onMoved={() => done(t("bk.moved"))} />}
      {mode === "cancel" && <CancelForm pending={act.pending} onCancel={() => setMode("view")} onConfirm={(reason) => post("/cancel", { reason: reason || undefined }, t("bk.cancelled"))} />}

      <div>
        <h3 style={{ fontSize: 14, margin: "6px 0" }}>{t("bk.history")}</h3>
        <ul className="timeline" style={{ margin: 0, padding: 0 }}>
          {b.history.map((h, i) => {
            const at = localParts(h.at, tz);
            return (
              <li key={i}>
                <b>{t(`hist.${h.action}`)}</b> <span className="muted">— {t(`by.${h.by}`)} · {dayMonth(at.date, lang)} {clock(at.hour, at.minute, lang)}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </Modal>
  );
}

function EditForm({ b, onCancel, onSaved }: { b: Booking; onCancel: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const [f, setF] = useState({ customer_name: b.customer_name, customer_phone: b.customer_phone, description: b.description ?? "", address: b.address ?? "", external_ref: b.external_ref ?? "" });
  const { pending, error, run } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body = { customer_name: f.customer_name, customer_phone: f.customer_phone, description: f.description || null, address: f.address || null, external_ref: f.external_ref || null };
    if (await run(() => api.patch(`/panel/app/bookings/${b.id}`, body))) onSaved();
  };
  return (
    <form className="stack" onSubmit={submit}>
      <h3 style={{ fontSize: 15 }}>{t("edit.title")}</h3>
      <Field label={t("nb.name")}><input className="input" value={f.customer_name} onChange={(e) => setF({ ...f, customer_name: e.target.value })} required /></Field>
      <Field label={t("common.phone")}><input className="input ltr-input" dir="ltr" type="tel" value={f.customer_phone} onChange={(e) => setF({ ...f, customer_phone: e.target.value })} required /></Field>
      <Field label={t("bk.description")}><input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      <Field label={t("bk.address")}><input className="input" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
      <Field label={t("bk.ref")}><input className="input ltr-input" dir="ltr" value={f.external_ref} onChange={(e) => setF({ ...f, external_ref: e.target.value })} /></Field>
      {error != null && <ErrorNote error={error} />}
      <div className="modal-foot"><button type="button" className="btn" onClick={onCancel}>{t("common.cancel")}</button><button className="btn primary" disabled={pending}>{t("common.save")}</button></div>
    </form>
  );
}

function CancelForm({ pending, onCancel, onConfirm }: { pending: boolean; onCancel: () => void; onConfirm: (reason: string) => void }) {
  const { t } = useI18n();
  const [reason, setReason] = useState("");
  return (
    <div className="stack">
      <Field label={t("bk.cancelReason")}><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <div className="modal-foot"><button className="btn" onClick={onCancel}>{t("common.back")}</button><button className="btn danger" disabled={pending} onClick={() => onConfirm(reason.trim())}>{t("bk.confirmCancel")}</button></div>
    </div>
  );
}

/** Picks another free time (this booking's own time counts as free) and moves the booking there. */
function MoveForm({ b, onCancel, onMoved }: { b: Booking; onCancel: () => void; onMoved: () => void }) {
  const { t, lang } = useI18n();
  const tzDate = localParts(b.start_at, "Asia/Amman").date;
  const [date, setDate] = useState(tzDate);
  const { data, loading } = useLoad(
    () => api.get<{ slots: Slot[] }>("/panel/app/slots", { service_id: b.service_id, zone_id: b.zone_id ?? undefined, date_from: date, date_to: addDays(date, 6), booking_id: b.id }),
    [date, b.id],
  );
  const { pending, error, run } = useAction();
  const days = [...new Set((data?.slots ?? []).map((s) => s.local_date))];

  const pick = async (s: Slot) => {
    if (await run(() => api.post(`/panel/app/bookings/${b.id}/reschedule`, { staff_id: s.staff_id, start_at: s.start_at }))) onMoved();
  };
  return (
    <div className="stack">
      <h3 style={{ fontSize: 15 }}>{t("bk.pickTime")}</h3>
      <Field label={t("nb.date")}><input className="input ltr-input" dir="ltr" type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} /></Field>
      {loading && <Spinner />}
      {data && days.length === 0 && <div className="note">{t("bk.noTimes")}</div>}
      {days.map((d) => (
        <div key={d}>
          <div className="label" style={{ marginBottom: 6 }}>{fullDate(d, lang)}</div>
          <div className="slotlist">
            {data!.slots.filter((s) => s.local_date === d).map((s) => (
              <button key={s.start_at + s.staff_id} className="slotbtn" disabled={pending} onClick={() => pick(s)}>
                <bdi>{clock(+s.local_time.slice(0, 2), +s.local_time.slice(3, 5), lang)}</bdi>
                <small>{lang === "en" && s.staff_name_en ? s.staff_name_en : s.staff_name_ar}</small>
              </button>
            ))}
          </div>
        </div>
      ))}
      {error != null && <ErrorNote error={error} />}
      <div className="modal-foot"><button className="btn" onClick={onCancel}>{t("common.back")}</button></div>
    </div>
  );
}
