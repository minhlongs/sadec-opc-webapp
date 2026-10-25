/**
 * B2B Catalog and D1 queries for lots, bookings, ledger, hub dispatch, and pilot metrics.
 */

import type { D1Like } from './catalog.ts';
import { assertSafeVnd } from '../domain/money.ts';
import {
  calculateBookingQuote,
  calculateInspectionSettlement,
  type InspectionFaultParty,
} from '../domain/escrow-ledger.ts';
import { signLotQrToken } from '../domain/lot-qr.ts';
import { computePilotMetrics } from '../domain/pilot-metrics.ts';
import { computeLotRevision } from '../domain/aeo-projection.ts';

/**
 * Raised when a booking names a lot revision that no longer matches the stored
 * lot. The caller read the catalog, the lot changed, and reserving against the
 * stale view would sell stock at a price or quantity the buyer never saw. It is
 * a distinct class so the route layer can answer 409 without matching on prose.
 */
export class LotRevisionConflictError extends Error {
  constructor() {
    super(
      'Dữ liệu lô hàng đã thay đổi (revision không khớp). Vui lòng tải lại danh mục trước khi đặt giữ.',
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
  const lotId = `lot-${crypto.randomUUID().slice(0, 8)}`;
  const lotCode = `SDEC-LOT-${Date.now().toString(36).toUpperCase()}`;
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

export async function listB2bBookings(
  db: D1Like,
  options: { workspaceId: string; role: string },
): Promise<
  (B2bBookingRow & {
    lot_name?: string;
    lot_code?: string;
    nursery_name?: string;
    ledger_entries: EscrowLedgerRow[];
  })[]
> {
  let query = `
    SELECT b.*, l.name AS lot_name, l.lot_code, n.nursery_name
      FROM b2b_bookings b
      JOIN supply_lots l ON l.id = b.lot_id
      JOIN nursery_profiles n ON n.workspace_id = b.nursery_workspace_id
  `;
  const params: unknown[] = [];

  if (options.role !== 'founder_admin') {
    query += ' WHERE (b.buyer_workspace_id = ? OR b.nursery_workspace_id = ?)';
    params.push(options.workspaceId, options.workspaceId);
  }

  query += ' ORDER BY b.created_at DESC';

  const stmt = db.prepare(query);
  const { results: bookings } = await (params.length > 0 ? stmt.bind(...params) : stmt).all<
    B2bBookingRow & { lot_name?: string; lot_code?: string; nursery_name?: string }
  >();

  const fullBookings = [];
  for (const booking of bookings) {
    const { results: ledger_entries } = await db
      .prepare('SELECT * FROM escrow_ledger_entries WHERE booking_id = ? ORDER BY created_at ASC')
      .bind(booking.id)
      .all<EscrowLedgerRow>();

    fullBookings.push({
      ...booking,
      ledger_entries,
    });
  }

  return fullBookings;
}

export async function createBooking(
  db: D1Like,
  buyerWorkspaceId: string,
  input: {
    lotId: string;
    quantity: number;
    buyerShopName: string;
    buyerContactPhone: string;
    destinationMarket: string;
    note?: string | null;
    expectedRevision?: string | null;
    expected_revision?: string | null;
  },
): Promise<B2bBookingRow> {
  const lot = await db
    .prepare('SELECT * FROM supply_lots WHERE id = ? AND status = ?')
    .bind(input.lotId, 'PUBLISHED')
    .first<SupplyLotRow>();

  if (!lot) {
    throw new Error('Lô hàng không tồn tại hoặc đã ngưng mở bán.');
  }

  const expectedRevision = input.expectedRevision ?? input.expected_revision;
  if (
    typeof expectedRevision === 'string' &&
    expectedRevision.trim() !== '' &&
    expectedRevision.trim() !== computeLotRevision(lot)
  ) {
    throw new LotRevisionConflictError();
  }

  if (lot.available_units < input.quantity) {
    throw new Error(`Số lượng còn lại không đủ (còn ${lot.available_units} ${lot.unit}).`);
  }
  if (input.quantity < lot.moq_units) {
    throw new Error(`Số lượng đặt tối thiểu là ${lot.moq_units} ${lot.unit}.`);
  }

  const quote = calculateBookingQuote({
    quantity: input.quantity,
    unitPriceVnd: lot.unit_price_vnd,
    depositRateBps: lot.deposit_rate_bps,
    platformFeeBps: 300, // 3% platform fee
  });

  const bookingId = `bk-${crypto.randomUUID().slice(0, 8)}`;
  const bookingCode = `SDEC-BK-${Date.now().toString(36).toUpperCase()}`;
  const now = new Date().toISOString();

  // Atomic reservation: subtract stock with CHECK constraint
  const updateLot = db
    .prepare(
      `UPDATE supply_lots
          SET available_units = available_units - ?,
              status = CASE WHEN available_units - ? = 0 THEN 'SOLD_OUT' ELSE status END,
              updated_at = ?
        WHERE id = ? AND available_units >= ?`,
    )
    .bind(input.quantity, input.quantity, now, lot.id, input.quantity);

  const insertBooking = db
    .prepare(
      `INSERT INTO b2b_bookings (
        id, booking_code, lot_id, nursery_workspace_id, buyer_workspace_id,
        buyer_shop_name, buyer_contact_phone, destination_market,
        quantity, unit_price_vnd, gross_total_vnd, deposit_rate_bps,
        deposit_required_vnd, deposit_paid_vnd, platform_fee_bps, platform_fee_vnd,
        status, note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 300, ?, 'BOOKED_PENDING_DEPOSIT', ?, ?, ?)`,
    )
    .bind(
      bookingId,
      bookingCode,
      lot.id,
      lot.nursery_workspace_id,
      buyerWorkspaceId,
      input.buyerShopName,
      input.buyerContactPhone,
      input.destinationMarket,
      input.quantity,
      lot.unit_price_vnd,
      quote.grossTotalVnd,
      lot.deposit_rate_bps,
      quote.depositRequiredVnd,
      quote.platformFeeVnd,
      input.note ?? null,
      now,
      now,
    );

  await db.batch([updateLot, insertBooking]);

  const booking = await db
    .prepare('SELECT * FROM b2b_bookings WHERE id = ?')
    .bind(bookingId)
    .first<B2bBookingRow>();

  if (!booking) {
    throw new Error('Đặt giữ lô hàng thất bại.');
  }
  return booking;
}

export async function confirmDeposit(
  db: D1Like,
  bookingId: string,
  vietqrRef?: string,
): Promise<B2bBookingRow> {
  const booking = await db
    .prepare('SELECT * FROM b2b_bookings WHERE id = ?')
    .bind(bookingId)
    .first<B2bBookingRow>();

  if (!booking) {
    throw new Error('Đơn đặt giữ không tồn tại.');
  }
  if (booking.status !== 'BOOKED_PENDING_DEPOSIT') {
    throw new Error(`Đơn hàng ở trạng thái ${booking.status}, không thể xác nhận cọc.`);
  }

  const now = new Date().toISOString();
  const ledgerId = `led-${crypto.randomUUID().slice(0, 8)}`;
  const ref = vietqrRef ?? `SDEC DEP ${booking.booking_code}`;

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
      ) VALUES (?, ?, 'DEPOSIT_HELD', ?, ?, 'Xác nhận cọc VietQR bảo chứng qua Escrow sàn', ?)`,
    )
    .bind(ledgerId, booking.id, booking.deposit_required_vnd, ref, now);

  await db.batch([updateBooking, insertLedger]);

  const updated = await db
    .prepare('SELECT * FROM b2b_bookings WHERE id = ?')
    .bind(booking.id)
    .first<B2bBookingRow>();

  if (!updated) {
    throw new Error('Lỗi cập nhật cọc.');
  }
  return updated;
}

export async function listHubTrips(db: D1Like): Promise<
  (HubDispatchTripRow & {
    packages: (ShipmentPackageRow & { booking_code?: string; buyer_shop_name?: string })[];
  })[]
> {
  const { results: trips } = await db
    .prepare('SELECT * FROM hub_dispatch_trips ORDER BY departure_sa_dec_at ASC')
    .all<HubDispatchTripRow>();

  const fullTrips = [];
  for (const trip of trips) {
    const { results: packages } = await db
      .prepare(
        `SELECT p.*, b.booking_code, b.buyer_shop_name
           FROM shipment_packages p
           JOIN b2b_bookings b ON b.id = p.booking_id
          WHERE p.trip_id = ?`,
      )
      .bind(trip.id)
      .all<ShipmentPackageRow & { booking_code?: string; buyer_shop_name?: string }>();

    fullTrips.push({ ...trip, packages });
  }
  return fullTrips;
}

export async function verifyHubPackage(
  db: D1Like,
  tripId: string,
  bookingId: string,
  packageLabel: string,
  hubNote?: string,
): Promise<ShipmentPackageRow> {
  const booking = await db
    .prepare('SELECT * FROM b2b_bookings WHERE id = ?')
    .bind(bookingId)
    .first<B2bBookingRow>();

  if (!booking) {
    throw new Error('Đơn đặt giữ không tồn tại.');
  }
  if (booking.status !== 'ESCROW_HELD') {
    throw new Error(`Đơn hàng phải ở trạng thái ESCROW_HELD để gom Hub, hiện là: ${booking.status}`);
  }

  const pkgId = `pkg-${crypto.randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();
  const qrToken = await signLotQrToken({
    kind: 'PKG',
    entityId: pkgId,
    workspaceId: booking.nursery_workspace_id,
    issuedAt: now,
  });

  const insertPkg = db
    .prepare(
      `INSERT INTO shipment_packages (
        id, trip_id, booking_id, package_qr_token, package_label, units_count,
        hub_inspection_status, hub_verified_at, hub_note,
        buyer_inspection_status, accepted_units, defective_units, fault_party,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'VERIFIED_OK', ?, ?, 'PENDING', 0, 0, 'NONE', ?, ?)`,
    )
    .bind(
      pkgId,
      tripId,
      booking.id,
      qrToken,
      packageLabel,
      booking.quantity,
      now,
      hubNote ?? 'Đạt tiêu chuẩn xuất Hub Sa Đéc',
      now,
      now,
    );

  const updateBooking = db
    .prepare("UPDATE b2b_bookings SET status = 'HUB_CONSOLIDATED', updated_at = ? WHERE id = ?")
    .bind(now, booking.id);

  const updateTrip = db
    .prepare(
      `UPDATE hub_dispatch_trips
          SET loaded_units = loaded_units + ?,
              updated_at = ?
        WHERE id = ?`,
    )
    .bind(booking.quantity, now, tripId);

  await db.batch([insertPkg, updateBooking, updateTrip]);

  const pkg = await db
    .prepare('SELECT * FROM shipment_packages WHERE id = ?')
    .bind(pkgId)
    .first<ShipmentPackageRow>();

  if (!pkg) {
    throw new Error('Lỗi tạo kiện hàng kiểm định.');
  }
  return pkg;
}

export async function inspectAndSettleBooking(
  db: D1Like,
  bookingId: string,
  input: {
    acceptedUnits: number;
    defectiveUnits: number;
    faultParty: InspectionFaultParty;
    note?: string;
  },
  actor?: { workspaceId: string; role: string },
): Promise<{ booking: B2bBookingRow; settlement: ReturnType<typeof calculateInspectionSettlement> }> {
  const booking = await db
    .prepare('SELECT * FROM b2b_bookings WHERE id = ?')
    .bind(bookingId)
    .first<B2bBookingRow>();

  if (!booking) {
    throw new Error('Đơn đặt giữ không tồn tại.');
  }

  if (
    actor &&
    actor.role !== 'founder_admin' &&
    booking.buyer_workspace_id !== actor.workspaceId
  ) {
    throw new Error('Chỉ shop đặt mua đơn hàng này hoặc quản trị sàn mới được quyền nghiệm thu.');
  }
  if (!['ESCROW_HELD', 'HUB_CONSOLIDATED', 'IN_TRANSIT'].includes(booking.status)) {
    throw new Error(`Đơn hàng ở trạng thái ${booking.status}, không thể nghiệm thu.`);
  }

  const settlement = calculateInspectionSettlement({
    unitPriceVnd: booking.unit_price_vnd,
    grossTotalVnd: booking.gross_total_vnd,
    depositPaidVnd: booking.deposit_paid_vnd,
    platformFeeBps: booking.platform_fee_bps,
    totalUnits: booking.quantity,
    acceptedUnits: input.acceptedUnits,
    defectiveUnits: input.defectiveUnits,
    faultParty: input.faultParty,
  });

  const now = new Date().toISOString();
  let nextStatus = 'SETTLED';
  if (settlement.acceptedUnits === 0 && settlement.faultParty === 'NURSERY') {
    nextStatus = 'REJECTED_NURSERY_FAULT';
  } else if (settlement.defectiveUnits > 0) {
    nextStatus = 'INSPECTED_PARTIAL_DEFECT';
  } else {
    nextStatus = 'INSPECTED_ACCEPTED';
  }

  const batchStmts = [];

  // Update booking status
  batchStmts.push(
    db
      .prepare(
        `UPDATE b2b_bookings
            SET status = ?,
                platform_fee_vnd = ?,
                note = COALESCE(note || ' | ', '') || ?,
                updated_at = ?
          WHERE id = ?`,
      )
      .bind(nextStatus, settlement.platformFeeRetainedVnd, input.note ?? 'Đã nghiệm thu', now, booking.id),
  );

  // Update shipment package inspection details if exists
  batchStmts.push(
    db
      .prepare(
        `UPDATE shipment_packages
            SET buyer_inspection_status = ?,
                buyer_inspected_at = ?,
                accepted_units = ?,
                defective_units = ?,
                fault_party = ?,
                updated_at = ?
          WHERE booking_id = ?`,
      )
      .bind(
        nextStatus === 'REJECTED_NURSERY_FAULT'
          ? 'REJECTED'
          : settlement.defectiveUnits > 0
            ? 'PARTIAL_DEFECT'
            : 'ACCEPTED',
        now,
        settlement.acceptedUnits,
        settlement.defectiveUnits,
        settlement.faultParty,
        now,
        booking.id,
      ),
  );

  // Write ledger entries based on settlement
  if (settlement.buyerBalanceRequiredVnd > 0) {
    batchStmts.push(
      db
        .prepare(
          `INSERT INTO escrow_ledger_entries (id, booking_id, entry_type, amount_vnd, vietqr_ref, note, created_at)
           VALUES (?, ?, 'BALANCE_COLLECTED', ?, ?, 'Shop thanh toán nốt tiền hàng sau nghiệm thu', ?)`,
        )
        .bind(
          `led-bal-${crypto.randomUUID().slice(0, 6)}`,
          booking.id,
          settlement.buyerBalanceRequiredVnd,
          `SDEC BAL ${booking.booking_code}`,
          now,
        ),
    );
  }

  if (settlement.nurseryDeductionVnd > 0) {
    batchStmts.push(
      db
        .prepare(
          `INSERT INTO escrow_ledger_entries (id, booking_id, entry_type, amount_vnd, vietqr_ref, note, created_at)
           VALUES (?, ?, 'DEFECT_DEDUCTION', ?, NULL, 'Khấu trừ vào phần nhà vườn do hàng lỗi', ?)`,
        )
        .bind(
          `led-ded-${crypto.randomUUID().slice(0, 6)}`,
          booking.id,
          settlement.nurseryDeductionVnd,
          now,
        ),
    );
  }

  if (settlement.buyerRefundVnd > 0) {
    batchStmts.push(
      db
        .prepare(
          `INSERT INTO escrow_ledger_entries (id, booking_id, entry_type, amount_vnd, vietqr_ref, note, created_at)
           VALUES (?, ?, 'BUYER_REFUND', ?, NULL, 'Hoàn cọc lại cho shop do hàng lỗi quy cách', ?)`,
        )
        .bind(
          `led-ref-${crypto.randomUUID().slice(0, 6)}`,
          booking.id,
          settlement.buyerRefundVnd,
          now,
        ),
    );
  }

  if (settlement.platformFeeRetainedVnd > 0) {
    batchStmts.push(
      db
        .prepare(
          `INSERT INTO escrow_ledger_entries (id, booking_id, entry_type, amount_vnd, vietqr_ref, note, created_at)
           VALUES (?, ?, 'PLATFORM_FEE_RETAINED', ?, NULL, 'Phí sàn thu từ shop sau khi giao hàng thành công', ?)`,
        )
        .bind(
          `led-fee-${crypto.randomUUID().slice(0, 6)}`,
          booking.id,
          settlement.platformFeeRetainedVnd,
          now,
        ),
    );
  }

  if (settlement.nurseryPayoutVnd > 0) {
    batchStmts.push(
      db
        .prepare(
          `INSERT INTO escrow_ledger_entries (id, booking_id, entry_type, amount_vnd, vietqr_ref, note, created_at)
           VALUES (?, ?, 'NURSERY_PAYOUT_RELEASED', ?, NULL, 'Giải ngân tiền hàng cho nhà vườn Sa Đéc', ?)`,
        )
        .bind(
          `led-out-${crypto.randomUUID().slice(0, 6)}`,
          booking.id,
          settlement.nurseryPayoutVnd,
          now,
        ),
    );
  }

  await db.batch(batchStmts);

  const updatedBooking = await db
    .prepare('SELECT * FROM b2b_bookings WHERE id = ?')
    .bind(booking.id)
    .first<B2bBookingRow>();

  if (!updatedBooking) {
    throw new Error('Lỗi cập nhật nghiệm thu.');
  }

  return { booking: updatedBooking, settlement };
}

export async function getPilotDashboardData(db: D1Like): Promise<ReturnType<typeof computePilotMetrics>> {
  const nurseries = await db
    .prepare("SELECT COUNT(*) AS total FROM nursery_profiles WHERE verified_status = 'VERIFIED'")
    .first<{ total: number }>();

  const activeBuyers = await db
    .prepare('SELECT COUNT(DISTINCT buyer_workspace_id) AS total FROM b2b_bookings')
    .first<{ total: number }>();

  const completedBookings = await db
    .prepare(
      "SELECT COUNT(*) AS total FROM b2b_bookings WHERE status IN ('SETTLED', 'INSPECTED_ACCEPTED', 'INSPECTED_PARTIAL_DEFECT')",
    )
    .first<{ total: number }>();

  const repeatBuyers = await db
    .prepare(
      `SELECT COUNT(*) AS total FROM (
         SELECT buyer_workspace_id FROM b2b_bookings GROUP BY buyer_workspace_id HAVING COUNT(*) > 1
       )`,
    )
    .first<{ total: number }>();

  const totalEligibleBuyers = await db
    .prepare('SELECT COUNT(DISTINCT buyer_workspace_id) AS total FROM b2b_bookings')
    .first<{ total: number }>();

  return computePilotMetrics({
    verifiedNurseriesCount: nurseries?.total ?? 0,
    activeBuyerShopsCount: activeBuyers?.total ?? 0,
    completedBookingsCount: completedBookings?.total ?? 0,
    repeatBuyersCount: repeatBuyers?.total ?? 0,
    totalUniqueBuyersEligibleForRetention: totalEligibleBuyers?.total ?? 0,
    unbalancedSettledBookingsCount: 0,
    totalPlatformOutlayVnd: 0,
  });
}
