import { useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, type AdminBusiness } from "../api";
import { useI18n } from "../i18n";
import { CopyBox, ErrorNote, Field, Icon, Modal, Spinner, useAction, useLoad, useToast } from "../ui";

const ENDPOINT = () => `${location.origin}/v1`;

/** The "add a business" form. When it succeeds the API key is shown once, here. */
export function CreateBusiness({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { t } = useI18n();
  const [form, setForm] = useState({ name: "", username: "", password: "", goes_to_customer: true, is_test: false, staff_label_ar: "فني", staff_label_en: "Technician" });
  const [created, setCreated] = useState<{ business: AdminBusiness; api_key: string } | null>(null);
  const { pending, error, run } = useAction();
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await run(() => api.post<{ business: AdminBusiness; api_key: string }>("/panel/admin/businesses", form));
    if (r) {
      setCreated(r);
      onCreated();
    }
  };

  if (created) {
    return (
      <Modal title={t("adm.created")} onClose={onClose}>
        <div className="note warn">{t("adm.keyOnce")}</div>
        <Field label={t("adm.endpoint")}><CopyBox value={ENDPOINT()} /></Field>
        <Field label={t("adm.apiKey")}><CopyBox value={created.api_key} /></Field>
        <Field label={t("adm.username")}><CopyBox value={created.business.username} /></Field>
        <div className="modal-foot"><button className="btn primary" onClick={onClose}>{t("common.close")}</button></div>
      </Modal>
    );
  }
  return (
    <Modal title={t("adm.addBusiness")} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label={t("adm.businessName")}><input className="input" value={form.name} onChange={(e) => set("name", e.target.value)} required maxLength={100} /></Field>
        <div className="grid2">
          <Field label={t("adm.username")} hint="a-z 0-9 . _ -"><input className="input ltr-input" dir="ltr" autoCapitalize="none" value={form.username} onChange={(e) => set("username", e.target.value.toLowerCase())} required /></Field>
          <Field label={t("adm.initialPassword")}><input className="input ltr-input" dir="ltr" value={form.password} onChange={(e) => set("password", e.target.value)} required minLength={8} autoComplete="off" /></Field>
        </div>
        <div className="grid2">
          <Field label={t("adm.staffLabelAr")}><input className="input" value={form.staff_label_ar} onChange={(e) => set("staff_label_ar", e.target.value)} required /></Field>
          <Field label={t("adm.staffLabelEn")}><input className="input ltr-input" dir="ltr" value={form.staff_label_en} onChange={(e) => set("staff_label_en", e.target.value)} required /></Field>
        </div>
        <label className="check"><input type="checkbox" checked={form.goes_to_customer} onChange={(e) => set("goes_to_customer", e.target.checked)} />{t("adm.goesToCustomer")}</label>
        <label className="check"><input type="checkbox" checked={form.is_test} onChange={(e) => set("is_test", e.target.checked)} />{t("adm.isTest")}</label>
        {error != null && <ErrorNote error={error} />}
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn primary" disabled={pending}>{t("common.add")}</button>
        </div>
      </form>
    </Modal>
  );
}

export function BusinessDetail() {
  const { id } = useParams();
  const { t } = useI18n();
  const nav = useNavigate();
  const toast = useToast();
  const { data: b, error, loading, reload } = useLoad(() => api.get<AdminBusiness>(`/panel/admin/businesses/${id}`), [id]);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [webhook, setWebhook] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [confirmName, setConfirmName] = useState("");
  const [passwordDone, setPasswordDone] = useState(false);
  const act = useAction();

  if (loading && !b) return <Spinner />;
  if (error != null && !b) return <ErrorNote error={error} />;
  if (!b) return null;
  const base = `/panel/admin/businesses/${b.id}`;

  const regenerate = async () => {
    if (!confirm(t("adm.regenerateWarn"))) return;
    const r = await act.run(() => api.post<{ api_key: string }>(`${base}/api-key`));
    if (r) (setNewKey(r.api_key), reload());
  };
  const saveWebhook = async () => {
    const r = await act.run(() => api.patch(base, { webhook_url: webhook?.trim() ? webhook.trim() : null }));
    if (r) (toast(t("common.saved")), setWebhook(null), reload());
  };
  const resetPassword = async (e: FormEvent) => {
    e.preventDefault();
    const r = await act.run(() => api.post(`${base}/password`, { password: newPassword }));
    if (r) (setNewPassword(""), setPasswordDone(true));
  };
  const toggleActive = async () => {
    const r = await act.run(() => api.patch(base, { active: !b.active }));
    if (r) reload();
  };
  const open = async () => {
    const r = await act.run(() => api.post(`${base}/open`));
    if (r) nav("/app");
  };
  const resetTest = async () => {
    if (!confirm(t("adm.resetTestWarn"))) return;
    const r = await act.run(() => api.post(`${base}/reset-test-data`));
    if (r) toast(t("common.saved"));
  };
  const remove = async () => {
    const r = await act.run(() => api.del(base, { confirm_name: confirmName }));
    if (r) nav("/admin/businesses", { replace: true });
  };

  return (
    <>
      <header className="topbar">
        <button className="icon-btn" onClick={() => nav("/admin/businesses")} aria-label={t("common.back")}><Icon name="prev" className="flip" /></button>
        <h1>{b.name}</h1>
        {b.is_test && <span className="pill test">{t("adm.test")}</span>}
        {!b.active && <span className="pill off">{t("common.inactive")}</span>}
        <span className="spacer" />
        <button className="btn primary" onClick={open} disabled={act.pending}><Icon name="cal" />{t("adm.openCalendar")}</button>
      </header>
      {act.error != null && <ErrorNote error={act.error} />}

      <div className="stats">
        <div className="stat"><b>{b.total}</b><small>{t("adm.bookingsTotal")}</small></div>
        <div className="stat"><b style={{ color: "var(--success-ink)" }}>{b.confirmed}</b><small>{t("status.confirmed")}</small></div>
        <div className="stat"><b style={{ color: "var(--violet-ink)" }}>{b.completed}</b><small>{t("status.completed")}</small></div>
        <div className="stat"><b style={{ color: "var(--danger-ink)" }}>{b.cancelled}</b><small>{t("status.cancelled")}</small></div>
      </div>

      <section className="card stack">
        <h2>{t("adm.apiAccess")}</h2>
        <Field label={t("adm.endpoint")}><CopyBox value={ENDPOINT()} /></Field>
        <Field label={t("adm.apiKey")}>
          <div className="row"><code className="ltr muted">{b.api_key_last4 ? `bk_…${b.api_key_last4}` : "—"}</code><button className="btn" onClick={regenerate} disabled={act.pending}><Icon name="key" />{t("adm.regenerate")}</button></div>
        </Field>
        {newKey && <div className="stack"><div className="note warn">{t("adm.keyOnce")}</div><CopyBox value={newKey} /></div>}
        <a className="btn" href="/docs/guide/en" target="_blank" rel="noreferrer"><Icon name="book" />{t("adm.docs")}</a>
      </section>

      <section className="card stack">
        <h2>{t("adm.webhook")}</h2>
        <Field label={t("adm.webhookUrl")}>
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <input className="input ltr-input" dir="ltr" placeholder="https://" value={webhook ?? b.webhook_url ?? ""} onChange={(e) => setWebhook(e.target.value)} />
            <button className="btn primary" onClick={saveWebhook} disabled={act.pending || webhook === null}>{t("common.save")}</button>
          </div>
        </Field>
        {b.webhook_secret && <Field label={t("adm.webhookSecret")}><CopyBox value={b.webhook_secret} /></Field>}
      </section>

      <section className="card stack">
        <h2>{t("adm.owner")}</h2>
        <dl className="kv"><dt>{t("adm.username")}</dt><dd><span className="ltr">{b.username}</span></dd><dt>{t("adm.createdAt")}</dt><dd>{new Date(b.created_at).toLocaleDateString()}</dd></dl>
        <form className="row" style={{ flexWrap: "nowrap" }} onSubmit={resetPassword}>
          <input className="input ltr-input" dir="ltr" placeholder={t("adm.resetPassword")} value={newPassword} onChange={(e) => (setNewPassword(e.target.value), setPasswordDone(false))} minLength={8} required autoComplete="off" />
          <button className="btn" disabled={act.pending}>{t("common.save")}</button>
        </form>
        {passwordDone && <div className="note ok">{t("adm.resetPasswordDone")}</div>}
      </section>

      <section className="card stack">
        <h2>{t("adm.dangerZone")}</h2>
        <div className="row">
          <button className="btn" onClick={toggleActive} disabled={act.pending}>{b.active ? t("adm.switchOff") : t("adm.switchOn")}</button>
          {b.is_test && <button className="btn" onClick={resetTest} disabled={act.pending}>{t("adm.resetTest")}</button>}
        </div>
        <Field label={t("adm.deleteWarn")}>
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <input className="input" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={b.name} />
            <button className="btn danger" onClick={remove} disabled={act.pending || confirmName.trim() !== b.name}>{t("adm.deleteBusiness")}</button>
          </div>
        </Field>
      </section>
    </>
  );
}
