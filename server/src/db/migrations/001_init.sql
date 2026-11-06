-- Initial schema (SPEC §3).
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE admins (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE businesses (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 text NOT NULL,
  username             text NOT NULL UNIQUE,
  password_hash        text NOT NULL,
  must_change_password boolean NOT NULL DEFAULT true,
  api_key_hash         text UNIQUE,
  api_key_last4        text,
  timezone             text NOT NULL DEFAULT 'Asia/Amman',
  goes_to_customer     boolean NOT NULL DEFAULT false,
  staff_label_ar       text NOT NULL DEFAULT 'موظف',
  staff_label_en       text NOT NULL DEFAULT 'Staff',
  settings             jsonb NOT NULL DEFAULT '{}'::jsonb,
  webhook_url          text,
  webhook_secret       text,
  is_test              boolean NOT NULL DEFAULT false,
  active               boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE staff (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name_ar     text NOT NULL,
  name_en     text,
  phone       text,
  color       text NOT NULL DEFAULT '#4466F2',
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX staff_business_idx ON staff(business_id);

CREATE TABLE services (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name_ar      text NOT NULL,
  name_en      text,
  aliases      text[] NOT NULL DEFAULT '{}',
  duration_min integer NOT NULL CHECK (duration_min BETWEEN 5 AND 720),
  active       boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX services_business_idx ON services(business_id);

CREATE TABLE zones (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name_ar       text NOT NULL,
  name_en       text,
  aliases       text[] NOT NULL DEFAULT '{}',
  visit_fee_jod numeric(10,3),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX zones_business_idx ON zones(business_id);

CREATE TABLE staff_services (
  staff_id   uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  service_id uuid NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  PRIMARY KEY (staff_id, service_id)
);

CREATE TABLE staff_zones (
  staff_id uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  zone_id  uuid NOT NULL REFERENCES zones(id) ON DELETE CASCADE,
  PRIMARY KEY (staff_id, zone_id)
);

CREATE TABLE working_hours (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id    uuid NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  weekday     smallint NOT NULL CHECK (weekday BETWEEN 0 AND 6), -- 0 = Sunday … 6 = Saturday
  start_local time NOT NULL,
  end_local   time NOT NULL,
  CHECK (end_local > start_local)
);
CREATE INDEX working_hours_staff_idx ON working_hours(staff_id);

CREATE TABLE days_off (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  staff_id    uuid REFERENCES staff(id) ON DELETE CASCADE, -- NULL = whole business
  during      tstzrange NOT NULL,
  reason      text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX days_off_business_idx ON days_off USING gist (business_id, during);

CREATE TYPE booking_status AS ENUM ('confirmed', 'completed', 'cancelled', 'no_show');

CREATE TABLE bookings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id    uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  staff_id       uuid NOT NULL REFERENCES staff(id),
  service_id     uuid NOT NULL REFERENCES services(id),
  zone_id        uuid REFERENCES zones(id),
  status         booking_status NOT NULL DEFAULT 'confirmed',
  starts_at      timestamptz NOT NULL,
  ends_at        timestamptz NOT NULL,
  blocked        tstzrange NOT NULL, -- [starts_at, ends_at + gap)
  customer_name  text NOT NULL,
  customer_phone text NOT NULL,      -- E.164
  address        text,
  description    text,
  external_ref   text,
  visit_fee_jod  numeric(10,3),
  source         text NOT NULL CHECK (source IN ('api', 'panel')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  -- The double-booking rule: one staff member can never have two confirmed bookings whose blocked times overlap.
  CONSTRAINT bookings_no_overlap EXCLUDE USING gist (staff_id WITH =, blocked WITH &&) WHERE (status = 'confirmed')
);
CREATE INDEX bookings_business_time_idx ON bookings(business_id, starts_at);
CREATE INDEX bookings_business_phone_idx ON bookings(business_id, customer_phone);
CREATE UNIQUE INDEX bookings_business_ref_idx ON bookings(business_id, external_ref) WHERE external_ref IS NOT NULL;

CREATE TABLE booking_history (
  id         bigserial PRIMARY KEY,
  booking_id uuid NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  action     text NOT NULL,
  by         text NOT NULL CHECK (by IN ('api', 'business', 'admin')),
  data       jsonb NOT NULL DEFAULT '{}'::jsonb,
  at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX booking_history_booking_idx ON booking_history(booking_id);

CREATE TABLE idempotency_keys (
  business_id  uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  key          text NOT NULL,
  request_hash text NOT NULL,
  status_code  integer,
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, key)
);

CREATE TABLE webhook_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  event           text NOT NULL,
  payload         jsonb NOT NULL,
  attempt         integer NOT NULL DEFAULT 0,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries(next_attempt_at) WHERE status = 'pending';
