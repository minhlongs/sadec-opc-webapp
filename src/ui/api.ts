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

// ---- Phase 2: Nursery Ops Full Workflow APIs -------------------------------

export interface QuoteRevisionView {
  id: string;
  chain_id: string;
  workspace_id: string;
  revision_number: number;
  status: 'draft' | 'issued' | 'accepted' | 'declined' | 'expired' | 'superseded';
  lines: Array<{
    product_id: string | null;
    product_name: string;
    spec: string | null;
    unit: string;
    unit_price_vnd: number | null;
    quantity: number | null;
    line_total_vnd: number | null;
    note: string | null;
  }>;
  subtotal_vnd: number;
  discount_vnd: number;
  fees_vnd: number;
  total_vnd: number;
  valid_until: string | null;
  conditions_note: string | null;
  issued_at: string | null;
  accepted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface QuoteChainView {
  id: string;
  workspace_id: string;
  customer_id: string;
  customer_name: string;
  reference: string;
  created_at: string;
  updated_at: string;
  revisions: QuoteRevisionView[];
}

export interface OrderView {
  id: string;
  workspace_id: string;
  quote_chain_id: string;
  accepted_revision_id: string;
  customer_id: string;
  customer_name?: string;
  order_code: string;
  total_vnd: number;
  deposit_required_vnd: number;
  pilot_credit_applied_vnd: number;
  collected_vnd: number;
  refund_owed_vnd: number;
  status: 'confirmed' | 'scheduled' | 'delivered' | 'completed' | 'cancelled';
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReceiptView {
  id: string;
  workspace_id: string;
  order_id: string;
  order_code?: string;
  amount_vnd: number;
  status: 'pending' | 'confirmed' | 'reversed';
  reference: string | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  reversal_reason: string | null;
  reversed_by: string | null;
  reversed_at: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeliveryView {
  id: string;
  workspace_id: string;
  order_id: string;
  order_code?: string;
  customer_name?: string;
  scheduled_date: string;
  status: 'scheduled' | 'in_transit' | 'delivered' | 'cancelled';
  delivery_address: string | null;
  under_deposit_override: number;
  override_reason: string | null;
  override_by: string | null;
  assigned_to: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface FollowUpTaskView {
  id: string;
  workspace_id: string;
  order_id: string | null;
  order_code?: string | null;
  customer_id: string;
  customer_name?: string;
  due_date: string;
  task_kind: 'quote_follow_up' | 'deposit_reminder' | 'delivery_confirm' | 'post_delivery_check';
  status: 'open' | 'done' | 'cancelled';
  assigned_to: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface TodaySummaryView {
  todayDate: string;
  draftQuotesCount: number;
  awaitingDepositOrders: OrderView[];
  deliveriesToday: DeliveryView[];
  openTasks: FollowUpTaskView[];
}

export function fetchTodaySummary(workspaceId: string): Promise<{ summary: TodaySummaryView }> {
  return request<{ summary: TodaySummaryView }>('/ops/today', workspaceId);
}

export function fetchQuoteChains(workspaceId: string): Promise<{ chains: QuoteChainView[] }> {
  return request<{ chains: QuoteChainView[] }>('/quote-chains', workspaceId);
}

export function createQuoteChainApi(
  workspaceId: string,
  input: {
    customer_id: string;
    reference: string;
    lines: Array<{
      product_id?: string | null;
      product_name?: string;
      spec?: string | null;
      unit?: string;
      unit_price_vnd?: number | null;
      quantity?: number | null;
      note?: string | null;
    }>;
    discount_vnd?: number;
    fees_vnd?: number;
    valid_until?: string | null;
    conditions_note?: string | null;
  },
): Promise<{ chain: QuoteChainView }> {
  return request<{ chain: QuoteChainView }>('/quote-chains/create', workspaceId, mutationInit(input));
}

export function issueQuoteRevisionApi(
  workspaceId: string,
  revisionId: string,
): Promise<{ revision: QuoteRevisionView }> {
  return request<{ revision: QuoteRevisionView }>(
    '/quote-revisions/issue',
    workspaceId,
    mutationInit({ revision_id: revisionId }),
  );
}

export function reviseIssuedQuoteApi(
  workspaceId: string,
  chainId: string,
): Promise<{ revision: QuoteRevisionView }> {
  return request<{ revision: QuoteRevisionView }>(
    '/quote-revisions/revise',
    workspaceId,
    mutationInit({ chain_id: chainId }),
  );
}

export function acceptQuoteRevisionApi(
  workspaceId: string,
  revisionId: string,
): Promise<{ revision: QuoteRevisionView; order: OrderView }> {
  return request<{ revision: QuoteRevisionView; order: OrderView }>(
    '/quote-revisions/accept',
    workspaceId,
    mutationInit({ revision_id: revisionId }),
  );
}

export function fetchOrders(workspaceId: string): Promise<{ orders: OrderView[] }> {
  return request<{ orders: OrderView[] }>('/orders', workspaceId);
}

export function fetchReceipts(workspaceId: string): Promise<{ receipts: ReceiptView[] }> {
  return request<{ receipts: ReceiptView[] }>('/receipts', workspaceId);
}

export function createReceiptApi(
  workspaceId: string,
  input: { order_id: string; amount_vnd: number; reference?: string; note?: string },
): Promise<{ receipt: ReceiptView }> {
  return request<{ receipt: ReceiptView }>('/receipts/create', workspaceId, mutationInit(input));
}

export function confirmReceiptApi(
  workspaceId: string,
  receiptId: string,
): Promise<{ receipt: ReceiptView; order: OrderView }> {
  return request<{ receipt: ReceiptView; order: OrderView }>(
    '/receipts/confirm',
    workspaceId,
    mutationInit({ receipt_id: receiptId }),
  );
}

export function reverseReceiptApi(
  workspaceId: string,
  receiptId: string,
  reason: string,
): Promise<{ receipt: ReceiptView; order: OrderView }> {
  return request<{ receipt: ReceiptView; order: OrderView }>(
    '/receipts/reverse',
    workspaceId,
    mutationInit({ receipt_id: receiptId, reason }),
  );
}

export function fetchDeliveries(workspaceId: string): Promise<{ deliveries: DeliveryView[] }> {
  return request<{ deliveries: DeliveryView[] }>('/deliveries', workspaceId);
}

export function createDeliveryApi(
  workspaceId: string,
  input: { order_id: string; scheduled_date: string; delivery_address?: string; assigned_to?: string; note?: string },
): Promise<{ delivery: DeliveryView }> {
  return request<{ delivery: DeliveryView }>('/deliveries/create', workspaceId, mutationInit(input));
}

export function overrideDeliveryApi(
  workspaceId: string,
  input: { order_id: string; scheduled_date: string; reason: string; delivery_address?: string; assigned_to?: string },
): Promise<{ delivery: DeliveryView }> {
  return request<{ delivery: DeliveryView }>('/deliveries/override', workspaceId, mutationInit(input));
}

export function updateDeliveryStatusApi(
  workspaceId: string,
  deliveryId: string,
  status: 'in_transit' | 'delivered' | 'cancelled',
): Promise<{ delivery: DeliveryView }> {
  return request<{ delivery: DeliveryView }>(
    '/deliveries/status',
    workspaceId,
    mutationInit({ delivery_id: deliveryId, status }),
  );
}

export function fetchFollowUpTasks(workspaceId: string): Promise<{ tasks: FollowUpTaskView[] }> {
  return request<{ tasks: FollowUpTaskView[] }>('/follow-up-tasks', workspaceId);
}

export function updateFollowUpTaskApi(
  workspaceId: string,
  taskId: string,
  status: 'open' | 'done' | 'cancelled',
): Promise<{ task: FollowUpTaskView }> {
  return request<{ task: FollowUpTaskView }>(
    '/follow-up-tasks/status',
    workspaceId,
    mutationInit({ task_id: taskId, status }),
  );
}

// ---- Phase 3: Founder Area APIs --------------------------------------------

export interface FounderInterviewView {
  id: string;
  external_id: string;
  organization_alias: string;
  respondent_role: string;
  interviewed_at: string;
  data_origin: 'synthetic' | 'real';
  notes: string | null;
  recorded_by: string;
  revision: number;
  created_at: string;
  updated_at: string;
}

export interface FounderObservationView {
  id: string;
  interview_id: string;
  metric_key: string;
  value_num: number | null;
  value_str: string | null;
  unit: string;
  period: string | null;
  evidence_kind: 'reported' | 'measured' | 'assumption';
  source_ref: string | null;
  is_null: number;
  revision: number;
  created_at: string;
}

export interface ConfigVersionView {
  id: string;
  scope: 'business_model' | 'workspace_operations';
  workspace_id: string | null;
  version_number: number;
  parameters_json: string;
  proposal_id: string | null;
  created_by: string;
  created_at: string;
}

export interface ChangeProposalView {
  id: string;
  scope: 'business_model' | 'workspace_operations';
  workspace_id: string | null;
  base_version_id: string | null;
  changes_json: string;
  evidence_ids_json: string;
  rationale: string;
  status: 'draft' | 'approved' | 'rejected' | 'applied';
  proposed_by: string;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScenarioResultView {
  activeCustomers: number;
  newSetupsInMonth: number;
  monthlyRevenueVnd: number;
  directCostVnd: number;
  fixedCostVnd: number;
  cashCostVnd: number;
  operatingProfitVnd: number;
  founderHoursUsed: number;
  founderTimeCostVnd: number;
  economicProfitVnd: number;
  remainingHours: number;
  capacityExhausted: boolean;
  minimumPilotPriceVnd: number;
  recommendedMonthlyRangeVnd: readonly [number, number];
}

export interface FounderEconomicsResponse {
  label: string;
  parameters: Record<string, number>;
  scenarios: ScenarioResultView[];
  custom_scenario: ScenarioResultView | null;
}

export interface OpcLedgerResponse {
  agreements: Array<{
    id: string;
    workspace_id: string;
    status: string;
    monthly_fee_vnd: number;
    setup_fee_vnd: number;
    effective_date: string;
  }>;
  obligations: Array<{
    id: string;
    agreement_id: string;
    workspace_id: string;
    obligation_kind: string;
    amount_vnd: number;
    due_date: string;
    status: string;
  }>;
  receipts: Array<{
    id: string;
    agreement_id: string;
    workspace_id: string;
    obligation_id: string | null;
    amount_vnd: number;
    fee_type: string;
    reference: string;
    status: string;
  }>;
  pilotCredits: Array<{
    id: string;
    workspace_id: string;
    pilot_receipt_id: string;
    credit_amount_vnd: number;
    applied_to_obligation_id: string | null;
  }>;
}

export function fetchFounderInterviews(workspaceId: string): Promise<{
  interviews: FounderInterviewView[];
  observations: FounderObservationView[];
}> {
  return request('/founder/interviews', workspaceId);
}

export function fetchFounderConfig(workspaceId: string): Promise<{
  active_version: ConfigVersionView | null;
  active_parameters: Record<string, number> | null;
  versions: ConfigVersionView[];
  proposals: ChangeProposalView[];
}> {
  return request('/founder/config', workspaceId);
}

export function createFounderProposalApi(
  workspaceId: string,
  input: {
    scope: 'business_model' | 'workspace_operations';
    base_version_id?: string | null;
    changes: Record<string, number>;
    evidence_ids: string[];
    rationale: string;
  },
): Promise<{ proposal: ChangeProposalView }> {
  return request('/founder/proposals/create', workspaceId, mutationInit(input));
}

export function applyFounderProposalApi(
  workspaceId: string,
  proposalId: string,
): Promise<{ proposal: ChangeProposalView; version: ConfigVersionView }> {
  return request(
    '/founder/proposals/apply',
    workspaceId,
    mutationInit({ proposal_id: proposalId }),
  );
}

export function rollbackFounderConfigApi(
  workspaceId: string,
  targetVersionId: string,
): Promise<{ version: ConfigVersionView }> {
  return request(
    '/founder/config/rollback',
    workspaceId,
    mutationInit({ scope: 'business_model', target_version_id: targetVersionId }),
  );
}

export function fetchFounderEconomics(
  workspaceId: string,
): Promise<FounderEconomicsResponse> {
  return request<FounderEconomicsResponse>('/founder/economics', workspaceId);
}

export function fetchFounderOpcLedger(
  workspaceId: string,
): Promise<OpcLedgerResponse> {
  return request<OpcLedgerResponse>('/founder/opc/ledger', workspaceId);
}

