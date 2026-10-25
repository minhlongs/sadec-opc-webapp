/**
 * Browser WebMCP Agent Bridge (`window.__SADEC_AGENT_BRIDGE__` & `navigator.modelContext`).
 *
 * Exposes four deterministic tools to in-browser AI agents:
 *  1. `listSupplyLots` — read live B2B floriculture supply lots with deterministic `revision`
 *  2. `quoteBooking` — compute exact integer VND deposit & platform fee breakdown
 *  3. `proposeBooking` — validate `expectedRevision` (Optimistic Concurrency Control) and
 *     stage a human-in-the-loop proposal on the Agent Proposal HUD
 *  4. `verifyQrToken` — verify HMAC-SHA256 `SDECQR.<payload>.<sig>` provenance tokens
 *
 * Invariant (Zero Auto-Spend): `proposeBooking` NEVER invokes `POST /api/b2b/bookings/create`
 * or any escrow mutation endpoint. It only stages a `BookingProposal` for human confirmation.
 */

import {
  calculateBookingQuote,
  type BookingQuoteResult,
} from '../domain/escrow-ledger.ts';
import {
  verifyLotQrToken,
  type LotQrClaims,
} from '../domain/lot-qr.ts';
import {
  SAMPLE_LOTS,
  buildAgentJsonSchemas,
  computeLotRevision,
  type PublicLotProjection,
} from '../domain/aeo-projection.ts';
import {
  fetchB2bLots,
  fetchSession,
  getLastFetchedLots,
  getLastKnownWorkspaceId,
  subscribeFetchedLots,
  type SupplyLotView,
} from './api.ts';

const DEFAULT_PLATFORM_FEE_BPS = 300;
const DEFAULT_BUYER_SHOP_NAME = 'Shop Hoa Sài Gòn';
const DEFAULT_BUYER_PHONE = '0909123456';
const DEFAULT_DESTINATION_MARKET = 'Chợ hoa Hồ Thị Kỷ, Quận 10';
const DEFAULT_LOT_TIMESTAMP = '2026-10-23T02:00:00.000Z';

export type LotSupplyMode = 'WEEKLY_CATALOG' | 'SEASONAL_PREORDER';

export interface B2bLotView extends SupplyLotView {
  revision: string;
}

export type BookingQuote = BookingQuoteResult;

export type QuoteBookingInput =
  | {
      lotId: string;
      quantity: number;
      unitPriceVnd?: number;
      depositRateBps?: number;
      platformFeeBps?: number;
    }
  | {
      lotId?: string;
      quantity: number;
      unitPriceVnd: number;
      depositRateBps?: number;
      platformFeeBps?: number;
    };

export interface BookingProposalInput {
  lotId: string;
  quantity: number;
  buyerShopName?: string;
  buyerContactPhone?: string;
  destinationMarket?: string;
  expectedRevision: string;
  note?: string;
}

export interface BookingProposal {
  id: string;
  proposalId: string;
  lotId: string;
  lotCode: string;
  lotName: string;
  nurseryName: string;
  unit: string;
  unitPriceVnd: number;
  depositRateBps: number;
  platformFeeBps: number;
  quantity: number;
  buyerShopName: string;
  buyerContactPhone: string;
  destinationMarket: string;
  expectedRevision: string;
  revision: string;
  note: string | null;
  quote: BookingQuote;
  grossTotalVnd: number;
  depositRequiredVnd: number;
  platformFeeVnd: number;
  estimatedBuyerTotalVnd: number;
  platformOutlayVnd: 0;
  requiresHumanClick: true;
  createdAt: string;
}

export type BookingProposalResult =
  | {
      status: 'STAGED_FOR_HUMAN_CONFIRMATION';
      requiresHumanClick: true;
      proposal: BookingProposal;
    }
  | {
      status: 'REJECTED';
      reason: string;
      currentRevision: string;
    };

export type ProposalListener = (proposal: BookingProposal | null) => void;

export interface WebMcpToolAnnotations {
  readOnlyHint?: boolean;
  untrustedContentHint?: boolean;
  consequentialHint?: boolean;
}

export interface WebMcpToolExecuteOptions {
  signal?: AbortSignal;
}

export interface WebMcpToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: WebMcpToolAnnotations;
  execute: (
    input: Record<string, unknown>,
    options?: WebMcpToolExecuteOptions,
  ) => Promise<unknown> | unknown;
}

export interface WebMcpRegisterOptions {
  exposedTo?: readonly string[];
  signal?: AbortSignal;
}

export interface WebMcpRegisteredTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  origin: string;
  annotations?: WebMcpToolAnnotations;
}

export interface ModelContext {
  registerTool(
    tool: WebMcpToolDefinition,
    options?: WebMcpRegisterOptions,
  ): Promise<void> | void;
  unregisterTool?(name: string): Promise<void> | void;
  getTools?(): Promise<readonly WebMcpRegisteredTool[]>;
  executeTool?(
    toolOrName: WebMcpRegisteredTool | string,
    input?: Record<string, unknown> | string,
    options?: WebMcpToolExecuteOptions,
  ): Promise<string>;
  provideContext?(context: Record<string, unknown>): void;
}

export interface SadecAgentBridge {
  listSupplyLots(
    filter?: { mode?: LotSupplyMode } | LotSupplyMode,
  ): Promise<readonly B2bLotView[]>;
  quoteBooking(input: QuoteBookingInput): BookingQuote;
  proposeBooking(input: BookingProposalInput): BookingProposalResult;
  verifyQrToken(input: { token: string } | string): Promise<LotQrClaims | null>;
  subscribeProposals(listener: ProposalListener): () => void;
  getStagedProposal(): BookingProposal | null;
  clearStagedProposal(): void;
  syncLots(lots: readonly SupplyLotView[]): readonly B2bLotView[];
  readonly tools: {
    listSupplyLots(
      filter?: { mode?: LotSupplyMode } | LotSupplyMode,
    ): Promise<readonly B2bLotView[]>;
    quoteBooking(input: QuoteBookingInput): BookingQuote;
    proposeBooking(input: BookingProposalInput): BookingProposalResult;
    verifyQrToken(input: { token: string } | string): Promise<LotQrClaims | null>;
  };
}

declare global {
  interface Window {
    __SADEC_AGENT_BRIDGE__?: SadecAgentBridge;
  }

  interface Navigator {
    modelContext?: ModelContext;
  }

  interface Document {
    modelContext?: ModelContext;
  }
}

const lotCacheById = new Map<string, B2bLotView>();
const proposalListeners = new Set<ProposalListener>();
let stagedProposal: BookingProposal | null = null;
let configuredWorkspaceId: string | null = null;
let bridgeInitialized = false;
let registeredToolNames = new Set<string>();

function toLotViewFromPublicProjection(lot: PublicLotProjection): B2bLotView {
  return {
    id: lot.id,
    lot_code: lot.lot_code,
    nursery_workspace_id: 'ws-public-catalog',
    nursery_name: lot.nursery_name,
    hamlet_area: lot.hamlet_area,
    name: lot.name,
    mode: lot.mode,
    species: lot.species,
    grade: lot.grade,
    pot_diameter_cm: lot.pot_diameter_cm,
    height_cm: lot.height_cm,
    canopy_cm: lot.canopy_cm,
    bud_specification: lot.bud_specification,
    media_proof_url: '',
    unit: lot.unit,
    unit_price_vnd: lot.unit_price_vnd,
    deposit_rate_bps: lot.deposit_rate_bps,
    moq_units: lot.moq_units,
    total_units: lot.total_units,
    available_units: lot.available_units,
    cut_or_ship_date: lot.cut_or_ship_date,
    qr_lot_token: '',
    status: lot.status,
    revision: lot.revision,
    fulfillment_score_bps: lot.fulfillment_score_bps,
  };
}

function ensureLotRevision(lot: SupplyLotView): B2bLotView {
  const revision =
    typeof lot.revision === 'string' && lot.revision.trim() !== ''
      ? lot.revision.trim()
      : computeLotRevision({
          id: lot.id,
          available_units: lot.available_units,
          status: lot.status,
          updated_at: lot.updated_at ?? DEFAULT_LOT_TIMESTAMP,
        });
  return {
    ...lot,
    revision,
  };
}

function seedFallbackLotsIfEmpty(): void {
  const fetched = getLastFetchedLots();
  if (fetched.length > 0) {
    for (const lot of fetched) {
      const normalized = ensureLotRevision(lot);
      lotCacheById.set(normalized.id, normalized);
    }
  }
  if (lotCacheById.size === 0) {
    for (const sample of SAMPLE_LOTS) {
      const view = toLotViewFromPublicProjection(sample);
      lotCacheById.set(view.id, view);
    }
  }
}

export function syncAgentBridgeLots(
  lots: readonly SupplyLotView[],
): readonly B2bLotView[] {
  const normalizedList: B2bLotView[] = [];
  for (const lot of lots) {
    const normalized = ensureLotRevision(lot);
    lotCacheById.set(normalized.id, normalized);
    normalizedList.push(normalized);
  }
  return normalizedList;
}

subscribeFetchedLots((lots) => {
  syncAgentBridgeLots(lots);
});

function notifyProposalListeners(proposal: BookingProposal | null): void {
  for (const listener of proposalListeners) {
    listener(proposal);
  }
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(
      new CustomEvent('sadec:agent-proposal', { detail: proposal }),
    );
  }
}

export function getStagedProposal(): BookingProposal | null {
  return stagedProposal;
}

export function clearStagedProposal(): void {
  stagedProposal = null;
  notifyProposalListeners(null);
}

export function subscribeProposals(listener: ProposalListener): () => void {
  proposalListeners.add(listener);
  return () => {
    proposalListeners.delete(listener);
  };
}

function resolveModeFilter(
  filter?: { mode?: LotSupplyMode } | LotSupplyMode,
): LotSupplyMode | undefined {
  if (filter === 'WEEKLY_CATALOG' || filter === 'SEASONAL_PREORDER') {
    return filter;
  }
  if (
    typeof filter === 'object' &&
    filter !== null &&
    (filter.mode === 'WEEKLY_CATALOG' || filter.mode === 'SEASONAL_PREORDER')
  ) {
    return filter.mode;
  }
  return undefined;
}

function filterCachedLots(mode?: LotSupplyMode): readonly B2bLotView[] {
  seedFallbackLotsIfEmpty();
  const all = Array.from(lotCacheById.values());
  if (!mode) {
    return all;
  }
  return all.filter((lot) => lot.mode === mode);
}

async function listSupplyLots(
  filter?: { mode?: LotSupplyMode } | LotSupplyMode,
): Promise<readonly B2bLotView[]> {
  const mode = resolveModeFilter(filter);
  let workspaceId = configuredWorkspaceId ?? getLastKnownWorkspaceId();

  if (!workspaceId && typeof fetch === 'function') {
    try {
      const session = await fetchSession();
      workspaceId = session.workspaceId;
      configuredWorkspaceId = session.workspaceId;
    } catch {
      workspaceId = null;
    }
  }

  if (workspaceId && typeof fetch === 'function') {
    try {
      const { lots } = await fetchB2bLots(workspaceId, mode);
      const normalized = syncAgentBridgeLots(lots);
      if (normalized.length > 0) {
        return normalized;
      }
    } catch {
      // Fall through to public catalog or cached state when offline or unauthenticated.
    }
  }

  if (typeof fetch === 'function') {
    try {
      const response = await fetch('/api/public/catalog');
      if (response.ok) {
        const body = (await response.json()) as {
          lots?: readonly PublicLotProjection[];
        };
        if (Array.isArray(body.lots) && body.lots.length > 0) {
          const mapped = body.lots.map((item) => toLotViewFromPublicProjection(item));
          for (const lot of mapped) {
            lotCacheById.set(lot.id, lot);
          }
          return mode ? mapped.filter((lot) => lot.mode === mode) : mapped;
        }
      }
    } catch {
      // Offline or test environment without global server; use cached lots.
    }
  }

  return filterCachedLots(mode);
}

function findCachedLot(lotId: string): B2bLotView | undefined {
  const trimmedId = lotId.trim();
  const existing = lotCacheById.get(trimmedId);
  if (existing) {
    return existing;
  }
  seedFallbackLotsIfEmpty();
  return lotCacheById.get(trimmedId);
}

function quoteBooking(input: QuoteBookingInput): BookingQuote {
  const platformFeeBps = input.platformFeeBps ?? DEFAULT_PLATFORM_FEE_BPS;

  if (
    typeof input.unitPriceVnd === 'number' &&
    typeof input.depositRateBps === 'number'
  ) {
    return calculateBookingQuote({
      quantity: input.quantity,
      unitPriceVnd: input.unitPriceVnd,
      depositRateBps: input.depositRateBps,
      platformFeeBps,
    });
  }

  if (!input.lotId || input.lotId.trim() === '') {
    throw new Error('Cần cung cấp lotId hoặc đơn giá xuất vườn để tính báo giá.');
  }

  const lot = findCachedLot(input.lotId);
  if (!lot) {
    throw new Error(
      `Không tìm thấy lô hoa kiểng "${input.lotId}". Vui lòng gọi listSupplyLots trước.`,
    );
  }

  return calculateBookingQuote({
    quantity: input.quantity,
    unitPriceVnd: input.unitPriceVnd ?? lot.unit_price_vnd,
    depositRateBps: input.depositRateBps ?? lot.deposit_rate_bps,
    platformFeeBps,
  });
}

function proposeBooking(input: BookingProposalInput): BookingProposalResult {
  const lotId = typeof input.lotId === 'string' ? input.lotId.trim() : '';
  const lot = findCachedLot(lotId);

  if (!lot) {
    return {
      status: 'REJECTED',
      reason: `Không tìm thấy lô hoa kiểng "${lotId}". Vui lòng tải lại danh mục qua listSupplyLots.`,
      currentRevision: '',
    };
  }

  const currentRevision = lot.revision;
  const expectedRevision =
    typeof input.expectedRevision === 'string' ? input.expectedRevision.trim() : '';

  if (expectedRevision === '' || expectedRevision !== currentRevision) {
    return {
      status: 'REJECTED',
      reason:
        'Dữ liệu lô hàng đã thay đổi (revision không khớp). Vui lòng tải lại danh mục trước khi đề xuất.',
      currentRevision,
    };
  }

  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    return {
      status: 'REJECTED',
      reason: 'Số lượng đặt giữ phải là số nguyên dương.',
      currentRevision,
    };
  }

  if (input.quantity < lot.moq_units) {
    return {
      status: 'REJECTED',
      reason: `Số lượng đặt giữ tối thiểu (MOQ) là ${lot.moq_units} ${lot.unit}.`,
      currentRevision,
    };
  }

  if (input.quantity > lot.available_units) {
    return {
      status: 'REJECTED',
      reason: `Số lượng còn lại không đủ (còn ${lot.available_units} ${lot.unit}).`,
      currentRevision,
    };
  }

  const quote = calculateBookingQuote({
    quantity: input.quantity,
    unitPriceVnd: lot.unit_price_vnd,
    depositRateBps: lot.deposit_rate_bps,
    platformFeeBps: DEFAULT_PLATFORM_FEE_BPS,
  });

  const buyerShopName =
    typeof input.buyerShopName === 'string' && input.buyerShopName.trim() !== ''
      ? input.buyerShopName.trim()
      : DEFAULT_BUYER_SHOP_NAME;

  const buyerContactPhone =
    typeof input.buyerContactPhone === 'string' && input.buyerContactPhone.trim() !== ''
      ? input.buyerContactPhone.trim()
      : DEFAULT_BUYER_PHONE;

  const destinationMarket =
    typeof input.destinationMarket === 'string' && input.destinationMarket.trim() !== ''
      ? input.destinationMarket.trim()
      : DEFAULT_DESTINATION_MARKET;

  const note =
    typeof input.note === 'string' && input.note.trim() !== ''
      ? input.note.trim()
      : null;

  const proposalId = `prop-${lot.id}-${Date.now().toString(36)}`;
  const proposal: BookingProposal = {
    id: proposalId,
    proposalId,
    lotId: lot.id,
    lotCode: lot.lot_code,
    lotName: lot.name,
    nurseryName: lot.nursery_name ?? 'Nhà vườn Sa Đéc',
    unit: lot.unit,
    unitPriceVnd: lot.unit_price_vnd,
    depositRateBps: lot.deposit_rate_bps,
    platformFeeBps: DEFAULT_PLATFORM_FEE_BPS,
    quantity: input.quantity,
    buyerShopName,
    buyerContactPhone,
    destinationMarket,
    expectedRevision: currentRevision,
    revision: currentRevision,
    note,
    quote,
    grossTotalVnd: quote.grossTotalVnd,
    depositRequiredVnd: quote.depositRequiredVnd,
    platformFeeVnd: quote.platformFeeVnd,
    estimatedBuyerTotalVnd: quote.estimatedBuyerTotalVnd,
    platformOutlayVnd: 0,
    requiresHumanClick: true,
    createdAt: new Date().toISOString(),
  };

  stagedProposal = proposal;
  notifyProposalListeners(proposal);

  return {
    status: 'STAGED_FOR_HUMAN_CONFIRMATION',
    requiresHumanClick: true,
    proposal,
  };
}

async function verifyQrToken(
  input: { token: string } | string,
): Promise<LotQrClaims | null> {
  const rawToken =
    typeof input === 'string'
      ? input
      : typeof input === 'object' && input !== null && typeof input.token === 'string'
        ? input.token
        : '';
  if (rawToken.trim() === '') {
    return null;
  }
  return verifyLotQrToken(rawToken);
}

const agentBridge: SadecAgentBridge = {
  listSupplyLots,
  quoteBooking,
  proposeBooking,
  verifyQrToken,
  subscribeProposals,
  getStagedProposal,
  clearStagedProposal,
  syncLots: syncAgentBridgeLots,
  tools: {
    listSupplyLots,
    quoteBooking,
    proposeBooking,
    verifyQrToken,
  },
};

function createModelContextShim(): ModelContext {
  const toolRegistry = new Map<string, WebMcpToolDefinition>();

  return {
    async registerTool(
      tool: WebMcpToolDefinition,
      options?: WebMcpRegisterOptions,
    ): Promise<void> {
      if (!tool.name || tool.name.trim() === '') {
        throw new DOMException('Tool name is required.', 'InvalidStateError');
      }
      toolRegistry.set(tool.name, tool);
      if (options?.signal) {
        options.signal.addEventListener(
          'abort',
          () => {
            toolRegistry.delete(tool.name);
            registeredToolNames.delete(tool.name);
          },
          { once: true },
        );
      }
    },
    async unregisterTool(name: string): Promise<void> {
      toolRegistry.delete(name);
      registeredToolNames.delete(name);
    },
    async getTools(): Promise<readonly WebMcpRegisteredTool[]> {
      const origin =
        typeof window !== 'undefined' && window.location
          ? window.location.origin
          : 'https://sadec-flow.local';
      return Array.from(toolRegistry.values()).map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        origin,
        annotations: tool.annotations,
      }));
    },
    async executeTool(
      toolOrName: WebMcpRegisteredTool | string,
      input: Record<string, unknown> | string = {},
      options?: WebMcpToolExecuteOptions,
    ): Promise<string> {
      const name = typeof toolOrName === 'string' ? toolOrName : toolOrName.name;
      const tool = toolRegistry.get(name);
      if (!tool) {
        return JSON.stringify({ error: `Unknown WebMCP tool: ${name}` });
      }
      let parsedInput: Record<string, unknown> = {};
      if (typeof input === 'string') {
        try {
          parsedInput = JSON.parse(input) as Record<string, unknown>;
        } catch {
          return JSON.stringify({ error: 'Invalid JSON input payload.' });
        }
      } else if (typeof input === 'object' && input !== null) {
        parsedInput = input;
      }

      try {
        const output = await tool.execute(parsedInput, options);
        return typeof output === 'string' ? output : JSON.stringify(output);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Tool execution error';
        return JSON.stringify({ error: message });
      }
    },
    provideContext(): void {
      // Context metadata stored by shim for legacy WebMCP callers.
    },
  };
}

function buildWebMcpToolDefinitions(): readonly WebMcpToolDefinition[] {
  const schemas = buildAgentJsonSchemas();

  const asSchemaObject = (key: string): Record<string, unknown> => {
    const candidate = schemas[key];
    if (typeof candidate === 'object' && candidate !== null) {
      return candidate as Record<string, unknown>;
    }
    return { type: 'object' };
  };

  return [
    {
      name: 'listSupplyLots',
      title: 'Danh mục lô hoa kiểng sỉ Sa Đéc',
      description:
        'Liệt kê danh sách các lô hoa kiểng sỉ đang mở bán kèm mã revision chống đặt trùng và báo giá mẫu.',
      inputSchema: asSchemaObject('listSupplyLots'),
      annotations: {
        readOnlyHint: true,
        untrustedContentHint: false,
        consequentialHint: false,
      },
      execute: async (rawInput) => {
        const mode =
          rawInput.mode === 'WEEKLY_CATALOG' || rawInput.mode === 'SEASONAL_PREORDER'
            ? rawInput.mode
            : undefined;
        return listSupplyLots(mode ? { mode } : undefined);
      },
    },
    {
      name: 'quoteBooking',
      title: 'Tính báo giá đặt cọc & phí sàn (VND)',
      description:
        'Tính toán chính xác tiền cọc VietQR (30-50%) và phí nền tảng (2-5%) bằng số nguyên VND.',
      inputSchema: asSchemaObject('quoteBooking'),
      annotations: {
        readOnlyHint: true,
        untrustedContentHint: false,
        consequentialHint: false,
      },
      execute: (rawInput) => {
        const lotId = typeof rawInput.lotId === 'string' ? rawInput.lotId : undefined;
        const quantity = Number(rawInput.quantity ?? 0);
        const unitPriceVnd =
          typeof rawInput.unitPriceVnd === 'number' ? rawInput.unitPriceVnd : undefined;
        const depositRateBps =
          typeof rawInput.depositRateBps === 'number'
            ? rawInput.depositRateBps
            : undefined;
        const platformFeeBps =
          typeof rawInput.platformFeeBps === 'number'
            ? rawInput.platformFeeBps
            : undefined;
        if (lotId !== undefined) {
          return quoteBooking({
            lotId,
            quantity,
            unitPriceVnd,
            depositRateBps,
            platformFeeBps,
          });
        }
        return quoteBooking({
          quantity,
          unitPriceVnd: unitPriceVnd ?? 0,
          depositRateBps,
          platformFeeBps,
        });
      },
    },
    {
      name: 'proposeBooking',
      title: 'Đề xuất đặt giữ lô hoa (Chờ người dùng duyệt)',
      description:
        'Kiểm tra expectedRevision và tạo đề xuất đặt giữ trên Agent Proposal HUD để người dùng bấm xác nhận (Zero Auto-Spend).',
      inputSchema: asSchemaObject('proposeBooking'),
      annotations: {
        readOnlyHint: false,
        untrustedContentHint: false,
        consequentialHint: true,
      },
      execute: (rawInput) => {
        return proposeBooking({
          lotId: String(rawInput.lotId ?? ''),
          quantity: Number(rawInput.quantity ?? 0),
          expectedRevision: String(rawInput.expectedRevision ?? ''),
          buyerShopName:
            typeof rawInput.buyerShopName === 'string'
              ? rawInput.buyerShopName
              : undefined,
          buyerContactPhone:
            typeof rawInput.buyerContactPhone === 'string'
              ? rawInput.buyerContactPhone
              : undefined,
          destinationMarket:
            typeof rawInput.destinationMarket === 'string'
              ? rawInput.destinationMarket
              : undefined,
          note: typeof rawInput.note === 'string' ? rawInput.note : undefined,
        });
      },
    },
    {
      name: 'verifyQrToken',
      title: 'Xác thực chữ ký số QR Lô/Kiện hàng',
      description:
        'Kiểm tra chữ ký HMAC-SHA256 của mã QR SDECQR gắn trên lô hoa tại vườn hoặc kiện hàng tại Hub Sa Đéc.',
      inputSchema: asSchemaObject('verifyQrToken'),
      annotations: {
        readOnlyHint: true,
        untrustedContentHint: false,
        consequentialHint: false,
      },
      execute: async (rawInput) => {
        const token = typeof rawInput.token === 'string' ? rawInput.token : '';
        return verifyQrToken({ token });
      },
    },
  ];
}

function registerToolsOnContext(ctx: ModelContext): void {
  if (typeof ctx.registerTool !== 'function') {
    return;
  }
  const definitions = buildWebMcpToolDefinitions();
  for (const tool of definitions) {
    if (registeredToolNames.has(tool.name)) {
      continue;
    }
    registeredToolNames.add(tool.name);
    try {
      const maybePromise = ctx.registerTool(tool);
      if (maybePromise instanceof Promise) {
        void maybePromise.catch(() => {
          // Ignore duplicate registration errors on native browser ModelContext.
        });
      }
    } catch {
      // Ignore synchronous registration errors in restricted contexts.
    }
  }
}

/**
 * Idempotently initializes `window.__SADEC_AGENT_BRIDGE__` and registers the 4
 * WebMCP tools on `navigator.modelContext` (installing a typed shim if absent).
 */
export function initAgentBridge(workspaceId?: string): SadecAgentBridge {
  if (typeof workspaceId === 'string' && workspaceId.trim() !== '') {
    configuredWorkspaceId = workspaceId.trim();
  }

  seedFallbackLotsIfEmpty();

  if (typeof window !== 'undefined') {
    window.__SADEC_AGENT_BRIDGE__ = agentBridge;
  }

  if (typeof navigator !== 'undefined') {
    if (!navigator.modelContext) {
      try {
        Object.defineProperty(navigator, 'modelContext', {
          value: createModelContextShim(),
          configurable: true,
          writable: true,
        });
      } catch {
        (navigator as Navigator).modelContext = createModelContextShim();
      }
    }
    if (navigator.modelContext) {
      registerToolsOnContext(navigator.modelContext);
    }
  }

  if (typeof document !== 'undefined' && navigator?.modelContext && !document.modelContext) {
    try {
      Object.defineProperty(document, 'modelContext', {
        value: navigator.modelContext,
        configurable: true,
        writable: true,
      });
    } catch {
      // Ignore if document.modelContext is not configurable.
    }
  }

  bridgeInitialized = true;
  return agentBridge;
}

export function isAgentBridgeInitialized(): boolean {
  return bridgeInitialized;
}

if (typeof window !== 'undefined') {
  initAgentBridge();
}
