/**
 * B2B Floriculture Marketplace, Hub Consolidation & Escrow Ledger HTTP route handlers.
 *
 * Every handler receives a context the Worker built from the chokepoint: the
 * workspace the request named and the chokepoint confirmed, the caller's role
 * there, and two ways to ask about *other* workspaces — the list of workspaces
 * the caller may perform this route's action in, and a fresh check for one
 * workspace. A record with two parties (a booking has a buyer and a nursery)
 * is visible when the caller may act in either; a record the caller may not
 * see is answered 404, the same as one that does not exist.
 *
 * Input is validated with Zod. Domain refusals arrive as `DomainError` with a
 * status and a stable `code`; anything else is reported generically.
 */

import { z } from 'zod';
import type { D1Like } from './catalog.ts';
import type { Role } from '../security/authorize.ts';
import { apiError, DomainError, GENERIC_MESSAGES, responseForThrown } from './api-error.ts';
import {
  listSupplyLots,
  createSupplyLot,
  listB2bBookings,
  createBooking,
  confirmDeposit,
  listHubTrips,
  createHubTrip,
  verifyHubPackage,
  inspectBooking,
  confirmSettlement,
  readVisibleBooking,
  readSettlementForBooking,
  getPilotDashboardData,
  LotRevisionConflictError,
  type HubDispatchTripRow,
} from './b2b-catalog.ts';
import { tryBuildVietQrEscrowPayload, type EscrowAccount } from '../domain/vietqr.ts';

export { LotRevisionConflictError };

const positiveVnd = z.number().int().positive();

export const createLotSchema = z.object({
  name: z.string().trim().min(1).max(200),
  mode: z.enum(['WEEKLY_CATALOG', 'SEASONAL_PREORDER']),
  species: z.string().trim().min(1).max(120),
  grade: z.enum(['A', 'B', 'EXPORT']).optional().default('A'),
  pot_diameter_cm: z.number().int().positive().max(300),
  height_cm: z.number().int().positive().max(1000),
  canopy_cm: z.number().int().positive().max(1000),
  bud_specification: z.string().trim().min(1).max(300),
  media_proof_url: z.string().trim().min(1).max(500),
  unit: z.string().trim().min(1).max(40).optional().default('chậu'),
  unit_price_vnd: positiveVnd,
  deposit_rate_bps: z.number().int().min(3000).max(5000),
  moq_units: z.number().int().positive().max(100000),
  total_units: z.number().int().positive().max(1000000),
  cut_or_ship_date: z.string().trim().min(10).max(40),
});

export const createBookingSchema = z.object({
  lot_id: z.string().trim().min(1).max(64),
  quantity: z.number().int().positive().max(100000),
  buyer_shop_name: z.string().trim().min(1).max(200),
  buyer_contact_phone: z.string().trim().min(6).max(40),
  destination_market: z.string().trim().min(1).max(200),
  note: z.string().trim().max(1000).nullish(),
  expected_revision: z.string().trim().min(1).max(300).optional(),
});

export const confirmDepositSchema = z.object({
  booking_id: z.string().trim().min(1).max(64),
  vietqr_ref: z.string().trim().min(1).max(120).optional(),
});

export const createHubTripSchema = z.object({
  truck_plate: z.string().trim().min(4).max(20),
  driver_name: z.string().trim().min(1).max(120),
  driver_phone: z.string().trim().min(6).max(40),
  departure_sa_dec_at: z.string().trim().min(10).max(40),
  eta_hcm_at: z.string().trim().min(10).max(40),
  destination_market: z.string().trim().min(1).max(200),
  capacity_units: z.number().int().positive().max(100000),
});

export const verifyHubPackageSchema = z.object({
  trip_id: z.string().trim().min(1).max(64),
  booking_id: z.string().trim().min(1).max(64),
  package_label: z.string().trim().min(1).max(200),
  hub_note: z.string().trim().max(500).optional(),
});

/**
 * `fault_party` accepts NONE and NURSERY only. The domain type also knows
 * CARRIER, but no approved rule says who bears a carrier's damage, so the
 * executable flow does not offer it. Recorded as a product decision to make.
 */
export const inspectAndSettleSchema = z.object({
  booking_id: z.string().trim().min(1).max(64),
  accepted_units: z.number().int().nonnegative(),
  defective_units: z.number().int().nonnegative(),
  fault_party: z.enum(['NONE', 'NURSERY']),
  note: z.string().trim().max(500).optional(),
});

export const confirmSettlementSchema = z.object({
  booking_id: z.string().trim().min(1).max(64),
  balance_ref: z.string().trim().min(1).max(120).optional(),
  note: z.string().trim().max(500).optional(),
});

export interface B2bOpsContext {
  /** The workspace the request named and the chokepoint confirmed. */
  workspaceId: string;
  role: Role;
  /** The identity acting, from the membership row — never from the request. */
  actorId: string;
  db: D1Like;
  /** Workspaces in which the caller may perform this route's action. */
  accessibleWorkspaceIds(): Promise<readonly string[]>;
  /** A fresh chokepoint check for one workspace, for this route's action. */
  authorizeWorkspace(workspaceId: string): Promise<boolean>;
  /**
   * The account a buyer would pay into, from deployment configuration, or null
   * when none is configured. Null means no QR is shown — never a default.
   */
  escrowAccount: EscrowAccount | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function validationMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return 'Dữ liệu không hợp lệ.';
  const field = issue.path.join('.');
  return field === ''
    ? `Dữ liệu không hợp lệ: ${issue.message}`
    : `Dữ liệu không hợp lệ ở "${field}": ${issue.message}`;
}

function notFound(): Response {
  return apiError(GENERIC_MESSAGES.notFound, 404, 'not_found');
}

export async function handleListLots(
  ctx: B2bOpsContext,
  searchParams: URLSearchParams,
): Promise<Response> {
  const modeParam = searchParams.get('mode');
  const mode =
    modeParam === 'WEEKLY_CATALOG' || modeParam === 'SEASONAL_PREORDER'
      ? modeParam
      : undefined;
  // `mine=1` narrows to the lots this workspace listed; anything else is the
  // whole published catalogue, which every member may see.
  const nurseryWorkspaceId = searchParams.get('mine') === '1' ? ctx.workspaceId : undefined;

  const lots = await listSupplyLots(ctx.db, { mode, nurseryWorkspaceId });
  return json({ lots });
}

export async function handleCreateLot(
  ctx: B2bOpsContext,
  body: unknown,
): Promise<Response> {
  const parsed = createLotSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(validationMessage(parsed.error), 400, 'validation');
  }

  try {
    const lot = await createSupplyLot(ctx.db, ctx.workspaceId, parsed.data);
    return json({ lot }, 201);
  } catch (err) {
    return responseForThrown(err, 'Không thể tạo lô hàng.');
  }
}

/**
 * Bookings of the selected workspace, as buyer or as nursery.
 *
 * A list is scoped to the workspace the caller selected and the chokepoint
 * confirmed, not to every workspace they hold: a person switched into Vườn B
 * is looking at Vườn B's book, and sees Vườn A's by switching. Record-level
 * actions below use the wider accessible set, because a founder confirming a
 * deposit may do so from any workspace they administer.
 */
export async function handleListBookings(ctx: B2bOpsContext): Promise<Response> {
  const bookings = await listB2bBookings(ctx.db, { workspaceIds: [ctx.workspaceId] });

  const enriched = bookings.map((b) => ({
    ...b,
    deposit_vietqr: tryBuildVietQrEscrowPayload(ctx.escrowAccount, {
      amountVnd: b.deposit_required_vnd,
      bookingCode: b.booking_code,
      phase: 'DEP',
    }),
    balance_vietqr:
      b.settlement !== null && b.settlement.buyer_balance_required_vnd > 0
        ? tryBuildVietQrEscrowPayload(ctx.escrowAccount, {
            amountVnd: b.settlement.buyer_balance_required_vnd,
            bookingCode: b.booking_code,
            phase: 'BAL',
          })
        : null,
  }));

  return json({ bookings: enriched });
}

export async function handleCreateBooking(
  ctx: B2bOpsContext,
  body: unknown,
): Promise<Response> {
  const parsed = createBookingSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(validationMessage(parsed.error), 400, 'validation');
  }

  try {
    const booking = await createBooking(ctx.db, ctx.workspaceId, ctx.actorId, {
      lotId: parsed.data.lot_id,
      quantity: parsed.data.quantity,
      buyerShopName: parsed.data.buyer_shop_name,
      buyerContactPhone: parsed.data.buyer_contact_phone,
      destinationMarket: parsed.data.destination_market,
      note: parsed.data.note ?? null,
      expectedRevision: parsed.data.expected_revision ?? null,
    });
    const depositQr = tryBuildVietQrEscrowPayload(ctx.escrowAccount, {
      amountVnd: booking.deposit_required_vnd,
      bookingCode: booking.booking_code,
      phase: 'DEP',
    });
    return json({ booking, deposit_vietqr: depositQr }, 201);
  } catch (err) {
    return responseForThrown(err, 'Không thể đặt giữ lô hàng.');
  }
}

export async function handleConfirmDeposit(
  ctx: B2bOpsContext,
  body: unknown,
): Promise<Response> {
  const parsed = confirmDepositSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(validationMessage(parsed.error), 400, 'validation');
  }

  try {
    const booking = await readVisibleBooking(
      ctx.db,
      parsed.data.booking_id,
      await ctx.accessibleWorkspaceIds(),
    );
    if (booking === null) return notFound();

    const updated = await confirmDeposit(ctx.db, booking, {
      vietqrRef: parsed.data.vietqr_ref,
      actorId: ctx.actorId,
      actorWorkspaceId: ctx.workspaceId,
    });
    return json({ booking: updated });
  } catch (err) {
    return responseForThrown(err, 'Không thể xác nhận cọc.');
  }
}

export async function handleListHubTrips(ctx: B2bOpsContext): Promise<Response> {
  const trips = await listHubTrips(ctx.db, { workspaceIds: await ctx.accessibleWorkspaceIds() });
  return json({ trips });
}

export async function handleCreateHubTrip(ctx: B2bOpsContext, body: unknown): Promise<Response> {
  const parsed = createHubTripSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(validationMessage(parsed.error), 400, 'validation');
  }
  try {
    const trip = await createHubTrip(ctx.db, {
      truckPlate: parsed.data.truck_plate,
      driverName: parsed.data.driver_name,
      driverPhone: parsed.data.driver_phone,
      departureSaDecAt: parsed.data.departure_sa_dec_at,
      etaHcmAt: parsed.data.eta_hcm_at,
      destinationMarket: parsed.data.destination_market,
      capacityUnits: parsed.data.capacity_units,
      actorId: ctx.actorId,
      actorWorkspaceId: ctx.workspaceId,
    });
    return json({ trip }, 201);
  } catch (err) {
    return responseForThrown(err, 'Không thể tạo chuyến Hub.');
  }
}

export async function handleVerifyHubPackage(
  ctx: B2bOpsContext,
  body: unknown,
): Promise<Response> {
  const parsed = verifyHubPackageSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(validationMessage(parsed.error), 400, 'validation');
  }

  try {
    const workspaceIds = await ctx.accessibleWorkspaceIds();
    const booking = await readVisibleBooking(ctx.db, parsed.data.booking_id, workspaceIds);
    if (booking === null) return notFound();

    const trip = await ctx.db
      .prepare('SELECT * FROM hub_dispatch_trips WHERE id = ?')
      .bind(parsed.data.trip_id)
      .first<HubDispatchTripRow>();
    if (trip === null) return notFound();

    const pkg = await verifyHubPackage(ctx.db, {
      trip,
      booking,
      packageLabel: parsed.data.package_label,
      hubNote: parsed.data.hub_note,
      actorId: ctx.actorId,
      actorWorkspaceId: ctx.workspaceId,
    });
    return json({ package: pkg }, 201);
  } catch (err) {
    return responseForThrown(err, 'Không thể kiểm định kiện hàng tại Hub.');
  }
}

/**
 * The buyer records the inspection. The response carries the obligations the
 * inspection computed and the stored settlement row; it carries no cash
 * movement, because none has happened — the founder confirms that separately.
 */
export async function handleInspectAndSettle(
  ctx: B2bOpsContext,
  body: unknown,
): Promise<Response> {
  const parsed = inspectAndSettleSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(validationMessage(parsed.error), 400, 'validation');
  }

  try {
    const workspaceIds = await ctx.accessibleWorkspaceIds();
    const booking = await readVisibleBooking(ctx.db, parsed.data.booking_id, workspaceIds);
    if (booking === null) return notFound();

    // Only the buying shop inspects what it received; a founder may stand in.
    // The nursery is party to the booking and can read it, so this is a 403
    // with a reason rather than a 404.
    const isBuyer = workspaceIds.includes(booking.buyer_workspace_id);
    if (!isBuyer && ctx.role !== 'founder_admin') {
      return apiError(
        'Chỉ shop đặt mua đơn hàng này hoặc quản trị sàn mới được quyền nghiệm thu.',
        403,
        'forbidden',
      );
    }

    const result = await inspectBooking(ctx.db, booking, {
      acceptedUnits: parsed.data.accepted_units,
      defectiveUnits: parsed.data.defective_units,
      faultParty: parsed.data.fault_party,
      note: parsed.data.note,
      actorId: ctx.actorId,
      actorWorkspaceId: ctx.workspaceId,
    });
    const balanceQr =
      result.computed.buyerBalanceRequiredVnd > 0
        ? tryBuildVietQrEscrowPayload(ctx.escrowAccount, {
            amountVnd: result.computed.buyerBalanceRequiredVnd,
            bookingCode: result.booking.booking_code,
            phase: 'BAL',
          })
        : null;
    return json({
      booking: result.booking,
      settlement: result.computed,
      settlement_record: result.settlement,
      balance_vietqr: balanceQr,
    });
  } catch (err) {
    return responseForThrown(err, 'Không thể nghiệm thu đơn hàng.');
  }
}

export async function handleConfirmSettlement(
  ctx: B2bOpsContext,
  body: unknown,
): Promise<Response> {
  const parsed = confirmSettlementSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(validationMessage(parsed.error), 400, 'validation');
  }

  try {
    const booking = await readVisibleBooking(
      ctx.db,
      parsed.data.booking_id,
      await ctx.accessibleWorkspaceIds(),
    );
    if (booking === null) return notFound();
    const settlement = await readSettlementForBooking(ctx.db, booking.id);
    if (settlement === null) {
      throw new DomainError('Đơn hàng chưa được nghiệm thu nên chưa có gì để đối soát.', 409, 'invalid_state');
    }

    const result = await confirmSettlement(ctx.db, booking, settlement, {
      balanceRef: parsed.data.balance_ref,
      note: parsed.data.note,
      actorId: ctx.actorId,
      actorWorkspaceId: ctx.workspaceId,
    });
    return json({ booking: result.booking, settlement_record: result.settlement });
  } catch (err) {
    return responseForThrown(err, 'Không thể xác nhận đối soát.');
  }
}

export async function handlePilotDashboard(ctx: B2bOpsContext): Promise<Response> {
  const metrics = await getPilotDashboardData(ctx.db, {
    workspaceIds: await ctx.accessibleWorkspaceIds(),
  });
  return json({ metrics });
}
