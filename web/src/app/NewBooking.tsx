import { useState, type FormEvent } from "react";
import { api, type Booking, type Calendar, type Slot } from "../api";
import { clock } from "../dates";
import { useI18n } from "../i18n";
import { ErrorNote, Field, Modal, Spinner, useAction, useLoad } from "../ui";
import { nameOf } from "./CalendarPage";
import { useMe } from "./BusinessApp";

/** Manual booking: service (and zone) → a free time (with its staff member) → customer → save. */
export function NewBooking({ cal, date: initialDate, onClose, onCreated }: { cal: Calendar; date: string; onClose: () => void; onCreated: (b: Booking) => void }) {
  const { t, lang } = useI18n();
  const me = useMe();
  const [serviceId, setServiceId] = useState(cal.services[0]?.id ?? "");
  const [zoneId, setZoneId] = useState("");
  const [date, setDate] = useState(initialDate);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [f, setF] = useState({ customer_name: "", customer_phone: "", description: "", address: "", external_ref: "" });
  const { pending, error, run } = useAction();

  const { data, loading } = useLoad(
    () => (serviceId ? api.get<{ slots: Slot[] }>("/panel/app/slots", { service_id: serviceId, zone_id: zoneId || undefined, date_from: date, date_to: date }) : Promise.resolve({ slots: [] })),
    [serviceId, zoneId, date],
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!slot) return;
    const body = {
      service_id: serviceId, zone_id: zoneId || null, staff_id: slot.staff_id, start_at: slot.start_at,
      customer_name: f.customer_name, customer_phone: f.customer_phone,
      ...(f.description && { description: f.description }), ...(f.address && { address: f.address }), ...(f.external_ref && { external_ref: f.external_ref }),
    };
    const made = await run(() => api.post<Booking>("/panel/app/bookings", body));
    if (made) onCreated(made);
  };

  if (cal.services.length === 0) return <Modal title={t("nb.title")} onClose={onClose}><div className="note">{t("team.noServices")}</div></Modal>;

  return (
    <Modal title={t("nb.title")} onClose={onClose} wide>
      <form className="stack" onSubmit={submit}>
        <div className="grid2">
          <Field label={t("nb.service")}>
            <select className="input" value={serviceId} onChange={(e) => (setServiceId(e.target.value), setSlot(null))}>
              {cal.services.map((s) => <option key={s.id} value={s.id}>{nameOf(s, lang)} ({s.duration_min} {t("common.minutes")})</option>)}
            </select>
          </Field>
          <Field label={t("nb.date")}>
            <input className="input ltr-input" dir="ltr" type="date" value={date} onChange={(e) => e.target.value && (setDate(e.target.value), setSlot(null))} />
          </Field>
        </div>
        {me.goes_to_customer && cal.zones.length > 0 && (
          <Field label={t("nb.zone")}>
            <select className="input" value={zoneId} onChange={(e) => (setZoneId(e.target.value), setSlot(null))}>
              <option value="">{t("nb.anyZone")}</option>
              {cal.zones.map((z) => <option key={z.id} value={z.id}>{nameOf(z, lang)}{z.visit_fee_jod ? ` — ${Number(z.visit_fee_jod)} ${t("common.jod")}` : ""}</option>)}
            </select>
          </Field>
        )}

        <div>
          <div className="label" style={{ marginBottom: 6 }}>{t("nb.times")}</div>
          {loading ? <Spinner /> : (data?.slots.length ?? 0) === 0 ? <div className="note">{t("bk.noTimes")}</div> : (
            <div className="slotlist">
              {data!.slots.map((s) => (
                <button type="button" key={s.start_at + s.staff_id} className={`slotbtn ${slot?.start_at === s.start_at && slot.staff_id === s.staff_id ? "on" : ""}`} onClick={() => setSlot(s)}>
                  <bdi>{clock(+s.local_time.slice(0, 2), +s.local_time.slice(3, 5), lang)}</bdi>
                  <small>{lang === "en" && s.staff_name_en ? s.staff_name_en : s.staff_name_ar}</small>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="grid2">
          <Field label={t("nb.name")}><input className="input" value={f.customer_name} onChange={(e) => setF({ ...f, customer_name: e.target.value })} required /></Field>
          <Field label={t("common.phone")}><input className="input ltr-input" dir="ltr" type="tel" placeholder="07XXXXXXXX" value={f.customer_phone} onChange={(e) => setF({ ...f, customer_phone: e.target.value })} required /></Field>
        </div>
        <Field label={t("nb.details")}><input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <div className="grid2">
          <Field label={t("nb.address")}><input className="input" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
          <Field label={t("nb.ref")}><input className="input ltr-input" dir="ltr" value={f.external_ref} onChange={(e) => setF({ ...f, external_ref: e.target.value })} /></Field>
        </div>
        {error != null && <ErrorNote error={error} />}
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn primary" disabled={pending || !slot} title={slot ? "" : t("nb.pickTime")}>{t("nb.create")}</button>
        </div>
      </form>
    </Modal>
  );
}
