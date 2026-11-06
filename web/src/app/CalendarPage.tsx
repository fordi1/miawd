import { useEffect, useMemo, useState, type FormEvent } from "react";
import { api, type Booking, type BookingStatus, type Calendar, type Staff } from "../api";
import { addDays, addMonths, clock, dayMonth, dayNumber, fullDate, localParts, minutesOf, monthGrid, monthStart, monthTitle, timeOf, todayIn, weekStart, weekdayName } from "../dates";
import { useI18n, type Lang } from "../i18n";
import { Avatar, ErrorNote, Icon, LangSwitch, Modal, Spinner, StatusPill, useAction, useLoad } from "../ui";
import { BookingDrawer } from "./BookingDrawer";
import { NewBooking } from "./NewBooking";

type View = "day" | "week" | "month";
const HOUR_PX = 80;
const STATUSES: BookingStatus[] = ["confirmed", "completed", "cancelled", "no_show"];

export const nameOf = (x: { name_ar: string; name_en: string | null }, lang: Lang) => (lang === "en" && x.name_en ? x.name_en : x.name_ar);

function useIsMobile() {
  const query = "(max-width: 767px)";
  const [mobile, setMobile] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const m = window.matchMedia(query);
    const on = () => setMobile(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return mobile;
}

function rangeFor(view: View, cursor: string): { from: string; to: string } {
  if (view === "day") return { from: cursor, to: cursor };
  if (view === "week") return { from: weekStart(cursor), to: addDays(weekStart(cursor), 6) };
  const weeks = monthGrid(cursor);
  return { from: weeks[0]![0]!, to: weeks[weeks.length - 1]![6]! };
}

export function CalendarPage() {
  const { t, lang } = useI18n();
  const isMobile = useIsMobile();
  const [view, setView] = useState<View>("day");
  const [tzToday, setTzToday] = useState(() => todayIn("Asia/Amman"));
  const [cursor, setCursor] = useState(tzToday);
  const [staffFilter, setStaffFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<BookingStatus | "all">("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ date: string } | null>(null);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<Booking[] | null>(null);
  const searching = useAction();

  const range = useMemo(() => rangeFor(view, cursor), [view, cursor]);
  const { data, error, loading, reload } = useLoad(() => api.get<Calendar>("/panel/app/calendar", range), [range.from, range.to]);
  const tz = data?.timezone ?? "Asia/Amman";

  useEffect(() => {
    if (data) setTzToday(todayIn(data.timezone));
  }, [data]);
  useEffect(() => {
    const open = () => setCreating({ date: cursor });
    window.addEventListener("mawid:new-booking", open);
    return () => window.removeEventListener("mawid:new-booking", open);
  }, [cursor]);

  const bookings = useMemo(
    () => (data?.bookings ?? []).filter((b) => (staffFilter === "all" || b.staff_id === staffFilter) && (statusFilter === "all" || b.status === statusFilter)),
    [data, staffFilter, statusFilter],
  );
  const byDay = useMemo(() => {
    const m = new Map<string, Booking[]>();
    for (const b of bookings) {
      const d = localParts(b.start_at, tz).date;
      m.set(d, [...(m.get(d) ?? []), b]);
    }
    return m;
  }, [bookings, tz]);
  const staffById = useMemo(() => new Map((data?.staff ?? []).map((s) => [s.id, s])), [data]);

  const step = (dir: 1 | -1) => setCursor((c) => (view === "day" ? addDays(c, dir) : view === "week" ? addDays(c, 7 * dir) : addMonths(c, dir)));
  const title = view === "day" ? fullDate(cursor, lang) : view === "week" ? `${dayMonth(range.from, lang)} – ${dayMonth(range.to, lang)}` : monthTitle(cursor, lang);

  const submitSearch = async (e: FormEvent) => {
    e.preventDefault();
    const q = search.trim();
    if (!q) return;
    const isPhone = /^[+\d٠-٩۰-۹\s-]{7,}$/.test(q);
    const found = await searching.run(() => api.get<{ bookings: Booking[] }>("/panel/app/bookings", isPhone ? { phone: q } : { external_ref: q }));
    if (found) setResults(found.bookings);
  };

  const dayBookings = byDay.get(cursor) ?? [];
  const counts = STATUSES.map((s) => [s, dayBookings.filter((b) => b.status === s).length] as const);

  return (
    <>
      <header className="topbar">
        <h1>{t("nav.calendar")}</h1>
        <form className="searchbox" onSubmit={submitSearch} role="search">
          <Icon name="search" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("cal.searchPlaceholder")} aria-label={t("common.search")} />
        </form>
        <span className="spacer" />
        <LangSwitch />
      </header>

      <div className="cal-tools">
        <div className="seg" role="tablist">
          {(["day", "week", "month"] as View[]).map((v) => <button key={v} className={view === v ? "on" : ""} onClick={() => setView(v)}>{t(`cal.${v}`)}</button>)}
        </div>
        <div className="date-nav">
          <button className="icon-btn" onClick={() => step(-1)} aria-label={t("cal.prev")}><Icon name="prev" className="flip" /></button>
          <span className="title">{title}</span>
          <button className="icon-btn" onClick={() => step(1)} aria-label={t("cal.next")}><Icon name="next" className="flip" /></button>
        </div>
        <button className="btn" onClick={() => setCursor(tzToday)}>{t("common.today")}</button>
        <button className="btn primary" onClick={() => setCreating({ date: cursor })}><Icon name="plus" />{t("cal.newBooking")}</button>
      </div>

      <div className="cal-tools">
        <div className="chips" aria-label="staff">
          <button className={`chip ${staffFilter === "all" ? "on" : ""}`} onClick={() => setStaffFilter("all")}>{t("common.all")}</button>
          {(data?.staff ?? []).map((s) => (
            <button key={s.id} className={`chip ${staffFilter === s.id ? "on" : ""}`} onClick={() => setStaffFilter(s.id)}>
              <Avatar name={nameOf(s, lang)} color={s.color} size={22} />{nameOf(s, lang)}
            </button>
          ))}
        </div>
        <div className="chips" aria-label="status">
          <button className={`chip ${statusFilter === "all" ? "on" : ""}`} onClick={() => setStatusFilter("all")}>{t("common.all")}</button>
          {STATUSES.map((s) => <button key={s} className={`chip ${statusFilter === s ? "on" : ""}`} onClick={() => setStatusFilter(s)}>{t(`status.${s}`)}</button>)}
        </div>
      </div>

      {error != null && <ErrorNote error={error} />}

      <div className="cal-layout">
        <section style={{ minWidth: 0 }}>
          {loading && !data ? <Spinner /> : data && (
            view === "day" ? (
              isMobile
                ? <Agenda days={[cursor]} byDay={byDay} staffById={staffById} tz={tz} today={tzToday} onOpen={setOpenId} />
                : <DayBoard cal={data} date={cursor} bookings={dayBookings} staffFilter={staffFilter} tz={tz} today={tzToday} onOpen={setOpenId} />
            ) : view === "week" ? (
              <WeekView days={Array.from({ length: 7 }, (_, i) => addDays(range.from, i))} byDay={byDay} tz={tz} today={tzToday} onOpen={setOpenId} onDay={(d) => (setCursor(d), setView("day"))} />
            ) : (
              <MonthView cursor={cursor} byDay={byDay} today={tzToday} onDay={(d) => (setCursor(d), setView("day"))} />
            )
          )}
        </section>

        <aside className="rail">
          <section className="card">
            <h2>{t("cal.summary")} <small className="muted" style={{ fontWeight: 500 }}>— {dayMonth(cursor, lang)}</small></h2>
            <div className="stats">
              {counts.map(([s, n]) => <div className="stat" key={s}><b>{n}</b><small>{t(`status.${s}`)}</small></div>)}
            </div>
          </section>
          <section className="card">
            <h2>{t("cal.agenda")}</h2>
            {dayBookings.length === 0 ? <div className="empty">{t("cal.nothing")}</div> : (
              <div className="agenda">{dayBookings.slice(0, 8).map((b) => <BookingCard key={b.id} b={b} staff={staffById.get(b.staff_id)} tz={tz} today={tzToday} onOpen={setOpenId} compact />)}</div>
            )}
          </section>
          <section className="card">
            <MiniMonth cursor={cursor} byDay={byDay} today={tzToday} onPick={(d) => (setCursor(d), setView("day"))} onMonth={(n) => setCursor(addMonths(cursor, n))} />
          </section>
        </aside>
      </div>

      <button className="fab" onClick={() => setCreating({ date: cursor })} aria-label={t("cal.newBooking")}><Icon name="plus" /></button>

      {openId && data && <BookingDrawer id={openId} cal={data} onClose={() => setOpenId(null)} onChanged={reload} />}
      {creating && data && <NewBooking cal={data} date={creating.date} onClose={() => setCreating(null)} onCreated={(b) => (setCreating(null), reload(), setOpenId(b.id))} />}
      {results && data && (
        <Modal title={t("cal.results")} onClose={() => setResults(null)}>
          {results.length === 0 ? <div className="empty">{t("cal.noResults")}</div> : (
            <div className="agenda">
              {results.map((b) => <BookingCard key={b.id} b={b} staff={staffById.get(b.staff_id)} tz={tz} today={tzToday} showDate onOpen={(id) => (setResults(null), setOpenId(id))} />)}
            </div>
          )}
        </Modal>
      )}
      {searching.error != null && <ErrorNote error={searching.error} />}
    </>
  );
}

// ---- a booking as a card (agenda, search results) ------------------------------------------------------------
function isNow(b: Booking) {
  const now = Date.now();
  return b.status === "confirmed" && new Date(b.start_at).getTime() <= now && now < new Date(b.end_at).getTime();
}

export function BookingCard({ b, staff, tz, today, onOpen, compact, showDate }: {
  b: Booking; staff?: Staff; tz: string; today: string; onOpen: (id: string) => void; compact?: boolean; showDate?: boolean;
}) {
  const { t, lang } = useI18n();
  const day = localParts(b.start_at, tz).date;
  const service = lang === "en" && b.service_name_en ? b.service_name_en : b.service_name_ar;
  return (
    <button className={`bcard ${b.status === "cancelled" ? "cancelled" : ""} ${isNow(b) ? "now" : ""}`} onClick={() => onOpen(b.id)}>
      <div className="body">
        <div className="t">{service}{b.description ? ` — ${b.description}` : ""}</div>
        <div className="time">
          {showDate && <>{day === today ? t("common.today") : dayMonth(day, lang)} · </>}
          <bdi>{timeOf(b.start_at, tz, lang)}</bdi> – <bdi>{timeOf(b.end_at, tz, lang)}</bdi>
        </div>
        {!compact && <div className="sub">{b.customer_name}{b.zone_name_ar ? ` · ${b.zone_name_ar}` : ""}</div>}
        {compact && <div className="sub">{b.customer_name}</div>}
      </div>
      {staff && <Avatar name={nameOf(staff, lang)} color={staff.color} size={32} />}
      {!isNow(b) && b.status !== "confirmed" && <StatusPill status={b.status} />}
      {isNow(b) && <span className="pill" style={{ background: "rgba(255,255,255,.25)", color: "#fff" }}>{t("status.now")}</span>}
    </button>
  );
}

// ---- views --------------------------------------------------------------------------------------------------------
function Agenda({ days, byDay, staffById, tz, today, onOpen }: {
  days: string[]; byDay: Map<string, Booking[]>; staffById: Map<string, Staff>; tz: string; today: string; onOpen: (id: string) => void;
}) {
  const { t, lang } = useI18n();
  return (
    <div className="agenda">
      {days.map((d) => (
        <div key={d} className="agenda">
          <div className={`day-head ${d === today ? "today" : ""}`}><b>{dayNumber(d)}</b><small>{weekdayName(d, lang)}</small></div>
          {(byDay.get(d) ?? []).length === 0 ? <div className="empty">{t("cal.nothing")}</div> : (byDay.get(d) ?? []).map((b) => <BookingCard key={b.id} b={b} staff={staffById.get(b.staff_id)} tz={tz} today={today} onOpen={onOpen} />)}
        </div>
      ))}
    </div>
  );
}

function DayBoard({ cal, date, bookings, staffFilter, tz, today, onOpen }: {
  cal: Calendar; date: string; bookings: Booking[]; staffFilter: string; tz: string; today: string; onOpen: (id: string) => void;
}) {
  const { t, lang } = useI18n();
  const staff = cal.staff.filter((s) => staffFilter === "all" || s.id === staffFilter);
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();

  // visible hours: 08–20 by default, wider if working hours or bookings need it
  let startH = 8;
  let endH = 20;
  for (const s of staff) for (const h of s.hours) if (h.weekday === weekday) {
    startH = Math.min(startH, +h.start.slice(0, 2));
    endH = Math.max(endH, Math.ceil(+h.end.slice(0, 2) + +h.end.slice(3, 5) / 60));
  }
  for (const b of bookings) {
    startH = Math.min(startH, Math.floor(minutesOf(localParts(b.start_at, tz)) / 60));
    endH = Math.max(endH, Math.ceil(minutesOf(localParts(b.end_at, tz)) / 60));
  }
  const hours = Array.from({ length: Math.max(1, endH - startH) }, (_, i) => startH + i);
  const px = (min: number) => ((min - startH * 60) / 60) * HOUR_PX;

  const offFor = (staffId: string) =>
    cal.days_off
      .filter((o) => o.staff_id === null || o.staff_id === staffId)
      .map((o) => {
        const a = localParts(o.start_at, tz);
        const z = localParts(o.end_at, tz);
        const from = a.date < date ? 0 : a.date === date ? minutesOf(a) : 24 * 60;
        const to = z.date > date ? 24 * 60 : z.date === date ? minutesOf(z) : 0;
        return { id: o.id, from: Math.max(from, startH * 60), to: Math.min(to, endH * 60), reason: o.reason };
      })
      .filter((o) => o.to > o.from);

  const nowMin = date === today ? minutesOf(localParts(new Date().toISOString(), tz)) : null;
  if (staff.length === 0) return <div className="card empty">{t("common.none")}</div>;

  return (
    <div className="card board">
      <div className="board-scroll">
        <div className="board-head" style={{ ["--cols" as string]: staff.length }}>
          <div />
          {staff.map((s) => (
            <div className="who" key={s.id}><Avatar name={nameOf(s, lang)} color={s.color} size={36} /><b>{nameOf(s, lang)}</b></div>
          ))}
        </div>
        <div className="board-body" style={{ ["--cols" as string]: staff.length, position: "relative" }}>
          <div className="hours">{hours.map((h) => <div key={h}>{clock(h, 0, lang)}</div>)}</div>
          {staff.map((s) => (
            <div className="col" key={s.id} style={{ height: hours.length * HOUR_PX }}>
              {offFor(s.id).map((o) => (
                <div key={o.id} className="off-block" style={{ top: px(o.from), height: px(o.to) - px(o.from) }}>{t("cal.dayOff")}{o.reason ? ` — ${o.reason}` : ""}</div>
              ))}
              {bookings.filter((b) => b.staff_id === s.id).map((b) => {
                const a = minutesOf(localParts(b.start_at, tz));
                const z = minutesOf(localParts(b.end_at, tz));
                const service = lang === "en" && b.service_name_en ? b.service_name_en : b.service_name_ar;
                return (
                  <button key={b.id} className={`ev ${b.status} ${isNow(b) ? "now" : ""}`} style={{ top: px(a) + 2, height: Math.max(px(z) - px(a) - 4, 34), zIndex: 1 }} onClick={() => onOpen(b.id)}>
                    <span className="t">{service}{b.description ? ` — ${b.description}` : ""}</span>
                    <span className="time"><bdi>{timeOf(b.start_at, tz, lang)}</bdi> – <bdi>{timeOf(b.end_at, tz, lang)}</bdi></span>
                    <span className="who2">{b.customer_name}{b.zone_name_ar ? ` · ${b.zone_name_ar}` : ""}</span>
                  </button>
                );
              })}
            </div>
          ))}
          {nowMin !== null && nowMin >= startH * 60 && nowMin <= endH * 60 && <div className="now-line" style={{ top: px(nowMin) }} />}
        </div>
      </div>
    </div>
  );
}

function WeekView({ days, byDay, tz, today, onOpen, onDay }: {
  days: string[]; byDay: Map<string, Booking[]>; tz: string; today: string; onOpen: (id: string) => void; onDay: (d: string) => void;
}) {
  const { t, lang } = useI18n();
  return (
    <div className="weekgrid">
      {days.map((d) => (
        <div key={d} className={`weekcol ${d === today ? "today" : ""}`}>
          <button onClick={() => onDay(d)}><h3>{weekdayName(d, lang, "short")}<b>{dayNumber(d)}</b></h3></button>
          {(byDay.get(d) ?? []).length === 0 && <div className="muted" style={{ textAlign: "center", fontSize: 12 }}>{t("cal.nothing")}</div>}
          {(byDay.get(d) ?? []).map((b) => (
            <button key={b.id} className={`mini ${b.status}`} onClick={() => onOpen(b.id)}>
              <bdi>{timeOf(b.start_at, tz, lang)}</bdi>
              <span>{b.customer_name}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function MonthView({ cursor, byDay, today, onDay }: { cursor: string; byDay: Map<string, Booking[]>; today: string; onDay: (d: string) => void }) {
  const { lang } = useI18n();
  const weeks = monthGrid(cursor);
  return (
    <div className="monthgrid">
      {weeks[0]!.map((d) => <div className="dn" key={d}>{weekdayName(d, lang, "short")}</div>)}
      {weeks.flat().map((d) => {
        const n = (byDay.get(d) ?? []).filter((b) => b.status !== "cancelled").length;
        return (
          <button key={d} className={`daycell ${d === today ? "today" : ""} ${d === cursor ? "sel" : ""} ${d.slice(0, 7) !== cursor.slice(0, 7) ? "dim" : ""}`} onClick={() => onDay(d)}>
            <b>{dayNumber(d)}</b>{n > 0 && <small>{n}</small>}
          </button>
        );
      })}
    </div>
  );
}

function MiniMonth({ cursor, byDay, today, onPick, onMonth }: { cursor: string; byDay: Map<string, Booking[]>; today: string; onPick: (d: string) => void; onMonth: (n: 1 | -1) => void }) {
  const { lang } = useI18n();
  const weeks = monthGrid(monthStart(cursor));
  return (
    <>
      <div className="row between" style={{ marginBottom: 6 }}>
        <button className="icon-btn" onClick={() => onMonth(-1)}><Icon name="prev" className="flip" /></button>
        <b>{monthTitle(cursor, lang)}</b>
        <button className="icon-btn" onClick={() => onMonth(1)}><Icon name="next" className="flip" /></button>
      </div>
      <div className="mini-cal">
        {weeks[0]!.map((d) => <div className="dn" key={d}>{weekdayName(d, lang, "short")}</div>)}
        {weeks.flat().map((d) => (
          <button key={d} className={`${d === today ? "today" : ""} ${d === cursor ? "sel" : ""} ${d.slice(0, 7) !== cursor.slice(0, 7) ? "dim" : ""} ${byDay.has(d) ? "has" : ""}`} onClick={() => onPick(d)}><span>{dayNumber(d)}</span></button>
        ))}
      </div>
    </>
  );
}
