-- Raw Material OS persistence baseline · PostgreSQL 15+
-- Physical-material trading only. No financial settlement product is modeled.

create extension if not exists pgcrypto;

-- Baseline migration is intentionally rerunnable. Enum labels are immutable
-- domain vocabulary; any label change must be a reviewed migration.
do $$ begin create type organization_member_role as enum ('OWNER', 'ADMIN', 'BUYER', 'SUPPLIER', 'OPERATOR', 'AUDITOR'); exception when duplicate_object then null; end $$;
do $$ begin create type evidence_state as enum ('PENDING', 'VALID', 'EXPIRED', 'REJECTED', 'SUPERSEDED'); exception when duplicate_object then null; end $$;
do $$ begin create type lot_state as enum ('DRAFT', 'PENDING_VERIFICATION', 'VERIFIED_ELIGIBLE', 'RESERVED', 'DELIVERED', 'INSPECTED', 'DISPUTED', 'QUARANTINED', 'EXPIRED'); exception when duplicate_object then null; end $$;
do $$ begin create type offer_state as enum ('DRAFT', 'VISIBLE', 'PAUSED', 'EXPIRED', 'WITHDRAWN'); exception when duplicate_object then null; end $$;
do $$ begin create type order_state as enum ('SUBMITTED', 'COUNTERED', 'PARTIALLY_ACCEPTED', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED', 'TRADE_CONFIRMED'); exception when duplicate_object then null; end $$;
do $$ begin create type reservation_state as enum ('ACTIVE', 'RELEASED', 'CONSUMED', 'DISPUTED'); exception when duplicate_object then null; end $$;
do $$ begin create type trade_state as enum ('CONFIRMED', 'DELIVERED', 'INSPECTED', 'DISPUTED', 'SETTLEMENT_HOLD', 'COMPLETED', 'CANCELLED'); exception when duplicate_object then null; end $$;
do $$ begin create type actor_kind as enum ('HUMAN', 'AI', 'SYSTEM'); exception when duplicate_object then null; end $$;
do $$ begin create type approval_state as enum ('PENDING', 'APPROVED', 'CHANGES_REQUESTED', 'HELD', 'REJECTED'); exception when duplicate_object then null; end $$;
do $$ begin create type supplier_verification_state as enum ('REQUESTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'EXPIRED'); exception when duplicate_object then null; end $$;

create table if not exists organizations (
  organization_id uuid primary key default gen_random_uuid(),
  legal_name text not null,
  business_registration_ref text,
  verified_at timestamptz,
  verification_evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- Supplier qualification is requested by a supplier but completed only by an
-- authorized human reviewer. It is deliberately separate from lot evidence.
create table if not exists supplier_verification_requests (
  request_id uuid primary key default gen_random_uuid(),
  approval_id text not null,
  organization_id uuid not null references organizations(organization_id),
  requested_by uuid not null,
  business_registration_ref text not null,
  evidence_refs jsonb not null default '{}'::jsonb,
  state supplier_verification_state not null default 'REQUESTED',
  decision_note text,
  decided_by uuid,
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  check (jsonb_typeof(evidence_refs) = 'object')
);
create index if not exists supplier_verification_requests_org_idx on supplier_verification_requests(organization_id, requested_at desc);
create unique index if not exists supplier_verification_requests_approval_idx on supplier_verification_requests(approval_id);
create unique index if not exists supplier_verification_requests_open_idx
  on supplier_verification_requests(organization_id)
  where state in ('REQUESTED'::supplier_verification_state, 'UNDER_REVIEW'::supplier_verification_state);

create table if not exists organization_members (
  organization_id uuid not null references organizations(organization_id),
  user_id uuid not null,
  role organization_member_role not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table if not exists materials (
  material_id text primary key,
  canonical_name text not null,
  status text not null default 'PENDING_HUMAN_APPROVAL',
  provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists material_aliases (
  material_id text not null references materials(material_id),
  alias text not null,
  normalized_alias text generated always as (lower(regexp_replace(alias, '[[:space:]]+', '', 'g'))) stored,
  primary key (material_id, alias)
);
create unique index if not exists material_aliases_normalized_idx on material_aliases(normalized_alias);

create table if not exists specifications (
  spec_id text primary key,
  material_id text not null references materials(material_id),
  version integer not null default 1 check (version > 0),
  status text not null default 'PENDING_HUMAN_APPROVAL',
  attributes jsonb not null,
  source_evidence_ids uuid[] not null default '{}',
  approved_by uuid,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (material_id, version)
);

create table if not exists lots (
  lot_id text primary key,
  supplier_organization_id uuid not null references organizations(organization_id),
  spec_id text not null references specifications(spec_id),
  state lot_state not null default 'DRAFT',
  total_quantity numeric(18, 3) not null check (total_quantity > 0),
  available_quantity numeric(18, 3) not null check (available_quantity >= 0),
  reserved_quantity numeric(18, 3) not null default 0 check (reserved_quantity >= 0),
  ask_price numeric(18, 4) not null check (ask_price > 0),
  currency char(3) not null default 'KRW',
  price_unit text not null default 'KRW_PER_KG',
  quantity_unit text not null default 'KG',
  delivery_days integer not null check (delivery_days >= 0),
  manufacture_date date,
  expiry_date date,
  storage_conditions jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (available_quantity + reserved_quantity <= total_quantity)
);
alter table lots add column if not exists price_unit text not null default 'KRW_PER_KG';
alter table lots add column if not exists quantity_unit text not null default 'KG';

create table if not exists evidences (
  evidence_id uuid primary key default gen_random_uuid(),
  lot_id text not null references lots(lot_id),
  organization_id uuid references organizations(organization_id),
  submitted_by uuid,
  evidence_type text not null check (evidence_type in ('COA', 'SDS', 'TDS', 'LOT_TRACE', 'INVENTORY_PROOF', 'SUPPLIER_VERIFICATION')),
  document_version text not null,
  content_sha256 char(64) not null,
  storage_ref text not null,
  issued_at date,
  expires_at date,
  state evidence_state not null default 'PENDING',
  extracted_attributes jsonb not null default '{}'::jsonb,
  reviewed_by uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (lot_id, evidence_type, document_version)
);
create index if not exists evidences_active_idx on evidences(lot_id, evidence_type, state, expires_at);

create table if not exists offers (
  offer_id uuid primary key default gen_random_uuid(),
  lot_id text not null references lots(lot_id),
  spec_id text not null references specifications(spec_id),
  state offer_state not null default 'DRAFT',
  visible_quantity numeric(18, 3) not null check (visible_quantity > 0),
  price numeric(18, 4) not null check (price > 0),
  valid_until timestamptz,
  version integer not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  unique (lot_id, version)
);

create table if not exists purchase_orders (
  order_id uuid primary key default gen_random_uuid(),
  buyer_organization_id uuid not null references organizations(organization_id),
  spec_id text not null references specifications(spec_id),
  -- Copy the exact approved Material Master attributes into the order.
  -- The spec id alone is not sufficient for a tamper-resistant trade snapshot.
  spec_attributes jsonb not null default '{}'::jsonb,
  product_type text not null default 'PHYSICAL_MATERIAL' check (product_type = 'PHYSICAL_MATERIAL'),
  state order_state not null default 'SUBMITTED',
  bid_price numeric(18, 4) not null check (bid_price > 0),
  currency char(3) not null default 'KRW',
  price_unit text not null default 'KRW_PER_KG',
  quantity_unit text not null default 'KG',
  requested_quantity numeric(18, 3) not null check (requested_quantity > 0),
  delivery_deadline date not null,
  partial_fill_allowed boolean not null default true,
  idempotency_key text,
  counter_offer jsonb,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
alter table purchase_orders add column if not exists spec_attributes jsonb not null default '{}'::jsonb;
alter table purchase_orders add column if not exists currency char(3) not null default 'KRW';
alter table purchase_orders add column if not exists price_unit text not null default 'KRW_PER_KG';
alter table purchase_orders add column if not exists quantity_unit text not null default 'KG';
alter table purchase_orders add column if not exists idempotency_key text;
create unique index if not exists purchase_orders_buyer_idempotency_idx
  on purchase_orders(buyer_organization_id, idempotency_key)
  where idempotency_key is not null;

create table if not exists reservations (
  reservation_id uuid primary key default gen_random_uuid(),
  order_id uuid not null references purchase_orders(order_id),
  lot_id text not null references lots(lot_id),
  quantity numeric(18, 3) not null check (quantity > 0),
  state reservation_state not null default 'ACTIVE',
  idempotency_key text not null unique,
  reserved_at timestamptz not null default now(),
  released_at timestamptz
);
create unique index if not exists one_active_reservation_per_order_lot on reservations(order_id, lot_id) where state = 'ACTIVE';

create table if not exists trades (
  trade_id uuid primary key default gen_random_uuid(),
  order_id uuid not null references purchase_orders(order_id),
  supplier_organization_id uuid not null references organizations(organization_id),
  buyer_organization_id uuid not null references organizations(organization_id),
  lot_id text not null references lots(lot_id),
  state trade_state not null default 'CONFIRMED',
  price numeric(18, 4) not null check (price > 0),
  quantity numeric(18, 3) not null check (quantity > 0),
  currency char(3) not null default 'KRW',
  price_unit text not null default 'KRW_PER_KG',
  quantity_unit text not null default 'KG',
  delivery_deadline date not null,
  spec_snapshot jsonb not null,
  lot_snapshot jsonb not null,
  evidence_snapshot jsonb not null,
  pretrade_checks jsonb not null,
  trade_snapshot_hash char(64) not null,
  confirmed_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (order_id, lot_id)
);
alter table trades add column if not exists currency char(3) not null default 'KRW';
alter table trades add column if not exists price_unit text not null default 'KRW_PER_KG';
alter table trades add column if not exists quantity_unit text not null default 'KG';

create table if not exists trade_inspections (
  trade_id uuid primary key references trades(trade_id),
  reservation_id uuid not null references reservations(reservation_id),
  spec_match boolean not null,
  quality_pass boolean not null,
  state text not null check (state in ('COMPLETED', 'DISPUTED')),
  note text not null default '',
  inspected_by uuid not null,
  inspected_at timestamptz not null default now()
);
create index if not exists trade_inspections_state_idx on trade_inspections(state, inspected_at);

create table if not exists trade_events (
  event_id uuid primary key default gen_random_uuid(),
  trade_id uuid references trades(trade_id),
  order_id uuid references purchase_orders(order_id),
  lot_id text references lots(lot_id),
  actor_kind actor_kind not null,
  actor_ref text not null,
  event_type text not null,
  before_state jsonb,
  after_state jsonb,
  correlation_id text not null,
  created_at timestamptz not null default now()
);
create index if not exists trade_events_correlation_idx on trade_events(correlation_id, created_at);

-- Operational approvals are separate from trade execution. A decision here
-- authorizes the next work step; it never directly releases a trade or payment.
create table if not exists operational_approvals (
  approval_id text primary key,
  task_id text not null,
  source_run_id text not null,
  required_principal text not null default 'H-01',
  objective text not null,
  risk text not null,
  reviewers jsonb not null default '[]'::jsonb,
  state approval_state not null default 'PENDING',
  decision text,
  decision_note text,
  decided_by uuid,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  check ((state = 'PENDING' and decided_at is null and decided_by is null) or (state <> 'PENDING' and decided_at is not null and decided_by is not null))
);

create table if not exists approval_events (
  approval_event_id uuid primary key default gen_random_uuid(),
  approval_id text not null references operational_approvals(approval_id),
  actor_kind actor_kind not null,
  actor_ref text not null,
  previous_state approval_state,
  next_state approval_state not null,
  decision_note text,
  correlation_id text not null,
  created_at timestamptz not null default now()
);
create index if not exists approval_events_correlation_idx on approval_events(correlation_id, created_at);

-- Runtime recovery journal for the current API snapshot boundary.
-- It is append-only; relational tables above remain the authoritative domain model.
create table if not exists ledger_snapshots (
  snapshot_id bigserial primary key,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists ledger_snapshots_created_idx on ledger_snapshots(snapshot_id desc);

create table if not exists evidence_snapshots (
  snapshot_id bigserial primary key,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists evidence_snapshots_created_idx on evidence_snapshots(snapshot_id desc);

-- Durable, provenance-carrying observations used by the source-governed price
-- index. A completed physical trade is an observation; it is not a financial
-- instrument or a settlement record.
create table if not exists price_observations (
  observation_id text primary key,
  source_type text not null,
  spec_id text not null references specifications(spec_id),
  supplier_id text,
  trade_id text,
  quote_id text,
  price numeric(18, 4) not null check (price > 0),
  quantity numeric(18, 3) not null check (quantity > 0),
  currency char(3) not null default 'KRW' check (currency = 'KRW'),
  price_unit text not null default 'KRW_PER_KG' check (price_unit = 'KRW_PER_KG'),
  quantity_unit text not null default 'KG' check (quantity_unit = 'KG'),
  fulfilled_at date,
  evidence_status text,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
alter table price_observations add column if not exists currency char(3) not null default 'KRW';
alter table price_observations add column if not exists price_unit text not null default 'KRW_PER_KG';
alter table price_observations add column if not exists quantity_unit text not null default 'KG';
do $$ begin alter table price_observations add constraint price_observations_currency_ck check (currency = 'KRW') not valid; exception when duplicate_object then null; end $$;
do $$ begin alter table price_observations add constraint price_observations_price_unit_ck check (price_unit = 'KRW_PER_KG') not valid; exception when duplicate_object then null; end $$;
do $$ begin alter table price_observations add constraint price_observations_quantity_unit_ck check (quantity_unit = 'KG') not valid; exception when duplicate_object then null; end $$;
alter table price_observations validate constraint price_observations_currency_ck;
alter table price_observations validate constraint price_observations_price_unit_ck;
alter table price_observations validate constraint price_observations_quantity_unit_ck;
create index if not exists price_observations_spec_date_idx on price_observations(spec_id, fulfilled_at, created_at);

-- The lock executes inside a database transaction. Repeating the idempotency
-- key returns the original reservation without subtracting inventory twice.
create or replace function reserve_lot(
  p_order_id uuid,
  p_lot_id text,
  p_quantity numeric,
  p_idempotency_key text
) returns uuid
language plpgsql
as $$
declare
  v_reservation_id uuid;
begin
  -- Serialize every reservation attempt for the same physical lot before
  -- checking idempotency. This makes a concurrent retry with the same key
  -- return the original reservation instead of racing into an inventory error.
  perform pg_advisory_xact_lock(hashtext('raw-material-os:lot:' || p_lot_id));

  select reservation_id into v_reservation_id
  from reservations
  where idempotency_key = p_idempotency_key;
  if found then return v_reservation_id; end if;

  update lots
  set available_quantity = available_quantity - p_quantity,
      reserved_quantity = reserved_quantity + p_quantity,
      state = case when available_quantity - p_quantity = 0 then 'RESERVED'::lot_state else state end,
      updated_at = now()
  where lot_id = p_lot_id
    and state = 'VERIFIED_ELIGIBLE'
    and available_quantity >= p_quantity;
  if not found then
    raise exception 'LOT_NOT_ELIGIBLE_OR_INSUFFICIENT_INVENTORY';
  end if;

  insert into reservations(order_id, lot_id, quantity, idempotency_key)
  values (p_order_id, p_lot_id, p_quantity, p_idempotency_key)
  returning reservation_id into v_reservation_id;
  return v_reservation_id;
end;
$$;

comment on table trade_events is 'Append-only audit ledger. Application roles must not update or delete rows.';
comment on table trades is 'Physical-material trade snapshots only.';
comment on table operational_approvals is 'Human approval workflow only; never a payment or trade execution command.';
comment on table approval_events is 'Append-only audit ledger for H-01 operational decisions.';
