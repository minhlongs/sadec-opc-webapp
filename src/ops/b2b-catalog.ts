/**
 * B2B catalog and D1 queries for lots, bookings, ledger, hub dispatch,
 * settlement and pilot metrics.
 *
 * Two rules shape every write in this file.
 *
 * Atomic by construction. A D1 `batch` is one transaction, but a transaction
 * only protects what its statements check. Every multi-row change here is a
 * single batch whose first statement carries the business condition in its
 * `WHERE` (status, stock, capacity, revision), and whose later statements are
 * conditional on the first having happened — an `INSERT … SELECT … WHERE
 * EXISTS` against the row the first statement just wrote. After the batch,
 * `changes` of the guarding statement is read: zero means the condition
 * failed and nothing was written, which the caller turns into a 409 rather
 * than a success. A read-then-write with the check in JavaScript is never
 * trusted on its own, because two requests can both pass the read.
 *
 * Visible by party. A booking has two parties, the buyer workspace and the
 * nursery workspace, and is visible to a caller who may act in either. That
 * is the whole sharing boundary of the marketplace: published lots are an
 * offer to every signed-in member, bookings and settlements are shared with
 * their two parties, hub trips are platform logistics whose packages are
 * shown only for bookings the caller is party to. The caller's accessible
 * workspaces come from the chokepoint, never from the request.
 *
 * The escrow ledger is a simulated ledger: rows are confirmations a founder
 * typed with a reference, not bank credits.
 */

import type { D1Like } from './catalog.ts';
import { DomainError, GENERIC_MESSAGES } from './api-error.ts';
import { assertSafeVnd } from '../domain/money.ts';
import {
  calculateBookingQuote,
  calculateInspectionSettlement,
  type InspectionSettlementResult,
} from '../domain/escrow-ledger.ts';
import { signLotQrToken } from '../domain/lot-qr.ts';
import { computePilotMetrics } from '../domain/pilot-metrics.ts';
import { computeLotRevision } from '../domain/aeo-projection.ts';

/** The platform fee every booking carries. Stated once. */
export const PLATFORM_FEE_BPS = 300;

/**
 * Raised when a booking names a lot revision that no longer matches the stored
 * lot. The caller read the catalog, the lot changed, and reserving against the
 * stale view would sell stock at a price or quantity the buyer never saw.
 */
export class LotRevisionConflictError extends DomainError {
  constructor() {
    super(
      'Dữ liệu lô hàng đã thay đổi (revision không khớp). Vui lòng tải lại danh mục trước khi đặt giữ.',
      409,
      'revision_conflict',
    );
    this.name = 'LotRevisionConflictError';
  }
}

export interface NurseryProfileRow {
  id: string;
  workspace_id: string;
  nursery_name: string;
  hamlet_area: string;
  owner_name: string;
  phone: string;
  specialties_json: string;
  verified_status: string;
  fulfillment_score_bps: number;
  created_at: string;
  updated_at: string;
}

export interface SupplyLotRow {
  id: string;
  lot_code: string;
  nursery_workspace_id: string;
  name: string;
  mode: 'WEEKLY_CATALOG' | 'SEASONAL_PREORDER';
  species: string;
  grade: string;
  pot_diameter_cm: number;
  height_cm: number;
  canopy_cm: number;
  bud_specification: string;
  media_proof_url: string;
  unit: string;
  unit_price_vnd: number;
  deposit_rate_bps: number;
  moq_units: number;
  total_units: number;
  available_units: number;
  cut_or_ship_date: string;
  qr_lot_token: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface B2bBookingRow {
  id: string;
  booking_code: string;
  lot_id: string;
  nursery_workspace_id: string;
  buyer_workspace_id: string;
  buyer_shop_name: string;
  buyer_contact_phone: string;
  destination_market: string;
  quantity: number;
  unit_price_vnd: number;
  gross_total_vnd: number;
  deposit_rate_bps: number;
  deposit_required_vnd: number;
  deposit_paid_vnd: number;
  platform_fee_bps: number;
  platform_fee_vnd: number;
  status: string;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface EscrowLedgerRow {
  id: string;
  booking_id: string;
  entry_type: string;
  amount_vnd: number;
  vietqr_ref: string | null;
  note: string | null;
  created_at: string;
}

export interface HubDispatchTripRow {
  id: string;
  trip_code: string;
  truck_plate: string;
  driver_name: string;
  driver_phone: string;
  departure_sa_dec_at: string;
  eta_hcm_at: string;
  destination_market: string;
  capacity_units: number;
  loaded_units: number;
  status: string;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ShipmentPackageRow {
  id: string;
  trip_id: string;
  booking_id: string;
  package_qr_token: string;
  package_label: string;
  units_count: number;
  hub_inspection_status: string;
  hub_verified_at: string | null;
  hub_note: string | null;
  buyer_inspection_status: string;
  buyer_inspected_at: string | null;
  accepted_units: number;
  defective_units: number;
  fault_party: string;
  created_at: string;
  updated_at: string;
}

/** A settlement as stored: obligations from inspection, cash confirmed later. */
export interface B2bSettlementRow {
  id: string;
  booking_id: string;
  buyer_workspace_id: string;
  nursery_workspace_id: string;
  accepted_units: number;
  defective_units: number;
  fault_party: string;
  accepted_value_vnd: number;
  nursery_deduction_vnd: number;
  platform_fee_vnd: number;
  deposit_paid_vnd: number;
  buyer_balance_required_vnd: number;
  buyer_refund_vnd: number;
  nursery_payout_vnd: number;
  balance_collected_vnd: number;
  balance_collected_ref: string | null;
  balance_collected_at: string | null;
  status: 'AWAITING_BALANCE' | 'READY_TO_RELEASE' | 'RELEASED';
  inspected_by: string;
  inspected_at: string;
  released_by: string | null;
  released_at: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

/** Booking states in which a buyer may inspect the goods. */
export const INSPECTABLE_BOOKING_STATUSES = ['HUB_CONSOLIDATED', 'IN_TRANSIT'] as const;

/** Booking states that mean "inspected, settlement not yet confirmed". */
export const INSPECTED_BOOKING_STATUSES = [
  'INSPECTED_ACCEPTED',
  'INSPECTED_PARTIAL_DEFECT',
  'REJECTED_NURSERY_FAULT',
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Reads `changes` from a batch result, treating an unreadable value as zero. */
function changesAt(results: unknown, index: number): number {
  if (!Array.isArray(results)) return 0;
  const entry = results[index] as { meta?: { changes?: unknown } } | undefined;
  const value = entry?.meta?.changes;
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** `?, ?, ?` for an IN list. */
function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

/** Whether a booking is shared with any of the given workspaces. */
export function bookingIsPartyOf(
  booking: Pick<B2bBookingRow, 'buyer_workspace_id' | 'nursery_workspace_id'>,
  workspaceIds: readonly string[],
): boolean {
  return (
    workspaceIds.includes(booking.buyer_workspace_id) ||
    workspaceIds.includes(booking.nursery_workspace_id)
  );
}

function notFound(): DomainError {
  return new DomainError(GENERIC_MESSAGES.notFound, 404, 'not_found');
}

function invalidState(message: string): DomainError {
  return new DomainError(message, 409, 'invalid_state');
}

function auditInsert(
  db: D1Like,
  input: {
    workspaceId: string;
    actorId: string;
    action: string;
    subjectType: string;
    subjectId: string;
    detail: Record<string, unknown>;
    at: string;
    /** The guarding condition: the audit row is written only if this holds. */
    onlyIf: { sql: string; params: unknown[] };
  },
) {
  return db
    .prepare(
      `INSERT INTO audit_events
         (id, workspace_id, actor_id, action, subject_type, subject_id, detail, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (${input.onlyIf.sql})`,
    )
    .bind(
      newId('ae'),
      input.workspaceId,
      input.actorId,
      input.action,
      input.subjectType,
      input.subjectId,
      JSON.stringify(input.detail),
      input.at,
      ...input.onlyIf.params,
    );
}

// ---------------------------------------------------------------------------
// Lots
// ---------------------------------------------------------------------------

/**
 * Published lots, for the marketplace listing.
 *
 * Sharing boundary: a lot in PUBLISHED or SOLD_OUT is an offer to every
 * signed-in member — it is also what the public projection shows, minus
 * nothing private, because the row carries no buyer data. DRAFT and ARCHIVED
 * lots are not listed here.
 */
export async function listSupplyLots(
  db: D1Like,
  options?: { mode?: 'WEEKLY_CATALOG' | 'SEASONAL_PREORDER'; nurseryWorkspaceId?: string },
): Promise<(SupplyLotRow & { nursery_name?: string; hamlet_area?: string; revision: string })[]> {
  let query = `
    SELECT l.*, n.nursery_name, n.hamlet_area
      FROM supply_lots l
      JOIN nursery_profiles n ON n.workspace_id = l.nursery_workspace_id
     WHERE l.status IN ('PUBLISHED', 'SOLD_OUT')
  `;
  const params: unknown[] = [];

  if (options?.mode) {
    query += ' AND l.mode = ?';
    params.push(options.mode);
  }
  if (options?.nurseryWorkspaceId) {
    query += ' AND l.nursery_workspace_id = ?';
    params.push(options.nurseryWorkspaceId);
  }

  query += ' ORDER BY l.cut_or_ship_date ASC, l.name ASC';

  const stmt = db.prepare(query);
  const { results } = await (params.length > 0 ? stmt.bind(...params) : stmt).all<
    SupplyLotRow & { nursery_name?: string; hamlet_area?: string }
  >();
  return results.map((row) => ({
    ...row,
    revision: computeLotRevision(row),
  }));
}

export async function createSupplyLot(
  db: D1Like,
  workspaceId: string,
  input: {
    name: string;
    mode: 'WEEKLY_CATALOG' | 'SEASONAL_PREORDER';
    species: string;
    grade?: string;
    pot_diameter_cm: number;
    height_cm: number;
    canopy_cm: number;
    bud_specification: string;
    media_proof_url: string;
    unit?: string;
    unit_price_vnd: number;
    deposit_rate_bps: number;
    moq_units: number;
    total_units: number;
    cut_or_ship_date: string;
  },
): Promise<SupplyLotRow & { revision: string }> {
  assertSafeVnd(input.unit_price_vnd);
  if (input.moq_units > input.total_units) {
    throw new DomainError(
      'Số lượng đặt tối thiểu không được lớn hơn tổng số lượng của lô.',
      400,
      'validation',
    );
  }

  // A lot is listed under a nursery profile; a workspace without one has
  // nothing to list it as. This is the row the listing JOINs on.
  const profile = await db
    .prepare('SELECT id FROM nursery_profiles WHERE workspace_id = ?')
    .bind(workspaceId)
    .first<{ id: string }>();
  if (profile === null) {
    throw new DomainError(
      'Không gian này chưa có hồ sơ nhà vườn nên chưa thể đăng lô hàng.',
      409,
      'invalid_state',
    );
  }

  const lotId = newId('lot');
  const lotCode = `SDEC-LOT-${Date.now().toString(36).toUpperCase()}-${lotId.slice(-4).toUpperCase()}`;
  const now = new Date().toISOString();

  const qrToken = await signLotQrToken({
    kind: 'LOT',
    entityId: lotId,
    workspaceId,
    issuedAt: now,
  });

  await db
    .prepare(
      `INSERT INTO supply_lots (
        id, lot_code, nursery_workspace_id, name, mode, species, grade,
        pot_diameter_cm, height_cm, canopy_cm, bud_specification, media_proof_url,
        unit, unit_price_vnd, deposit_rate_bps, moq_units, total_units, available_units,
        cut_or_ship_date, qr_lot_token, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PUBLISHED', ?, ?)`,
    )
    .bind(
      lotId,
      lotCode,
      workspaceId,
      input.name,
      input.mode,
      input.species,
      input.grade ?? 'A',
      input.pot_diameter_cm,
      input.height_cm,
      input.canopy_cm,
      input.bud_specification,
      input.media_proof_url,
      input.unit ?? 'chậu',
      input.unit_price_vnd,
      input.deposit_rate_bps,
      input.moq_units,
      input.total_units,
      input.total_units,
      input.cut_or_ship_date,
      qrToken,
      now,
      now,
    )
    .run();

  const created = await db
    .prepare('SELECT * FROM supply_lots WHERE id = ?')
    .bind(lotId)
    .first<SupplyLotRow>();

  if (!created) {
    throw new Error('Failed to retrieve newly created lot');
  }
  return {
    ...created,
    revision: computeLotRevision(created),
  };
}

// ---------------------------------------------------------------------------
// Bookings
// ---------------------------------------------------------------------------

export type BookingWithLedger = B2bBookingRow & {
  lot_name?: string;
  lot_code?: string;
  nursery_name?: string;
  ledger_entries: EscrowLedgerRow[];
  settlement: B2bSettlementRow | null;
};

/** Bookings shared with any of the caller's accessible workspaces. */
export async function listB2bBookings(
  db: D1Like,
  options: { workspaceIds: readonly string[] },
): Promise<BookingWithLedger[]> {
  if (options.workspaceIds.length === 0) return [];
  const marks = placeholders(options.workspaceIds.length);
  const { results: bookings } = await db
    .prepare(
      `SELECT b.*, l.name AS lot_name, l.lot_code, n.nursery_name
         FROM b2b_bookings b
         JOIN supply_lots l ON l.id = b.lot_id
         JOIN nursery_profiles n ON n.workspace_id = b.nursery_workspace_id
        WHERE b.buyer_workspace_id IN (${marks}) OR b.nursery_workspace_id IN (${marks})
        ORDER BY b.created_at DESC`,
    )
    .bind(...options.workspaceIds, ...options.workspaceIds)
    .all<B2bBookingRow & { lot_name?: string; lot_code?: string; nursery_name?: string }>();

  const full: BookingWithLedger[] = [];
  for (const booking of bookings) {
    const { results: ledger_entries } = await db
      .prepare('SELECT * FROM escrow_ledger_entries WHERE booking_id = ? ORDER BY created_at ASC')
      .bind(booking.id)
      .all<EscrowLedgerRow>();
    const settlement = await db
      .prepare('SELECT * FROM b2b_settlements WHERE booking_id = ?')
      .bind(booking.id)
      .first<B2bSettlementRow>();
    full.push({ ...booking, ledger_entries, settlement });
  }
  return full;
}

/**
 * Reads one booking if it is shared with any of the given workspaces.
 *
 * An absent booking and one the caller is not party to are the same answer,
 * so a caller cannot learn which ids exist by probing.
 */
export async function readVisibleBooking(
  db: D1Like,
  bookingId: string,
  workspaceIds: readonly string[],
): Promise<B2bBookingRow | null> {
  const booking = await db
    .prepare('SELECT * FROM b2b_bookings WHERE id = ?')
    .bind(bookingId)
    .first<B2bBookingRow>();
  if (booking === null) return null;
  return bookingIsPartyOf(booking, workspaceIds) ? booking : null;
}

/** Parses `id:uN:STATUS:updated_at` back into its parts, or null. */
function parseRevision(
  revision: string,
): { id: string; available_units: number; status: string; updated_at: string } | null {
  const match = /^(.+?):u(\d+):([A-Z_]+):(.+)$/.exec(revision.trim());
  if (match === null) return null;
  const [, id, units, status, updatedAt] = match;
  if (id === undefined || units === undefined || status === undefined || updatedAt === undefined) {
    return null;
  }
  return { id, available_units: Number(units), status, updated_at: updatedAt };
}

/**
 * Reserves stock and records a booking in one transaction.
 *
 * The INSERT is a `SELECT` from the lot row guarded by every business
 * condition — published, enough stock, at or above MOQ, and (when the client
 * sent one) exactly the revision it quoted. The stock decrement that follows
 * is conditional on the booking row existing. Zero changes on the INSERT means
 * no reservation happened; the lot is then re-read only to say why.
 */
export async function createBooking(
  db: D1Like,
  buyerWorkspaceId: string,
  actorId: string,
  input: {
    lotId: string;
    quantity: number;
    buyerShopName: string;
    buyerContactPhone: string;
    destinationMarket: string;
    note?: string | null;
    expectedRevision?: string | null;
  },
): Promise<B2bBookingRow> {
  const lot = await db
    .prepare('SELECT * FROM supply_lots WHERE id = ?')
    .bind(input.lotId)
    .first<SupplyLotRow>();

  if (!lot) throw notFound();
  if (lot.status !== 'PUBLISHED') {
    throw invalidState('Lô hàng không còn mở bán.');
  }

  const expected =
    typeof input.expectedRevision === 'string' && input.expectedRevision.trim() !== ''
      ? parseRevision(input.expectedRevision)
      : null;
  if (input.expectedRevision && expected === null) {
    throw new DomainError('expected_revision không đúng định dạng.', 400, 'validation');
  }
  if (expected !== null && input.expectedRevision?.trim() !== computeLotRevision(lot)) {
    throw new LotRevisionConflictError();
  }
  if (input.quantity < lot.moq_units) {
    throw new DomainError(
      `Số lượng đặt tối thiểu là ${lot.moq_units} ${lot.unit}.`,
      400,
      'validation',
    );
  }
  if (lot.available_units < input.quantity) {
    throw new DomainError(
      `Số lượng còn lại không đủ (còn ${lot.available_units} ${lot.unit}).`,
      409,
      'insufficient_stock',
    );
  }

  // Amounts come from the money domain, from the price and rate this request
  // saw. The INSERT below only fires if the lot still carries that price and
  // rate, so the stored amounts always match the stored lot.
  const quote = calculateBookingQuote({
    quantity: input.quantity,
    unitPriceVnd: lot.unit_price_vnd,
    depositRateBps: lot.deposit_rate_bps,
    platformFeeBps: PLATFORM_FEE_BPS,
  });

  const bookingId = newId('bk');
  const bookingCode = `SDEC-BK-${Date.now().toString(36).toUpperCase()}-${bookingId.slice(-4).toUpperCase()}`;
  const now = new Date().toISOString();

  const revisionGuard =
    expected === null
      ? ''
      : ' AND l.available_units = ? AND l.status = ? AND l.updated_at = ?';
  const revisionParams =
    expected === null ? [] : [expected.available_units, expected.status, expected.updated_at];

  const insertBooking = db
    .prepare(
      `INSERT INTO b2b_bookings (
        id, booking_code, lot_id, nursery_workspace_id, buyer_workspace_id,
        buyer_shop_name, buyer_contact_phone, destination_market,
        quantity, unit_price_vnd, gross_total_vnd, deposit_rate_bps,
        deposit_required_vnd, deposit_paid_vnd, platform_fee_bps, platform_fee_vnd,
        status, note, created_at, updated_at
      )
      SELECT ?, ?, l.id, l.nursery_workspace_id, ?,
             ?, ?, ?,
             ?, l.unit_price_vnd, ?, l.deposit_rate_bps,
             ?, 0, ?, ?,
             'BOOKED_PENDING_DEPOSIT', ?, ?, ?
        FROM supply_lots l
       WHERE l.id = ?
         AND l.status = 'PUBLISHED'
         AND l.available_units >= ?
         AND l.moq_units <= ?
         AND l.unit_price_vnd = ?
         AND l.deposit_rate_bps = ?${revisionGuard}`,
    )
    .bind(
      bookingId,
      bookingCode,
      buyerWorkspaceId,
      input.buyerShopName,
      input.buyerContactPhone,
      input.destinationMarket,
      input.quantity,
      quote.grossTotalVnd,
      quote.depositRequiredVnd,
      PLATFORM_FEE_BPS,
      quote.platformFeeVnd,
      input.note ?? null,
      now,
      now,
      lot.id,
      input.quantity,
      input.quantity,
      lot.unit_price_vnd,
      lot.deposit_rate_bps,
      ...revisionParams,
    );

  const updateLot = db
    .prepare(
      `UPDATE supply_lots
          SET available_units = available_units - ?,
              status = CASE WHEN available_units - ? = 0 THEN 'SOLD_OUT' ELSE status END,
              updated_at = ?
        WHERE id = ?
          AND available_units >= ?
          AND EXISTS (SELECT 1 FROM b2b_bookings WHERE id = ?)`,
    )
    .bind(input.quantity, input.quantity, now, lot.id, input.quantity, bookingId);

  const audit = auditInsert(db, {
    workspaceId: buyerWorkspaceId,
    actorId,
    action: 'marketplace.booking.created',
    subjectType: 'b2b_booking',
    subjectId: bookingId,
    detail: {
      lot_id: lot.id,
      quantity: input.quantity,
      gross_total_vnd: quote.grossTotalVnd,
      deposit_required_vnd: quote.depositRequiredVnd,
    },
    at: now,
    onlyIf: { sql: 'SELECT 1 FROM b2b_bookings WHERE id = ?', params: [bookingId] },
  });

  const results = await db.batch([insertBooking, updateLot, audit]);

  if (changesAt(results, 0) === 0) {
    // Nothing was written. Re-read to say why, in the order a buyer can act on.
    const current = await db
      .prepare('SELECT * FROM supply_lots WHERE id = ?')
      .bind(lot.id)
      .first<SupplyLotRow>();
    if (current === null || current.status !== 'PUBLISHED') {
      throw invalidState('Lô hàng không còn mở bán.');
    }
    if (current.available_units < input.quantity) {
      throw new DomainError(
        `Số lượng còn lại không đủ (còn ${current.available_units} ${current.unit}).`,
        409,
        'insufficient_stock',
      );
    }
    throw new LotRevisionConflictError();
  }
  if (changesAt(results, 1) === 0) {
    // Cannot happen inside one transaction; reported rather than hidden.
    throw new Error(`Booking ${bookingId} was written but its lot was not decremented.`);
  }

  const booking = await db
    .prepare('SELECT * FROM b2b_bookings WHERE id = ?')
    .bind(bookingId)
    .first<B2bBookingRow>();
  if (!booking) throw new Error('Đặt giữ lô hàng thất bại.');
  return booking;
}

/**
 * Records that a founder confirmed the deposit arrived, with its reference.
 *
 * The booking row carries the condition (`BOOKED_PENDING_DEPOSIT`); the ledger
 * row and the audit event are written only if that update happened. The
 * amount is the booking's own `deposit_required_vnd`, never a client value.
 */
export async function confirmDeposit(
  db: D1Like,
  booking: B2bBookingRow,
  input: { vietqrRef?: string; actorId: string; actorWorkspaceId: string },
): Promise<B2bBookingRow> {
  if (booking.status !== 'BOOKED_PENDING_DEPOSIT') {
    throw invalidState(`Đơn hàng ở trạng thái ${booking.status}, không thể xác nhận cọc.`);
  }

  const now = new Date().toISOString();
  const ref = input.vietqrRef?.trim() || `SDEC DEP ${booking.booking_code}`;

  const updateBooking = db
    .prepare(
      `UPDATE b2b_bookings
          SET status = 'ESCROW_HELD',
              deposit_paid_vnd = deposit_required_vnd,
              updated_at = ?
        WHERE id = ? AND status = 'BOOKED_PENDING_DEPOSIT'`,
    )
    .bind(now, booking.id);

  const insertLedger = db
    .prepare(
      `INSERT INTO escrow_ledger_entries (
        id, booking_id, entry_type, amount_vnd, vietqr_ref, note, created_at
      )
      SELECT ?, id, 'DEPOSIT_HELD', deposit_required_vnd, ?,
             'Xác nhận thủ công: đã nhận cọc (tham chiếu VietQR do quản trị sàn nhập)', ?
        FROM b2b_bookings
       WHERE id = ? AND status = 'ESCROW_HELD' AND updated_at = ?`,
    )
    .bind(newId('led'), ref, now, booking.id, now);

  const audit = auditInsert(db, {
    workspaceId: input.actorWorkspaceId,
    actorId: input.actorId,
    action: 'marketplace.escrow.deposit_confirmed',
    subjectType: 'b2b_booking',
    subjectId: booking.id,
    detail: { amount_vnd: booking.deposit_required_vnd, vietqr_ref: ref },
    at: now,
    onlyIf: {
      sql: "SELECT 1 FROM b2b_bookings WHERE id = ? AND status = 'ESCROW_HELD' AND updated_at = ?",
      params: [booking.id, now],
    },
  });

  const results = await db.batch([updateBooking, insertLedger, audit]);
  if (changesAt(results, 0) === 0) {
    throw invalidState('Đơn hàng vừa đổi trạng thái; không còn ở bước chờ cọc.');
  }

  const updated = await db
    .prepare('SELECT * FROM b2b_bookings WHERE id = ?')
    .bind(booking.id)
    .first<B2bBookingRow>();
  if (!updated) throw new Error('Lỗi cập nhật cọc.');
  return updated;
}

// ---------------------------------------------------------------------------
// Hub dispatch
// ---------------------------------------------------------------------------

export type TripWithPackages = HubDispatchTripRow & {
  packages: (ShipmentPackageRow & { booking_code?: string; buyer_shop_name?: string })[];
};

/**
 * Hub trips with the packages the caller may see.
 *
 * Trips are platform logistics and are listed to every member who may read
 * dispatch; the packages on a trip are shown only for bookings the caller is
 * party to, because a package names another shop's booking.
 */
export async function listHubTrips(
  db: D1Like,
  options: { workspaceIds: readonly string[] },
): Promise<TripWithPackages[]> {
  const { results: trips } = await db
    .prepare('SELECT * FROM hub_dispatch_trips ORDER BY departure_sa_dec_at ASC')
    .all<HubDispatchTripRow>();

  if (options.workspaceIds.length === 0) {
    return trips.map((trip) => ({ ...trip, packages: [] }));
  }
  const marks = placeholders(options.workspaceIds.length);

  const full: TripWithPackages[] = [];
  for (const trip of trips) {
    const { results: packages } = await db
      .prepare(
        `SELECT p.*, b.booking_code, b.buyer_shop_name
           FROM shipment_packages p
           JOIN b2b_bookings b ON b.id = p.booking_id
          WHERE p.trip_id = ?
            AND (b.buyer_workspace_id IN (${marks}) OR b.nursery_workspace_id IN (${marks}))
          ORDER BY p.created_at ASC`,
      )
      .bind(trip.id, ...options.workspaceIds, ...options.workspaceIds)
      .all<ShipmentPackageRow & { booking_code?: string; buyer_shop_name?: string }>();
    full.push({ ...trip, packages });
  }
  return full;
}

export async function createHubTrip(
  db: D1Like,
  input: {
    truckPlate: string;
    driverName: string;
    driverPhone: string;
    departureSaDecAt: string;
    etaHcmAt: string;
    destinationMarket: string;
    capacityUnits: number;
    actorId: string;
    actorWorkspaceId: string;
  },
): Promise<HubDispatchTripRow> {
  if (input.etaHcmAt <= input.departureSaDecAt) {
    throw new DomainError('Giờ đến TP.HCM phải sau giờ xuất phát Sa Đéc.', 400, 'validation');
  }
  const tripId = newId('trip');
  const tripCode = `TRIP-SDEC-HCM-${Date.now().toString(36).toUpperCase()}-${tripId.slice(-4).toUpperCase()}`;
  const now = new Date().toISOString();

  await db.batch([
    db
      .prepare(
        `INSERT INTO hub_dispatch_trips (
          id, trip_code, truck_plate, driver_name, driver_phone,
          departure_sa_dec_at, eta_hcm_at, destination_market,
          capacity_units, loaded_units, status, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'GATHERING', ?, ?, ?)`,
      )
      .bind(
        tripId,
        tripCode,
        input.truckPlate,
        input.driverName,
        input.driverPhone,
        input.departureSaDecAt,
        input.etaHcmAt,
        input.destinationMarket,
        input.capacityUnits,
        input.actorId,
        now,
        now,
      ),
    auditInsert(db, {
      workspaceId: input.actorWorkspaceId,
      actorId: input.actorId,
      action: 'hub.trip.created',
      subjectType: 'hub_dispatch_trip',
      subjectId: tripId,
      detail: { trip_code: tripCode, capacity_units: input.capacityUnits },
      at: now,
      onlyIf: { sql: 'SELECT 1 FROM hub_dispatch_trips WHERE id = ?', params: [tripId] },
    }),
  ]);

  const trip = await db
    .prepare('SELECT * FROM hub_dispatch_trips WHERE id = ?')
    .bind(tripId)
    .first<HubDispatchTripRow>();
  if (!trip) throw new Error('Lỗi tạo chuyến Hub.');
  return trip;
}

/**
 * Loads a booking's goods onto a trip as one verified package.
 *
 * The trip row carries the conditions — still GATHERING, capacity not exceeded
 * — and the booking must still be ESCROW_HELD with the quantity this request
 * saw. Booking status, package row and audit event follow only if the trip
 * update happened. `shipment_packages.booking_id` is UNIQUE, so a second
 * package for the same booking cannot be written even by a racing request.
 */
export async function verifyHubPackage(
  db: D1Like,
  input: {
    trip: HubDispatchTripRow;
    booking: B2bBookingRow;
    packageLabel: string;
    hubNote?: string;
    actorId: string;
    actorWorkspaceId: string;
  },
): Promise<ShipmentPackageRow> {
  const { trip, booking } = input;
  if (booking.status !== 'ESCROW_HELD') {
    throw invalidState(
      `Đơn hàng phải ở trạng thái ESCROW_HELD để gom Hub, hiện là: ${booking.status}.`,
    );
  }
  if (trip.status !== 'GATHERING') {
    throw invalidState(`Chuyến ${trip.trip_code} không còn nhận hàng (trạng thái ${trip.status}).`);
  }
  if (trip.loaded_units + booking.quantity > trip.capacity_units) {
    throw invalidState(
      `Chuyến ${trip.trip_code} không đủ sức chứa: còn ${trip.capacity_units - trip.loaded_units} đơn vị, cần ${booking.quantity}.`,
    );
  }

  const pkgId = newId('pkg');
  const now = new Date().toISOString();
  const qrToken = await signLotQrToken({
    kind: 'PKG',
    entityId: pkgId,
    workspaceId: booking.nursery_workspace_id,
    issuedAt: now,
  });
  const note = input.hubNote?.trim() || 'Đạt tiêu chuẩn xuất Hub Sa Đéc';

  const updateTrip = db
    .prepare(
      `UPDATE hub_dispatch_trips
          SET loaded_units = loaded_units + ?,
              updated_at = ?
        WHERE id = ?
          AND status = 'GATHERING'
          AND loaded_units + ? <= capacity_units
          AND EXISTS (
            SELECT 1 FROM b2b_bookings WHERE id = ? AND status = 'ESCROW_HELD' AND quantity = ?
          )
          AND NOT EXISTS (SELECT 1 FROM shipment_packages WHERE booking_id = ?)`,
    )
    .bind(booking.quantity, now, trip.id, booking.quantity, booking.id, booking.quantity, booking.id);

  const tripJustUpdated = {
    sql: "SELECT 1 FROM hub_dispatch_trips WHERE id = ? AND updated_at = ? AND status = 'GATHERING'",
    params: [trip.id, now],
  };

  const updateBooking = db
    .prepare(
      `UPDATE b2b_bookings
          SET status = 'HUB_CONSOLIDATED', updated_at = ?
        WHERE id = ? AND status = 'ESCROW_HELD'
          AND EXISTS (${tripJustUpdated.sql})`,
    )
    .bind(now, booking.id, ...tripJustUpdated.params);

  const insertPkg = db
    .prepare(
      `INSERT INTO shipment_packages (
        id, trip_id, booking_id, package_qr_token, package_label, units_count,
        hub_inspection_status, hub_verified_at, hub_note,
        buyer_inspection_status, accepted_units, defective_units, fault_party,
        created_at, updated_at
      )
      SELECT ?, ?, b.id, ?, ?, b.quantity,
             'VERIFIED_OK', ?, ?,
             'PENDING', 0, 0, 'NONE',
             ?, ?
        FROM b2b_bookings b
       WHERE b.id = ? AND b.status = 'HUB_CONSOLIDATED' AND b.updated_at = ?`,
    )
    .bind(pkgId, trip.id, qrToken, input.packageLabel, now, note, now, now, booking.id, now);

  const audit = auditInsert(db, {
    workspaceId: input.actorWorkspaceId,
    actorId: input.actorId,
    action: 'hub.package.verified',
    subjectType: 'shipment_package',
    subjectId: pkgId,
    detail: { trip_id: trip.id, booking_id: booking.id, units_count: booking.quantity },
    at: now,
    onlyIf: { sql: 'SELECT 1 FROM shipment_packages WHERE id = ?', params: [pkgId] },
  });

  const results = await db.batch([updateTrip, updateBooking, insertPkg, audit]);
  if (changesAt(results, 0) === 0) {
    const currentTrip = await db
      .prepare('SELECT * FROM hub_dispatch_trips WHERE id = ?')
      .bind(trip.id)
      .first<HubDispatchTripRow>();
    if (currentTrip === null || currentTrip.status !== 'GATHERING') {
      throw invalidState('Chuyến Hub không còn nhận hàng.');
    }
    if (currentTrip.loaded_units + booking.quantity > currentTrip.capacity_units) {
      throw invalidState(
        `Chuyến ${currentTrip.trip_code} không đủ sức chứa: còn ${currentTrip.capacity_units - currentTrip.loaded_units} đơn vị, cần ${booking.quantity}.`,
      );
    }
    throw invalidState('Đơn hàng vừa đổi trạng thái hoặc đã được gom vào kiện khác.');
  }

  const pkg = await db
    .prepare('SELECT * FROM shipment_packages WHERE id = ?')
    .bind(pkgId)
    .first<ShipmentPackageRow>();
  if (!pkg) throw new Error('Lỗi tạo kiện hàng kiểm định.');
  return pkg;
}

// ---------------------------------------------------------------------------
// Inspection and settlement
// ---------------------------------------------------------------------------

/**
 * Records a buyer's inspection and the obligations it implies.
 *
 * Writes the booking's new status, the settlement row (obligations only), the
 * package's inspection fields and an audit event, all in one transaction
 * guarded by the booking still being in an inspectable state. Writes nothing
 * to the escrow ledger: no money has moved at this point, and the ledger
 * records only movements a founder confirms.
 */
export async function inspectBooking(
  db: D1Like,
  booking: B2bBookingRow,
  input: {
    acceptedUnits: number;
    defectiveUnits: number;
    faultParty: 'NONE' | 'NURSERY';
    note?: string;
    actorId: string;
    actorWorkspaceId: string;
  },
): Promise<{ booking: B2bBookingRow; settlement: B2bSettlementRow; computed: InspectionSettlementResult }> {
  if (!(INSPECTABLE_BOOKING_STATUSES as readonly string[]).includes(booking.status)) {
    throw invalidState(
      `Đơn hàng ở trạng thái ${booking.status}, chưa thể nghiệm thu (cần đã gom Hub hoặc đang vận chuyển).`,
    );
  }

  let computed: InspectionSettlementResult;
  try {
    computed = calculateInspectionSettlement({
      unitPriceVnd: booking.unit_price_vnd,
      grossTotalVnd: booking.gross_total_vnd,
      depositPaidVnd: booking.deposit_paid_vnd,
      platformFeeBps: booking.platform_fee_bps,
      totalUnits: booking.quantity,
      acceptedUnits: input.acceptedUnits,
      defectiveUnits: input.defectiveUnits,
      faultParty: input.faultParty,
    });
  } catch (err) {
    if (err instanceof RangeError) {
      throw new DomainError(
        `Số liệu nghiệm thu không hợp lệ: đạt ${input.acceptedUnits} + lỗi ${input.defectiveUnits} phải bằng ${booking.quantity}${input.defectiveUnits > 0 ? ' và phải nêu bên chịu lỗi' : ''}.`,
        400,
        'validation',
      );
    }
    throw err;
  }

  const now = new Date().toISOString();
  const nextStatus =
    computed.acceptedUnits === 0 && computed.faultParty === 'NURSERY'
      ? 'REJECTED_NURSERY_FAULT'
      : computed.defectiveUnits > 0
        ? 'INSPECTED_PARTIAL_DEFECT'
        : 'INSPECTED_ACCEPTED';
  const packageStatus =
    nextStatus === 'REJECTED_NURSERY_FAULT'
      ? 'REJECTED'
      : computed.defectiveUnits > 0
        ? 'PARTIAL_DEFECT'
        : 'ACCEPTED';
  const settlementStatus =
    computed.buyerBalanceRequiredVnd > 0 ? 'AWAITING_BALANCE' : 'READY_TO_RELEASE';
  const settlementId = newId('stl');
  const inspectable = (INSPECTABLE_BOOKING_STATUSES as readonly string[])
    .map((s) => `'${s}'`)
    .join(', ');

  const updateBooking = db
    .prepare(
      `UPDATE b2b_bookings
          SET status = ?, updated_at = ?
        WHERE id = ? AND status IN (${inspectable})`,
    )
    .bind(nextStatus, now, booking.id);

  const bookingJustUpdated = {
    sql: 'SELECT 1 FROM b2b_bookings WHERE id = ? AND status = ? AND updated_at = ?',
    params: [booking.id, nextStatus, now],
  };

  const insertSettlement = db
    .prepare(
      `INSERT INTO b2b_settlements (
        id, booking_id, buyer_workspace_id, nursery_workspace_id,
        accepted_units, defective_units, fault_party,
        accepted_value_vnd, nursery_deduction_vnd, platform_fee_vnd, deposit_paid_vnd,
        buyer_balance_required_vnd, buyer_refund_vnd, nursery_payout_vnd,
        balance_collected_vnd, status, inspected_by, inspected_at, note, created_at, updated_at
      )
      SELECT ?, id, buyer_workspace_id, nursery_workspace_id,
             ?, ?, ?,
             ?, ?, ?, deposit_paid_vnd,
             ?, ?, ?,
             0, ?, ?, ?, ?, ?, ?
        FROM b2b_bookings
       WHERE id = ? AND status = ? AND updated_at = ?`,
    )
    .bind(
      settlementId,
      computed.acceptedUnits,
      computed.defectiveUnits,
      computed.faultParty,
      computed.acceptedValueVnd,
      computed.nurseryDeductionVnd,
      computed.platformFeeRetainedVnd,
      computed.buyerBalanceRequiredVnd,
      computed.buyerRefundVnd,
      computed.nurseryPayoutVnd,
      settlementStatus,
      input.actorId,
      now,
      input.note?.trim() || null,
      now,
      now,
      ...bookingJustUpdated.params,
    );

  const updatePackage = db
    .prepare(
      `UPDATE shipment_packages
          SET buyer_inspection_status = ?,
              buyer_inspected_at = ?,
              accepted_units = ?,
              defective_units = ?,
              fault_party = ?,
              updated_at = ?
        WHERE booking_id = ? AND EXISTS (${bookingJustUpdated.sql})`,
    )
    .bind(
      packageStatus,
      now,
      computed.acceptedUnits,
      computed.defectiveUnits,
      computed.faultParty,
      now,
      booking.id,
      ...bookingJustUpdated.params,
    );

  const audit = auditInsert(db, {
    workspaceId: input.actorWorkspaceId,
    actorId: input.actorId,
    action: 'marketplace.booking.inspected',
    subjectType: 'b2b_booking',
    subjectId: booking.id,
    detail: {
      settlement_id: settlementId,
      accepted_units: computed.acceptedUnits,
      defective_units: computed.defectiveUnits,
      fault_party: computed.faultParty,
      buyer_balance_required_vnd: computed.buyerBalanceRequiredVnd,
      buyer_refund_vnd: computed.buyerRefundVnd,
      nursery_payout_vnd: computed.nurseryPayoutVnd,
    },
    at: now,
    onlyIf: { sql: 'SELECT 1 FROM b2b_settlements WHERE id = ?', params: [settlementId] },
  });

  const results = await db.batch([updateBooking, insertSettlement, updatePackage, audit]);
  if (changesAt(results, 0) === 0) {
    throw invalidState('Đơn hàng vừa đổi trạng thái; không còn ở bước nghiệm thu.');
  }

  const [updatedBooking, settlement] = await Promise.all([
    db.prepare('SELECT * FROM b2b_bookings WHERE id = ?').bind(booking.id).first<B2bBookingRow>(),
    db.prepare('SELECT * FROM b2b_settlements WHERE id = ?').bind(settlementId).first<B2bSettlementRow>(),
  ]);
  if (!updatedBooking || !settlement) throw new Error('Lỗi cập nhật nghiệm thu.');
  return { booking: updatedBooking, settlement, computed };
}

export async function readSettlementForBooking(
  db: D1Like,
  bookingId: string,
): Promise<B2bSettlementRow | null> {
  return db
    .prepare('SELECT * FROM b2b_settlements WHERE booking_id = ?')
    .bind(bookingId)
    .first<B2bSettlementRow>();
}

/**
 * A founder confirms the settlement: the balance (if any) was received under
 * the given reference, and the payout, refund and fee may be recorded.
 *
 * Every amount comes from the stored settlement row. The settlement row
 * carries the condition (not yet RELEASED); the ledger rows, the booking's
 * SETTLED status and the audit event follow only if that update happened.
 * UNIQUE (booking_id, entry_type) on the ledger is the second guard against a
 * racing duplicate.
 */
export async function confirmSettlement(
  db: D1Like,
  booking: B2bBookingRow,
  settlement: B2bSettlementRow,
  input: { balanceRef?: string; note?: string; actorId: string; actorWorkspaceId: string },
): Promise<{ booking: B2bBookingRow; settlement: B2bSettlementRow }> {
  if (settlement.status === 'RELEASED') {
    throw invalidState('Đơn hàng này đã được xác nhận đối soát trước đó.');
  }
  if (!(INSPECTED_BOOKING_STATUSES as readonly string[]).includes(booking.status)) {
    throw invalidState(`Đơn hàng ở trạng thái ${booking.status}, không ở bước đối soát.`);
  }
  const balanceRef = input.balanceRef?.trim() ?? '';
  if (settlement.buyer_balance_required_vnd > 0 && balanceRef === '') {
    throw new DomainError(
      'Cần mã tham chiếu chuyển khoản phần còn lại trước khi xác nhận đã thu.',
      400,
      'validation',
    );
  }

  const now = new Date().toISOString();
  const inspected = (INSPECTED_BOOKING_STATUSES as readonly string[]).map((s) => `'${s}'`).join(', ');

  const releaseSettlement = db
    .prepare(
      `UPDATE b2b_settlements
          SET balance_collected_vnd = buyer_balance_required_vnd,
              balance_collected_ref = CASE WHEN buyer_balance_required_vnd > 0 THEN ? ELSE NULL END,
              balance_collected_at = CASE WHEN buyer_balance_required_vnd > 0 THEN ? ELSE NULL END,
              status = 'RELEASED',
              released_by = ?,
              released_at = ?,
              note = COALESCE(?, note),
              updated_at = ?
        WHERE booking_id = ? AND status IN ('AWAITING_BALANCE', 'READY_TO_RELEASE')`,
    )
    .bind(balanceRef || null, now, input.actorId, now, input.note?.trim() || null, now, booking.id);

  const released = {
    sql: "SELECT 1 FROM b2b_settlements WHERE booking_id = ? AND status = 'RELEASED' AND released_at = ?",
    params: [booking.id, now],
  };

  /** A ledger row for one settlement column, written only if > 0 and released now. */
  const ledgerRow = (entryType: string, column: string, note: string, ref: string | null) =>
    db
      .prepare(
        `INSERT INTO escrow_ledger_entries (id, booking_id, entry_type, amount_vnd, vietqr_ref, note, created_at)
         SELECT ?, booking_id, ?, ${column}, ?, ?, ?
           FROM b2b_settlements
          WHERE booking_id = ? AND status = 'RELEASED' AND released_at = ? AND ${column} > 0`,
      )
      .bind(newId('led'), entryType, ref, note, now, booking.id, now);

  const statements = [
    releaseSettlement,
    ledgerRow(
      'BALANCE_COLLECTED',
      'balance_collected_vnd',
      'Xác nhận thủ công: đã nhận phần còn lại từ shop',
      balanceRef || null,
    ),
    ledgerRow('DEFECT_DEDUCTION', 'nursery_deduction_vnd', 'Khấu trừ phần nhà vườn do hàng lỗi', null),
    ledgerRow('BUYER_REFUND', 'buyer_refund_vnd', 'Hoàn cọc cho shop (ghi nhận, chưa phải lệnh chuyển)', null),
    ledgerRow('PLATFORM_FEE_RETAINED', 'platform_fee_vnd', 'Phí sàn giữ lại trên giá trị hàng đạt', null),
    ledgerRow(
      'NURSERY_PAYOUT_RELEASED',
      'nursery_payout_vnd',
      'Ghi nhận khoản phải trả nhà vườn đã được xác nhận giải ngân',
      null,
    ),
    db
      .prepare(
        `UPDATE b2b_bookings
            SET status = 'SETTLED',
                platform_fee_vnd = (SELECT platform_fee_vnd FROM b2b_settlements WHERE booking_id = ?),
                updated_at = ?
          WHERE id = ? AND status IN (${inspected}) AND EXISTS (${released.sql})`,
      )
      .bind(booking.id, now, booking.id, ...released.params),
    auditInsert(db, {
      workspaceId: input.actorWorkspaceId,
      actorId: input.actorId,
      action: 'marketplace.escrow.settlement_confirmed',
      subjectType: 'b2b_booking',
      subjectId: booking.id,
      detail: {
        settlement_id: settlement.id,
        balance_collected_vnd: settlement.buyer_balance_required_vnd,
        balance_ref: balanceRef || null,
        nursery_payout_vnd: settlement.nursery_payout_vnd,
        buyer_refund_vnd: settlement.buyer_refund_vnd,
        platform_fee_vnd: settlement.platform_fee_vnd,
      },
      at: now,
      onlyIf: released,
    }),
  ];

  const results = await db.batch(statements);
  if (changesAt(results, 0) === 0) {
    throw invalidState('Đối soát này vừa được xác nhận bởi thao tác khác.');
  }

  const [updatedBooking, updatedSettlement] = await Promise.all([
    db.prepare('SELECT * FROM b2b_bookings WHERE id = ?').bind(booking.id).first<B2bBookingRow>(),
    readSettlementForBooking(db, booking.id),
  ]);
  if (!updatedBooking || !updatedSettlement) throw new Error('Lỗi cập nhật đối soát.');
  return { booking: updatedBooking, settlement: updatedSettlement };
}

// ---------------------------------------------------------------------------
// Pilot metrics
// ---------------------------------------------------------------------------

/**
 * Pilot KPIs over the bookings the caller is party to.
 *
 * The balance check is computed from the ledger, not assumed: for every
 * booking with a RELEASED settlement, confirmed inflow (deposit + balance)
 * must equal recorded outflow (payout + refund + fee). A booking where it does
 * not is counted, and any excess of outflow over inflow is reported as
 * platform outlay — the figure the zero-outlay rule says must stay at 0.
 */
export async function getPilotDashboardData(
  db: D1Like,
  options: { workspaceIds: readonly string[] },
): Promise<ReturnType<typeof computePilotMetrics>> {
  if (options.workspaceIds.length === 0) {
    return computePilotMetrics({
      verifiedNurseriesCount: 0,
      activeBuyerShopsCount: 0,
      completedBookingsCount: 0,
      repeatBuyersCount: 0,
      totalUniqueBuyersEligibleForRetention: 0,
      unbalancedSettledBookingsCount: 0,
      totalPlatformOutlayVnd: 0,
    });
  }
  const marks = placeholders(options.workspaceIds.length);
  const party = `(b.buyer_workspace_id IN (${marks}) OR b.nursery_workspace_id IN (${marks}))`;
  const partyParams = [...options.workspaceIds, ...options.workspaceIds];

  const nurseries = await db
    .prepare(
      `SELECT COUNT(*) AS total FROM nursery_profiles
        WHERE verified_status = 'VERIFIED' AND workspace_id IN (${marks})`,
    )
    .bind(...options.workspaceIds)
    .first<{ total: number }>();

  const activeBuyers = await db
    .prepare(`SELECT COUNT(DISTINCT b.buyer_workspace_id) AS total FROM b2b_bookings b WHERE ${party}`)
    .bind(...partyParams)
    .first<{ total: number }>();

  const completed = await db
    .prepare(
      `SELECT COUNT(*) AS total FROM b2b_bookings b
        WHERE ${party} AND b.status IN ('SETTLED', 'INSPECTED_ACCEPTED', 'INSPECTED_PARTIAL_DEFECT')`,
    )
    .bind(...partyParams)
    .first<{ total: number }>();

  const repeatBuyers = await db
    .prepare(
      `SELECT COUNT(*) AS total FROM (
         SELECT b.buyer_workspace_id FROM b2b_bookings b WHERE ${party}
          GROUP BY b.buyer_workspace_id HAVING COUNT(*) > 1
       )`,
    )
    .bind(...partyParams)
    .first<{ total: number }>();

  const { results: ledgerByBooking } = await db
    .prepare(
      `SELECT b.id AS booking_id,
              COALESCE(SUM(CASE WHEN e.entry_type IN ('DEPOSIT_HELD', 'BALANCE_COLLECTED') THEN e.amount_vnd ELSE 0 END), 0) AS inflow_vnd,
              COALESCE(SUM(CASE WHEN e.entry_type IN ('NURSERY_PAYOUT_RELEASED', 'BUYER_REFUND', 'PLATFORM_FEE_RETAINED') THEN e.amount_vnd ELSE 0 END), 0) AS outflow_vnd
         FROM b2b_bookings b
         JOIN b2b_settlements s ON s.booking_id = b.id AND s.status = 'RELEASED'
         LEFT JOIN escrow_ledger_entries e ON e.booking_id = b.id
        WHERE ${party}
        GROUP BY b.id`,
    )
    .bind(...partyParams)
    .all<{ booking_id: string; inflow_vnd: number; outflow_vnd: number }>();

  let unbalanced = 0;
  let outlay = 0;
  for (const row of ledgerByBooking) {
    if (row.inflow_vnd !== row.outflow_vnd) unbalanced += 1;
    if (row.outflow_vnd > row.inflow_vnd) outlay = assertSafeVnd(outlay + (row.outflow_vnd - row.inflow_vnd));
  }

  return computePilotMetrics({
    verifiedNurseriesCount: nurseries?.total ?? 0,
    activeBuyerShopsCount: activeBuyers?.total ?? 0,
    completedBookingsCount: completed?.total ?? 0,
    repeatBuyersCount: repeatBuyers?.total ?? 0,
    totalUniqueBuyersEligibleForRetention: activeBuyers?.total ?? 0,
    unbalancedSettledBookingsCount: unbalanced,
    totalPlatformOutlayVnd: outlay,
  });
}
