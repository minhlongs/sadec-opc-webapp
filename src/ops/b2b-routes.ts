/**
 * B2B Floriculture Marketplace, Hub Consolidation & Escrow Ledger HTTP route handlers.
 *
 * Every handler receives an authenticated authorization context resolved through
 * `src/security/authorize.ts` and validates input strictly via Zod.
 */

import { z } from 'zod';
import type { D1Like } from './catalog.ts';
import type { Role } from '../security/authorize.ts';
import { apiError } from './routes.ts';
import {
  listSupplyLots,
  createSupplyLot,
  listB2bBookings,
  createBooking,
  confirmDeposit,
  listHubTrips,
  verifyHubPackage,
  inspectAndSettleBooking,
  getPilotDashboardData,
  LotRevisionConflictError,
} from './b2b-catalog.ts';
import { buildVietQrEscrowPayload } from '../domain/vietqr.ts';

const positiveVnd = z.number().int().positive();

export const createLotSchema = z.object({
  name: z.string().trim().min(1).max(200),
  mode: z.enum(['WEEKLY_CATALOG', 'SEASONAL_PREORDER']),
  species: z.string().trim().min(1).max(120),
  grade: z.enum(['A', 'B', 'EXPORT']).optional().default('A'),
  pot_diameter_cm: z.number().int().positive().max(300),
  height_cm: z.number().int().positive().max(1000),
  canopy_cm: z.number().int().nonnegative().max(1000),
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

export const verifyHubPackageSchema = z.object({
  trip_id: z.string().trim().min(1).max(64),
  booking_id: z.string().trim().min(1).max(64),
  package_label: z.string().trim().min(1).max(200),
  hub_note: z.string().trim().max(500).optional(),
});

export const inspectAndSettleSchema = z.object({
  booking_id: z.string().trim().min(1).max(64),
  accepted_units: z.number().int().nonnegative(),
  defective_units: z.number().int().nonnegative(),
  fault_party: z.enum(['NONE', 'NURSERY']),
  note: z.string().trim().max(500).optional(),
});

export interface B2bOpsContext {
  workspaceId: string;
  role: Role;
  db: D1Like;
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

export async function handleListLots(
  ctx: B2bOpsContext,
  searchParams: URLSearchParams,
): Promise<Response> {
  const modeParam = searchParams.get('mode');
  const mode =
    modeParam === 'WEEKLY_CATALOG' || modeParam === 'SEASONAL_PREORDER'
      ? modeParam
      : undefined;

  const lots = await listSupplyLots(ctx.db, { mode });
  return json({ lots });
}

export async function handleCreateLot(
  ctx: B2bOpsContext,
  body: unknown,
): Promise<Response> {
  const parsed = createLotSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(validationMessage(parsed.error), 400);
  }

  try {
    const lot = await createSupplyLot(ctx.db, ctx.workspaceId, parsed.data);
    return json({ lot }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Không thể tạo lô hàng.';
    return apiError(msg, 400);
  }
}

export async function handleListBookings(ctx: B2bOpsContext): Promise<Response> {
  const bookings = await listB2bBookings(ctx.db, {
    workspaceId: ctx.workspaceId,
    role: ctx.role,
  });

  const enriched = bookings.map((b) => {
    const depositQr = buildVietQrEscrowPayload({
      amountVnd: b.deposit_required_vnd,
      bookingCode: b.booking_code,
      phase: 'DEP',
    });
    return {
      ...b,
      deposit_vietqr: depositQr,
    };
  });

  return json({ bookings: enriched });
}

export async function handleCreateBooking(
  ctx: B2bOpsContext,
  body: unknown,
): Promise<Response> {
  const parsed = createBookingSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(validationMessage(parsed.error), 400);
  }

  try {
    const booking = await createBooking(ctx.db, ctx.workspaceId, {
      lotId: parsed.data.lot_id,
      quantity: parsed.data.quantity,
      buyerShopName: parsed.data.buyer_shop_name,
      buyerContactPhone: parsed.data.buyer_contact_phone,
      destinationMarket: parsed.data.destination_market,
      note: parsed.data.note ?? null,
      expectedRevision: parsed.data.expected_revision ?? null,
      expected_revision: parsed.data.expected_revision ?? null,
    });
    const depositQr = buildVietQrEscrowPayload({
      amountVnd: booking.deposit_required_vnd,
      bookingCode: booking.booking_code,
      phase: 'DEP',
    });
    return json({ booking, deposit_vietqr: depositQr }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Không thể đặt giữ lô hàng.';
    const isRevisionConflict =
      err instanceof LotRevisionConflictError || msg.includes('revision không khớp');
    return apiError(msg, isRevisionConflict ? 409 : 400);
  }
}

export async function handleConfirmDeposit(
  ctx: B2bOpsContext,
  body: unknown,
): Promise<Response> {
  const parsed = confirmDepositSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(validationMessage(parsed.error), 400);
  }

  try {
    const booking = await confirmDeposit(
      ctx.db,
      parsed.data.booking_id,
      parsed.data.vietqr_ref,
    );
    return json({ booking });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Không thể xác nhận cọc.';
    return apiError(msg, 400);
  }
}

export async function handleListHubTrips(ctx: B2bOpsContext): Promise<Response> {
  const trips = await listHubTrips(ctx.db);
  return json({ trips });
}

export async function handleVerifyHubPackage(
  ctx: B2bOpsContext,
  body: unknown,
): Promise<Response> {
  const parsed = verifyHubPackageSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(validationMessage(parsed.error), 400);
  }

  try {
    const pkg = await verifyHubPackage(
      ctx.db,
      parsed.data.trip_id,
      parsed.data.booking_id,
      parsed.data.package_label,
      parsed.data.hub_note,
    );
    return json({ package: pkg }, 201);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Không thể kiểm định kiện hàng tại Hub.';
    return apiError(msg, 400);
  }
}

export async function handleInspectAndSettle(
  ctx: B2bOpsContext,
  body: unknown,
): Promise<Response> {
  const parsed = inspectAndSettleSchema.safeParse(body);
  if (!parsed.success) {
    return apiError(validationMessage(parsed.error), 400);
  }

  try {
    const result = await inspectAndSettleBooking(
      ctx.db,
      parsed.data.booking_id,
      {
        acceptedUnits: parsed.data.accepted_units,
        defectiveUnits: parsed.data.defective_units,
        faultParty: parsed.data.fault_party,
        note: parsed.data.note,
      },
      { workspaceId: ctx.workspaceId, role: ctx.role },
    );
    const balanceQr =
      result.settlement.buyerBalanceRequiredVnd > 0
        ? buildVietQrEscrowPayload({
            amountVnd: result.settlement.buyerBalanceRequiredVnd,
            bookingCode: result.booking.booking_code,
            phase: 'BAL',
          })
        : null;
    return json({
      booking: result.booking,
      settlement: result.settlement,
      balance_vietqr: balanceQr,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Không thể nghiệm thu và tất toán đơn hàng.';
    return apiError(msg, 400);
  }
}

export async function handlePilotDashboard(ctx: B2bOpsContext): Promise<Response> {
  const metrics = await getPilotDashboardData(ctx.db);
  return json({ metrics });
}
