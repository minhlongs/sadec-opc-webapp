/**
 * The browser's only way to reach the API.
 *
 * Two rules this file exists to keep. The workspace travels as a query parameter
 * and comes from the session the server resolved, so no screen picks one — a UI
 * that chose its own workspace would be a UI that could ask for another one. And
 * a total is never computed here: the client can display a preview but the value
 * that counts is the one the server returns from `/api/quote-drafts/save`.
 */

import type { QuoteLineDraft } from '../ops/catalog.ts';

/** The session the server resolved. Display data; permission stays server-side. */
export interface Session {
  accessSubject: string;
  email: string | null;
  displayName: string | null;
  role: 'founder_admin' | 'workspace_owner' | 'workspace_operator';
  workspaceId: string;
  demo: boolean;
  demoLabel: string | null;
}

export interface Product {
  id: string;
  name: string;
  species: string | null;
  size_class: string | null;
  grade: string | null;
  price_vnd: number;
  unit: string;
  stock_note: string | null;
}

export interface Customer {
  id: string;
  workspace_id: string;
  name: string;
  contact_name: string | null;
  phone: string | null;
  address: string | null;
  note: string | null;
}

export interface PricedLine {
  product_id: string;
  product_name: string;
  unit: string;
  unit_price_vnd: number;
  quantity: number;
  line_total_vnd: number;
  note: string | null;
}

export interface QuoteDraft {
  id: string;
  reference: string;
  customer_id: string;
  status: string;
  subtotal_vnd: number;
  lines: PricedLine[];
  note: string | null;
  updated_at: string;
}

export interface QuoteDraftInput {
  customer_id: string;
  reference: string;
  lines: QuoteLineDraft[];
  note: string | null;
}

/**
 * A call that did not get a usable answer.
 *
 * `status` is 0 for a network failure, which §5's offline state needs to tell
 * apart from a 401 or a 400 — a form must not be wiped because the operator
 * walked out of wifi range.
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const API = '/api';

let lastKnownWorkspaceId: string | null = null;
let lastFetchedLots: SupplyLotView[] = [];
const lotFetchListeners = new Set<(lots: readonly SupplyLotView[]) => void>();

export function getLastKnownWorkspaceId(): string | null {
  return lastKnownWorkspaceId;
}

export function getLastFetchedLots(): readonly SupplyLotView[] {
  return lastFetchedLots;
}

export function subscribeFetchedLots(
  listener: (lots: readonly SupplyLotView[]) => void,
): () => void {
  lotFetchListeners.add(listener);
  return () => {
    lotFetchListeners.delete(listener);
  };
}

function notifyFetchedLots(lots: readonly SupplyLotView[]): void {
  const byId = new Map<string, SupplyLotView>();
  for (const existing of lastFetchedLots) {
    byId.set(existing.id, existing);
  }
  for (const lot of lots) {
    byId.set(lot.id, lot);
  }
  lastFetchedLots = Array.from(byId.values());
  for (const listener of lotFetchListeners) {
    listener(lastFetchedLots);
  }
}

/** Thrown when a session has no workspace to scope a request to. */
function requireWorkspace(workspaceId: string | undefined): string {
  if (workspaceId === undefined || workspaceId.trim() === '') {
    throw new ApiError('Chưa xác định được workspace của phiên làm việc.', 0);
  }
  return workspaceId;
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error.trim() !== '') return body.error;
  } catch {
    // A refusal with a non-JSON body still has a status, which is enough.
  }
  return `Yêu cầu thất bại (${response.status}).`;
}

/**
 * Reads a JSON body, and reports a body that is not JSON in Vietnamese.
 *
 * A 200 whose body is not JSON is not hypothetical: Access answers an
 * unauthenticated request with an HTML login page, so the browser can be handed a
 * success status and a page. Letting `response.json()` throw leaks its
 * `SyntaxError` — English text quoting the HTML — into a panel the operator
 * reads, which says nothing they can act on.
 *
 * The status is kept, because a 200 here and a 500 mean different things to
 * whoever debugs it.
 */
async function readJsonBody<T>(
  response: Response,
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  const text = await response.text();
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch {
    return {
      ok: false,
      message:
        response.status === 200
          ? 'Máy chủ trả về nội dung không phải dữ liệu. Phiên làm việc có thể đã hết hạn — thử lại.'
          : `Yêu cầu thất bại (${response.status}).`,
    };
  }
}

async function request<T>(
  path: string,
  workspaceId: string,
  init?: RequestInit,
): Promise<T> {
  if (workspaceId.trim() !== '') {
    lastKnownWorkspaceId = workspaceId;
  }
  const separator = path.includes('?') ? '&' : '?';
  const url = `${API}${path}${separator}workspace_id=${encodeURIComponent(workspaceId)}`;
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    // A failed fetch throws in the browser rather than returning a status, so
    // the offline case is caught here and reported as status 0.
    throw new ApiError('Mất kết nối. Kiểm tra mạng rồi thử lại.', 0);
  }

  if (!response.ok) {
    throw new ApiError(await readErrorMessage(response), response.status);
  }

  const parsed = await readJsonBody<T>(response);
  if (!parsed.ok) {
    throw new ApiError(parsed.message, response.status);
  }
  return parsed.value;
}

/**
 * A mutation sends nothing extra to prove where it came from.
 *
 * The Worker reads `Sec-Fetch-Site`, a header the browser sets itself and a page
 * cannot forge, so a request built here has nothing to add. An `Origin` header
 * set from script is dropped by the browser before the request leaves, because
 * `Origin` is a forbidden request-header name — which is why this function used
 * to look like it was standing a guard and was standing nothing.
 */
function mutationInit(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  };
}

export async function fetchSession(): Promise<Session> {
  // The session is the one request that cannot carry a workspace parameter,
  // because asking for one is what it answers. The Worker resolves the
  // workspace from the caller's own membership.
  let response: Response;
  try {
    response = await fetch(`${API}/session`);
  } catch {
    throw new ApiError('Mất kết nối. Kiểm tra mạng rồi thử lại.', 0);
  }
  if (!response.ok) {
    throw new ApiError(await readErrorMessage(response), response.status);
  }
  const parsed = await readJsonBody<{ session: Session }>(response);
  if (!parsed.ok) {
    throw new ApiError(parsed.message, response.status);
  }
  if (parsed.value.session.workspaceId.trim() !== '') {
    lastKnownWorkspaceId = parsed.value.session.workspaceId;
  }
  return parsed.value.session;
}

export function fetchProducts(
  workspaceId: string,
): Promise<{ products: Product[] }> {
  return request<{ products: Product[] }>('/products', workspaceId);
}

export function fetchCustomers(
  workspaceId: string,
): Promise<{ customers: Customer[] }> {
  return request<{ customers: Customer[] }>('/customers', workspaceId);
}

export function fetchQuoteDrafts(
  workspaceId: string,
): Promise<{ drafts: QuoteDraft[] }> {
  return request<{ drafts: QuoteDraft[] }>('/quote-drafts', workspaceId);
}

export function saveQuoteDraft(
  workspaceId: string,
  input: QuoteDraftInput,
): Promise<{ draft: QuoteDraft }> {
  return request<{ draft: QuoteDraft }>(
    '/quote-drafts/save',
    workspaceId,
    mutationInit(input),
  );
}

// ---- B2B Floriculture Marketplace, Hub Consolidation & Escrow Ledger -------

export interface SupplyLotView {
  id: string;
  lot_code: string;
  nursery_workspace_id: string;
  nursery_name?: string;
  hamlet_area?: string;
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
  revision?: string;
  created_at?: string;
  updated_at?: string;
  fulfillment_score_bps?: number;
}

export type B2bLotView = SupplyLotView;

export interface VietQrPayloadView {
  bankBin: string;
  accountNumber: string;
  accountName: string;
  amountVnd: number;
  transferNote: string;
  emvPayload: string;
  crc16: string;
}

export interface EscrowLedgerEntryView {
  id: string;
  booking_id: string;
  entry_type: string;
  amount_vnd: number;
  vietqr_ref: string | null;
  note: string | null;
  created_at: string;
}

export interface B2bBookingView {
  id: string;
  booking_code: string;
  lot_id: string;
  lot_name?: string;
  lot_code?: string;
  nursery_workspace_id: string;
  nursery_name?: string;
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
  ledger_entries: EscrowLedgerEntryView[];
  deposit_vietqr?: VietQrPayloadView;
}

export interface ShipmentPackageView {
  id: string;
  trip_id: string;
  booking_id: string;
  booking_code?: string;
  buyer_shop_name?: string;
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
}

export interface HubDispatchTripView {
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
  packages: ShipmentPackageView[];
}

export interface PilotMetricsView {
  verifiedNurseriesCount: number;
  activeBuyerShopsCount: number;
  completedBookingsCount: number;
  retentionRateBps: number;
  isNurseryGoalMet: boolean;
  isBuyerGoalMet: boolean;
  isOrderVolumeGoalMet: boolean;
  isRetentionGoalMet: boolean;
  unbalancedSettledBookingsCount: number;
  totalPlatformOutlayVnd: number;
  isLedgerBalanced: boolean;
}

export async function fetchB2bLots(
  workspaceId: string,
  mode?: 'WEEKLY_CATALOG' | 'SEASONAL_PREORDER',
): Promise<{ lots: SupplyLotView[] }> {
  const path = mode
    ? `/b2b/lots?mode=${encodeURIComponent(mode)}`
    : '/b2b/lots';
  const result = await request<{ lots: SupplyLotView[] }>(path, workspaceId);
  notifyFetchedLots(result.lots);
  return result;
}

export function createB2bLot(
  workspaceId: string,
  input: {
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
    cut_or_ship_date: string;
  },
): Promise<{ lot: SupplyLotView }> {
  return request<{ lot: SupplyLotView }>(
    '/b2b/lots/create',
    workspaceId,
    mutationInit(input),
  );
}

export function fetchB2bBookings(
  workspaceId: string,
): Promise<{ bookings: B2bBookingView[] }> {
  return request<{ bookings: B2bBookingView[] }>('/b2b/bookings', workspaceId);
}

export function createB2bBooking(
  workspaceId: string,
  input: {
    lot_id: string;
    quantity: number;
    buyer_shop_name: string;
    buyer_contact_phone: string;
    destination_market: string;
    expected_revision?: string | null;
    note?: string | null;
  },
): Promise<{ booking: B2bBookingView; deposit_vietqr: VietQrPayloadView }> {
  return request<{ booking: B2bBookingView; deposit_vietqr: VietQrPayloadView }>(
    '/b2b/bookings/create',
    workspaceId,
    mutationInit(input),
  );
}

export function confirmB2bDeposit(
  workspaceId: string,
  input: { booking_id: string; vietqr_ref?: string },
): Promise<{ booking: B2bBookingView }> {
  return request<{ booking: B2bBookingView }>(
    '/b2b/bookings/confirm-deposit',
    workspaceId,
    mutationInit(input),
  );
}

export function fetchHubTrips(
  workspaceId: string,
): Promise<{ trips: HubDispatchTripView[] }> {
  return request<{ trips: HubDispatchTripView[] }>('/b2b/hub-trips', workspaceId);
}

export function verifyHubPackageApi(
  workspaceId: string,
  input: {
    trip_id: string;
    booking_id: string;
    package_label: string;
    hub_note?: string;
  },
): Promise<{ package: ShipmentPackageView }> {
  return request<{ package: ShipmentPackageView }>(
    '/b2b/hub-packages/verify',
    workspaceId,
    mutationInit(input),
  );
}

export function inspectAndSettleBookingApi(
  workspaceId: string,
  input: {
    booking_id: string;
    accepted_units: number;
    defective_units: number;
    fault_party: 'NONE' | 'NURSERY';
    note?: string;
  },
): Promise<{
  booking: B2bBookingView;
  settlement: {
    acceptedUnits: number;
    defectiveUnits: number;
    faultParty: string;
    acceptedValueVnd: number;
    nurseryDeductionVnd: number;
    platformFeeRetainedVnd: number;
    buyerBalanceRequiredVnd: number;
    buyerRefundVnd: number;
    nurseryPayoutVnd: number;
    platformOutlayVnd: number;
    totalCollectedFromBuyerVnd: number;
  };
  balance_vietqr: VietQrPayloadView | null;
}> {
  return request(
    '/b2b/bookings/inspect-and-settle',
    workspaceId,
    mutationInit(input),
  );
}

export function fetchPilotDashboard(
  workspaceId: string,
): Promise<{ metrics: PilotMetricsView }> {
  return request<{ metrics: PilotMetricsView }>('/b2b/pilot-dashboard', workspaceId);
}
