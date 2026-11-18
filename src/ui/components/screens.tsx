/**
 * The one flow phase 1 ships: read the catalog, compose a quote draft against
 * it, save it, and see it come back priced by the server.
 *
 * The line total shown while composing is a preview and is labelled as one. The
 * subtotal that counts is the one the save returns, because the server prices
 * every line from the catalog rather than from this form — a client total is
 * never trusted, even a correct-looking one.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  acceptQuoteRevisionApi,
  confirmReceiptApi,
  createCustomerApi,
  createProductApi,
  createReceiptApi,
  fetchCustomers,
  fetchDeliveries,
  fetchFollowUpTasks,
  fetchOrders,
  fetchProducts,
  fetchQuoteChains,
  fetchQuoteDrafts,
  fetchReceipts,
  fetchTodaySummary,
  issueQuoteRevisionApi,
  newIdempotencyKey,
  reviseIssuedQuoteApi,
  saveQuoteDraft,
  updateCustomerApi,
  updateFollowUpTaskApi,
  updateProductApi,
  voidReceiptApi,
  type Customer,
  type DeliveryView,
  type FollowUpTaskView,
  type OrderView,
  type Product,
  type QuoteChainView,
  type QuoteDraft,
  type ReceiptView,
  type Role,
  type TodaySummaryView,
} from '../api.ts';
import { formatTimestamp, formatVnd, formatVndWithUnit } from '../format.ts';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  SuccessState,
} from './states.tsx';

interface ComposedLine {
  productId: string;
  quantity: number;
}

/** The ceiling `quoteLineSchema` enforces server-side; a fraction is refused, not rounded. */
const MAX_QUANTITY = 100000;

export interface OpsScreenProps {
  workspaceId: string;
  role?: Role;
}

function foldVietnameseSearch(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase();
}

/**
 * Loads a list for the screen, keeping the failure rather than clearing it.
 *
 * A failed load leaves whatever was on screen alone: §5 requires a form not to
 * be wiped because an API call failed, and the same reasoning applies to a list
 * an operator is reading while walking through wifi dead spots.
 */
function useWorkspaceData(workspaceId: string) {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [customers, setCustomers] = useState<Customer[] | null>(null);
  const [drafts, setDrafts] = useState<QuoteDraft[] | null>(null);
  const [todaySummary, setTodaySummary] = useState<TodaySummaryView | null>(null);
  const [quoteChains, setQuoteChains] = useState<QuoteChainView[]>([]);
  const [orders, setOrders] = useState<OrderView[]>([]);
  const [receipts, setReceipts] = useState<ReceiptView[]>([]);
  const [deliveries, setDeliveries] = useState<DeliveryView[]>([]);
  const [tasks, setTasks] = useState<FollowUpTaskView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [productPage, customerPage, draftPage] = await Promise.all([
        fetchProducts(workspaceId),
        fetchCustomers(workspaceId),
        fetchQuoteDrafts(workspaceId),
      ]);
      setProducts(productPage.products);
      setCustomers(customerPage.customers);
      setDrafts(draftPage.drafts);

      // Load Phase 2 extended operational lists in parallel without blocking catalog/drafts
      const [todayRes, chainsRes, ordersRes, receiptsRes, deliveriesRes, tasksRes] =
        await Promise.allSettled([
          fetchTodaySummary(workspaceId),
          fetchQuoteChains(workspaceId),
          fetchOrders(workspaceId),
          fetchReceipts(workspaceId),
          fetchDeliveries(workspaceId),
          fetchFollowUpTasks(workspaceId),
        ]);
      if (todayRes.status === 'fulfilled') setTodaySummary(todayRes.value.summary);
      if (chainsRes.status === 'fulfilled') setQuoteChains(chainsRes.value.chains);
      if (ordersRes.status === 'fulfilled') setOrders(ordersRes.value.orders);
      if (receiptsRes.status === 'fulfilled') setReceipts(receiptsRes.value.receipts);
      if (deliveriesRes.status === 'fulfilled') setDeliveries(deliveriesRes.value.deliveries);
      if (tasksRes.status === 'fulfilled') setTasks(tasksRes.value.tasks);
    } catch (thrown) {
      // The message is the server's Vietnamese prose, which §5 asks for: an
      // error that says what to check rather than a status code.
      setError(thrown instanceof Error ? thrown.message : 'Không tải được dữ liệu.');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return {
    products,
    customers,
    drafts,
    todaySummary,
    quoteChains,
    orders,
    receipts,
    deliveries,
    tasks,
    error,
    loading,
    reload,
  };
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case 'accepted':
    case 'confirmed':
    case 'deposit_confirmed':
    case 'delivered':
    case 'completed':
    case 'done':
    case 'paid':
    case 'active':
      return 'badge badge--success';
    case 'issued':
    case 'processing':
    case 'scheduled':
    case 'in_transit':
    case 'open':
      return 'badge badge--info';
    case 'pending':
    case 'pending_deposit':
    case 'awaiting_deposit':
    case 'draft':
      return 'badge badge--warning';
    case 'reversed':
    case 'voided':
    case 'cancelled':
    case 'overdue':
    case 'superseded':
      return 'badge badge--danger';
    default:
      return 'badge';
  }
}

export function OpsScreen({ workspaceId, role = 'workspace_operator' }: OpsScreenProps) {
  const {
    products,
    customers,
    drafts,
    todaySummary,
    quoteChains,
    orders,
    receipts,
    deliveries,
    tasks,
    error,
    loading,
    reload,
  } = useWorkspaceData(workspaceId);
  const canWriteProducts = role === 'founder_admin' || role === 'workspace_owner';
  const canConfirmReceipts = role === 'founder_admin' || role === 'workspace_owner';

  const [opsNotice, setOpsNotice] = useState<string | null>(null);
  const [opsActionError, setOpsActionError] = useState<string | null>(null);
  const [productSearch, setProductSearch] = useState('');
  const [searchedProducts, setSearchedProducts] = useState<Product[] | null>(null);
  const [customerSearch, setCustomerSearch] = useState('');
  const [searchedCustomers, setSearchedCustomers] = useState<Customer[] | null>(null);

  const [productForm, setProductForm] = useState<{
    mode: 'create' | 'edit';
    productId: string;
    expectedUpdatedAt: string;
    name: string;
    species: string;
    sizeClass: string;
    grade: string;
    priceVnd: string;
    unit: string;
    stockNote: string;
  } | null>(null);
  const [productFormError, setProductFormError] = useState<string | null>(null);

  const [customerForm, setCustomerForm] = useState<{
    mode: 'create' | 'edit';
    customerId: string;
    expectedUpdatedAt: string;
    name: string;
    contactName: string;
    phone: string;
    address: string;
    note: string;
  } | null>(null);
  const [customerFormError, setCustomerFormError] = useState<string | null>(null);

  const [receiptFormOpen, setReceiptFormOpen] = useState(false);
  const [receiptFormOrderId, setReceiptFormOrderId] = useState('');
  const [receiptFormAmount, setReceiptFormAmount] = useState('');
  const [receiptFormRef, setReceiptFormRef] = useState('');
  const [receiptFormNote, setReceiptFormNote] = useState('');
  const [receiptFormError, setReceiptFormError] = useState<string | null>(null);

  const [voidingReceiptId, setVoidingReceiptId] = useState<string | null>(null);
  const [voidReasonDraft, setVoidReasonDraft] = useState('Hủy phiếu thu đang chờ xác nhận');

  useEffect(() => {
    const q = productSearch.trim();
    if (q === '') {
      setSearchedProducts(null);
      return;
    }
    let active = true;
    void fetchProducts(workspaceId, q)
      .then((res) => {
        if (active) setSearchedProducts(res.products);
      })
      .catch(() => {
        // Keep current list on transient offline error (§5).
      });
    return () => {
      active = false;
    };
  }, [workspaceId, productSearch, products]);

  useEffect(() => {
    const q = customerSearch.trim();
    if (q === '') {
      setSearchedCustomers(null);
      return;
    }
    let active = true;
    void fetchCustomers(workspaceId, q)
      .then((res) => {
        if (active) setSearchedCustomers(res.customers);
      })
      .catch(() => {
        // Keep current list on transient offline error (§5).
      });
    return () => {
      active = false;
    };
  }, [workspaceId, customerSearch, customers]);
  // The one write in flight, by intent. A second click while it is pending is
  // ignored rather than sent, so a double-click cannot issue two writes.
  const [busyAction, setBusyAction] = useState<string | null>(null);
  // The same fact as a ref, because two clicks in one event loop turn both read
  // the state before React re-renders; the ref is set synchronously.
  const busyRef = useRef<string | null>(null);
  // One idempotency key per intent (action + record), kept across retries of
  // that intent and dropped once the server has answered it. A retry after a
  // dropped connection therefore replays the same write instead of a second one.
  const intentKeys = useRef(new Map<string, string>());

  const runAction = useCallback(
    async (intent: string, perform: (idempotencyKey: string) => Promise<string>) => {
      if (busyRef.current !== null) return;
      busyRef.current = intent;
      setBusyAction(intent);
      setOpsActionError(null);
      setOpsNotice(null);
      const key = intentKeys.current.get(intent) ?? newIdempotencyKey();
      intentKeys.current.set(intent, key);
      try {
        const notice = await perform(key);
        intentKeys.current.delete(intent);
        setOpsNotice(notice);
        await reload();
      } catch (err) {
        setOpsActionError(err instanceof Error ? err.message : 'Không thực hiện được thao tác.');
        if (err instanceof ApiError && err.status !== 0 && err.status < 500) {
          // The server answered: the intent is settled (refused or stale), so
          // the next click is a new intent, and the lists are read again to
          // show the state the refusal was about.
          intentKeys.current.delete(intent);
          await reload();
        }
      } finally {
        busyRef.current = null;
        setBusyAction(null);
      }
    },
    [reload],
  );

  const [customerId, setCustomerId] = useState('');
  const [reference, setReference] = useState('');
  const [lines, setLines] = useState<ComposedLine[]>([{ productId: '', quantity: 1 }]);
  // What each quantity field shows while being typed, by line position. The
  // committed number in `lines` is what gets priced; this is only the edit in
  // progress, which is why it survives being empty and is dropped on blur.
  const [quantityDrafts, setQuantityDrafts] = useState<Record<number, string>>({});
  const [note, setNote] = useState('');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState<QuoteDraft | null>(null);
  const [saving, setSaving] = useState(false);

  const catalog = useMemo(() => {
    const byId = new Map<string, Product>();
    for (const product of products ?? []) byId.set(product.id, product);
    return byId;
  }, [products]);

  // A preview total, computed from the catalog rows the server sent. This is
  // display only: the value that is stored and charged is the subtotal the save
  // returns, because the server prices the lines itself.
  const previewTotal = useMemo(
    () =>
      lines.reduce((total, line) => {
        const product = catalog.get(line.productId);
        if (product === undefined) return total;
        return total + product.price_vnd * line.quantity;
      }, 0),
    [lines, catalog],
  );

  const linesWithProduct = lines.filter((line) => line.productId !== '');
  const completeLines = linesWithProduct.filter((line) => line.quantity > 0);
  // A line whose product was chosen but whose quantity is not one the schema
  // accepts blocks the save. Filtering it out instead would quietly drop the
  // line: the operator picks a product on line 2, the quantity field ends up
  // empty or zero, and the saved quote prices only the lines that survived —
  // with nothing on screen saying a line was left out.
  const everyLineUsable = linesWithProduct.every((line) => line.quantity > 0);
  const canSave =
    customerId !== '' &&
    reference.trim() !== '' &&
    completeLines.length > 0 &&
    everyLineUsable &&
    !saving;

  // A quantity the schema refuses is named, next to the reason the save is
  // blocked. The alternative is a silent revert: the operator types 1.5, the
  // field keeps showing 1.5, and what gets saved is 1 — a divergence nobody can
  // see. Every refusal the form makes has to be one the operator can read.
  //
  // The value read is the committed one, with the in-flight text taking priority
  // while a field is being edited. Committed is what gets submitted, so it is
  // what has to be judged: a line whose committed quantity is 0 is dropped from
  // the save by `completeLines`, and judging the draft instead would leave that
  // line silently absent from the priced quote with no hint saying why.
  const quantityHint = useMemo(() => {
    if (saving) return null;
    for (const [index, line] of lines.entries()) {
      if (line.productId === '') continue;
      const typed = quantityDrafts[index];
      // An edit in progress is what the operator sees, so it is what a message
      // about the field has to quote; a cleared field has not settled on a value
      // and is named as empty rather than as 0.
      const shown = typed !== undefined && typed.trim() !== '' ? typed.trim() : null;
      const value = shown === null ? line.quantity : Number(shown);
      if (Number.isInteger(value) && value > 0 && value <= MAX_QUANTITY) continue;
      if (!Number.isInteger(value)) {
        return `Số lượng ở dòng ${index + 1} phải là số nguyên, không phải ${shown}.`;
      }
      return `Số lượng ở dòng ${index + 1} phải lớn hơn 0 và không quá ${MAX_QUANTITY}.`;
    }
    return null;
  }, [lines, quantityDrafts, saving]);

  const updateLine = (index: number, patch: Partial<ComposedLine>) => {
    setLines((current) =>
      current.map((line, position) => (position === index ? { ...line, ...patch } : line)),
    );
  };

  const addLine = () => {
    setLines((current) => [...current, { productId: '', quantity: 1 }]);
  };

  const removeLine = (index: number) => {
    // Dropping a line shifts every later line up one position, so the drafts are
    // re-keyed with them. Left alone, line 2's half-typed quantity would jump to
    // line 1 and price a line the operator never touched.
    setQuantityDrafts((current) => {
      const shifted: Record<number, string> = {};
      for (const [position, text] of Object.entries(current)) {
        const from = Number(position);
        if (from < index) shifted[from] = text;
        else if (from > index) shifted[from - 1] = text;
      }
      return shifted;
    });
    setLines((current) =>
      current.length === 1
        ? [{ productId: '', quantity: 1 }]
        : current.filter((_, position) => position !== index),
    );
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canSave) return;

    setSaving(true);
    setSaveError(null);
    setSaved(null);

    try {
      const { draft } = await saveQuoteDraft(workspaceId, {
        customer_id: customerId,
        reference: reference.trim(),
        note: note.trim() === '' ? null : note.trim(),
        lines: completeLines.map((line) => ({
          product_id: line.productId,
          quantity: line.quantity,
          note: null,
        })),
      });

      setSaved(draft);
      await reload();
    } catch (thrown) {
      setSaveError(
        thrown instanceof Error ? thrown.message : 'Không lưu được báo giá.',
      );
    } finally {
      setSaving(false);
    }
  };

  const handleProductFormSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (productForm === null) return;
    const trimmedName = productForm.name.trim();
    const trimmedUnit = productForm.unit.trim();
    const rawPrice = productForm.priceVnd.trim();
    if (trimmedName === '') {
      setProductFormError('Vui lòng nhập tên mặt hàng.');
      return;
    }
    if (trimmedUnit === '') {
      setProductFormError('Vui lòng nhập đơn vị tính (ví dụ: chậu, bó, cây).');
      return;
    }
    if (rawPrice === '' || !/^\d+$/.test(rawPrice)) {
      setProductFormError(
        'Vui lòng nhập đơn giá hợp lệ (số nguyên ≥ 0, ví dụ 0 cho hàng mẫu/tặng).',
      );
      return;
    }
    const parsedPrice = Number(rawPrice);
    if (!Number.isSafeInteger(parsedPrice) || parsedPrice < 0) {
      setProductFormError('Đơn giá vượt giới hạn số nguyên an toàn.');
      return;
    }
    setProductFormError(null);
    const intent =
      productForm.mode === 'create'
        ? `create-product:${trimmedName}:${parsedPrice}`
        : `update-product:${productForm.productId}:${productForm.expectedUpdatedAt}`;
    if (busyRef.current !== null) return;
    busyRef.current = intent;
    setBusyAction(intent);
    setOpsActionError(null);
    setOpsNotice(null);
    const key = intentKeys.current.get(intent) ?? newIdempotencyKey();
    intentKeys.current.set(intent, key);
    try {
      const payload = {
        name: trimmedName,
        species: productForm.species.trim() || null,
        size_class: productForm.sizeClass.trim() || null,
        grade: productForm.grade.trim() || null,
        price_vnd: parsedPrice,
        unit: trimmedUnit,
        stock_note: productForm.stockNote.trim() || null,
      };
      if (productForm.mode === 'create') {
        await createProductApi(workspaceId, payload, key);
        setOpsNotice(`Đã thêm mặt hàng "${trimmedName}".`);
      } else {
        await updateProductApi(
          workspaceId,
          {
            ...payload,
            product_id: productForm.productId,
            expected_updated_at: productForm.expectedUpdatedAt,
          },
          key,
        );
        setOpsNotice(`Đã cập nhật mặt hàng "${trimmedName}".`);
      }
      intentKeys.current.delete(intent);
      setProductForm(null);
      await reload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Không lưu được mặt hàng.';
      setProductFormError(msg);
      if (err instanceof ApiError && err.status !== 0 && err.status < 500) {
        intentKeys.current.delete(intent);
        await reload();
      }
    } finally {
      busyRef.current = null;
      setBusyAction(null);
    }
  };

  const handleCustomerFormSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (customerForm === null) return;
    const trimmedName = customerForm.name.trim();
    if (trimmedName === '') {
      setCustomerFormError('Vui lòng nhập tên khách hàng.');
      return;
    }
    setCustomerFormError(null);
    const intent =
      customerForm.mode === 'create'
        ? `create-customer:${trimmedName}`
        : `update-customer:${customerForm.customerId}:${customerForm.expectedUpdatedAt}`;
    if (busyRef.current !== null) return;
    busyRef.current = intent;
    setBusyAction(intent);
    setOpsActionError(null);
    setOpsNotice(null);
    const key = intentKeys.current.get(intent) ?? newIdempotencyKey();
    intentKeys.current.set(intent, key);
    try {
      const payload = {
        name: trimmedName,
        contact_name: customerForm.contactName.trim() || null,
        phone: customerForm.phone.trim() || null,
        address: customerForm.address.trim() || null,
        note: customerForm.note.trim() || null,
      };
      if (customerForm.mode === 'create') {
        await createCustomerApi(workspaceId, payload, key);
        setOpsNotice(`Đã thêm khách hàng "${trimmedName}".`);
      } else {
        await updateCustomerApi(
          workspaceId,
          {
            ...payload,
            customer_id: customerForm.customerId,
            expected_updated_at: customerForm.expectedUpdatedAt,
          },
          key,
        );
        setOpsNotice(`Đã cập nhật khách hàng "${trimmedName}".`);
      }
      intentKeys.current.delete(intent);
      setCustomerForm(null);
      await reload();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Không lưu được khách hàng.';
      setCustomerFormError(msg);
      if (err instanceof ApiError && err.status !== 0 && err.status < 500) {
        intentKeys.current.delete(intent);
        await reload();
      }
    } finally {
      busyRef.current = null;
      setBusyAction(null);
    }
  };

  const handleReceiptFormSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (receiptFormOrderId === '') {
      setReceiptFormError('Vui lòng chọn đơn hàng cần ghi phiếu thu.');
      return;
    }
    const rawAmount = receiptFormAmount.trim();
    if (rawAmount === '' || !/^\d+$/.test(rawAmount)) {
      setReceiptFormError('Vui lòng nhập số tiền nguyên dương (đồng).');
      return;
    }
    const parsedAmount = Number(rawAmount);
    if (!Number.isSafeInteger(parsedAmount) || parsedAmount <= 0) {
      setReceiptFormError('Số tiền phiếu thu phải lớn hơn 0₫.');
      return;
    }
    setReceiptFormError(null);
    const intent = `create-receipt:${receiptFormOrderId}:${parsedAmount}:${receiptFormRef.trim()}`;
    if (busyRef.current !== null) return;
    busyRef.current = intent;
    setBusyAction(intent);
    setOpsActionError(null);
    setOpsNotice(null);
    const key = intentKeys.current.get(intent) ?? newIdempotencyKey();
    intentKeys.current.set(intent, key);
    try {
      await createReceiptApi(
        workspaceId,
        {
          order_id: receiptFormOrderId,
          amount_vnd: parsedAmount,
          ...(receiptFormRef.trim() !== '' ? { reference: receiptFormRef.trim() } : {}),
          ...(receiptFormNote.trim() !== '' ? { note: receiptFormNote.trim() } : {}),
        },
        key,
      );
      intentKeys.current.delete(intent);
      setReceiptFormOpen(false);
      setReceiptFormAmount('');
      setReceiptFormRef('');
      setReceiptFormNote('');
      setOpsNotice('Đã ghi phiếu thu chờ xác nhận.');
      await reload();
    } catch (err) {
      setReceiptFormError(err instanceof Error ? err.message : 'Không ghi được phiếu thu.');
      if (err instanceof ApiError && err.status !== 0 && err.status < 500) {
        intentKeys.current.delete(intent);
        await reload();
      }
    } finally {
      busyRef.current = null;
      setBusyAction(null);
    }
  };

  const displayedProducts = useMemo(() => {
    if (products === null) return [];
    const q = productSearch.trim();
    if (q === '') return products;
    if (searchedProducts !== null) return searchedProducts;
    const needle = foldVietnameseSearch(q);
    return products.filter(
      (product) =>
        foldVietnameseSearch(product.id).includes(needle) ||
        foldVietnameseSearch(product.name).includes(needle) ||
        foldVietnameseSearch(product.species ?? '').includes(needle) ||
        foldVietnameseSearch(product.size_class ?? '').includes(needle) ||
        foldVietnameseSearch(product.grade ?? '').includes(needle),
    );
  }, [products, productSearch, searchedProducts]);

  const displayedCustomers = useMemo(() => {
    if (customers === null) return [];
    const q = customerSearch.trim();
    if (q === '') return customers;
    if (searchedCustomers !== null) return searchedCustomers;
    const needle = foldVietnameseSearch(q);
    return customers.filter(
      (cust) =>
        foldVietnameseSearch(cust.id).includes(needle) ||
        foldVietnameseSearch(cust.name).includes(needle) ||
        foldVietnameseSearch(cust.contact_name ?? '').includes(needle) ||
        foldVietnameseSearch(cust.phone ?? '').includes(needle),
    );
  }, [customers, customerSearch, searchedCustomers]);

  if (loading && products === null) return <LoadingState />;
  if (error !== null && products === null) {
    return (
      <ErrorState title="Không tải được dữ liệu">
        <p>{error}</p>
        <button type="button" className="btn btn--secondary" onClick={() => void reload()}>
          Thử lại
        </button>
      </ErrorState>
    );
  }

  return (
    <div className="grid grid--two">
      <nav aria-label="Pipeline vận hành nhà vườn" className="stepper-bar">
        <span className="stepper-bar__title">Pipeline Vườn</span>
        <a className="stepper-bar__item" href="#ops-today">
          <span className="stepper-bar__step-num">1</span>
          Việc cần làm
        </a>
        <a className="stepper-bar__item" href="#ops-draft">
          <span className="stepper-bar__step-num">2</span>
          Soạn báo giá
        </a>
        <a className="stepper-bar__item" href="#ops-chains">
          <span className="stepper-bar__step-num">3</span>
          Chuỗi &amp; phiên bản
        </a>
        <a className="stepper-bar__item" href="#ops-orders">
          <span className="stepper-bar__step-num">4</span>
          Đơn hàng &amp; cọc
        </a>
        <a className="stepper-bar__item" href="#ops-deliveries">
          <span className="stepper-bar__step-num">5</span>
          Giao hàng
        </a>
        <a className="stepper-bar__item" href="#ops-catalog">
          <span className="stepper-bar__step-num">6</span>
          Danh mục hàng
        </a>
      </nav>

      <section className="panel span-full" id="ops-today" aria-labelledby="today-heading-anchor">
        <h2 className="panel__title" id="today-heading-anchor">
          Việc Cần Làm Hôm Nay ({todaySummary?.todayDate ?? '—'})
        </h2>
        {todaySummary === null ? (
          <p className="field__hint">Đang tải dữ liệu tổng hợp hôm nay…</p>
        ) : (
          <div className="bento-kpi-grid">
            <div className="bento-kpi-card">
              <span className="bento-kpi-card__label">Báo giá nháp</span>
              <span className="bento-kpi-card__value">{todaySummary.draftQuotesCount}</span>
            </div>
            <div className="bento-kpi-card">
              <span className="bento-kpi-card__label">Đơn chờ thu cọc</span>
              <span className="bento-kpi-card__value">
                {todaySummary.awaitingDepositOrders.length}
              </span>
            </div>
            <div className="bento-kpi-card" data-testid="today-deposits-to-confirm">
              <span className="bento-kpi-card__label">Phiếu thu chờ xác nhận</span>
              <span className="bento-kpi-card__value">{todaySummary.deposits_to_confirm}</span>
            </div>
            <div className="bento-kpi-card">
              <span className="bento-kpi-card__label">Chuyến giao hôm nay</span>
              <span className="bento-kpi-card__value">
                {todaySummary.deliveriesToday.length}
              </span>
            </div>
            <div className="bento-kpi-card">
              <span className="bento-kpi-card__label">Nhắc việc mở</span>
              <span className="bento-kpi-card__value">{todaySummary.openTasks.length}</span>
            </div>
            {todaySummary.awaitingDepositOrders.map((ord) => (
              <div className="bento-kpi-card" key={`await-${ord.id}`}>
                <span className="bento-kpi-card__label">Chờ cọc — {ord.order_code}</span>
                <span className="bento-kpi-card__value">{formatVndWithUnit(ord.total_vnd)}</span>
                <span className="bento-kpi-card__meta">
                  Còn thiếu {formatVndWithUnit(ord.deposit_required_vnd - ord.collected_vnd)}
                </span>
              </div>
            ))}
            {todaySummary.deliveriesToday.map((dlv) => (
              <div className="bento-kpi-card" key={`dlv-${dlv.id}`}>
                <span className="bento-kpi-card__label">Giao — {dlv.order_code ?? dlv.order_id}</span>
                <span className="bento-kpi-card__value">{dlv.scheduled_date}</span>
                <span className="bento-kpi-card__meta">{dlv.assigned_to ?? 'Chưa gán'}</span>
              </div>
            ))}
            {todaySummary.openTasks.map((tsk) => (
              <div className="bento-kpi-card" key={`task-${tsk.id}`}>
                <span className="bento-kpi-card__label">Nhắc việc — {tsk.customer_name ?? tsk.customer_id}</span>
                <span className="bento-kpi-card__value">{tsk.due_date}</span>
                <span className="bento-kpi-card__meta">{tsk.note ?? tsk.task_kind}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel" id="ops-catalog" aria-labelledby="catalog-heading">
        <div className="btn-row">
          <h2 className="panel__title" id="catalog-heading">
            Danh mục hàng
          </h2>
          {canWriteProducts && productForm === null && (
            <button
              type="button"
              className="btn btn--secondary btn--small"
              onClick={() => {
                setProductFormError(null);
                setProductForm({
                  mode: 'create',
                  productId: '',
                  expectedUpdatedAt: '',
                  name: '',
                  species: '',
                  sizeClass: '',
                  grade: '',
                  priceVnd: '',
                  unit: 'chậu',
                  stockNote: '',
                });
              }}
            >
              Thêm mặt hàng
            </button>
          )}
        </div>

        {canWriteProducts && productForm !== null && (
          <form onSubmit={(event) => void handleProductFormSubmit(event)} noValidate>
            <h3 className="section-subhead">
              {productForm.mode === 'create' ? 'Thêm mặt hàng mới' : `Sửa mặt hàng (${productForm.productId})`}
            </h3>
            <div className="field">
              <label className="field__label" htmlFor="product-form-name">
                Tên mặt hàng
              </label>
              <input
                id="product-form-name"
                type="text"
                value={productForm.name}
                onChange={(e) => setProductForm({ ...productForm, name: e.target.value })}
                maxLength={160}
                required
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="product-form-species">
                Giống / loài
              </label>
              <input
                id="product-form-species"
                type="text"
                value={productForm.species}
                onChange={(e) => setProductForm({ ...productForm, species: e.target.value })}
                maxLength={120}
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="product-form-size">
                Cỡ / quy cách
              </label>
              <input
                id="product-form-size"
                type="text"
                value={productForm.sizeClass}
                onChange={(e) => setProductForm({ ...productForm, sizeClass: e.target.value })}
                maxLength={80}
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="product-form-grade">
                Phân loại
              </label>
              <input
                id="product-form-grade"
                type="text"
                value={productForm.grade}
                onChange={(e) => setProductForm({ ...productForm, grade: e.target.value })}
                maxLength={40}
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="product-form-price">
                Đơn giá (đồng, nhập 0 cho hàng mẫu/tặng)
              </label>
              <input
                id="product-form-price"
                type="text"
                inputMode="numeric"
                value={productForm.priceVnd}
                onChange={(e) => setProductForm({ ...productForm, priceVnd: e.target.value })}
                placeholder="Ví dụ: 45000 hoặc 0"
                maxLength={15}
                required
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="product-form-unit">
                Đơn vị tính
              </label>
              <input
                id="product-form-unit"
                type="text"
                value={productForm.unit}
                onChange={(e) => setProductForm({ ...productForm, unit: e.target.value })}
                maxLength={40}
                required
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="product-form-stock">
                Ghi chú tồn vườn
              </label>
              <input
                id="product-form-stock"
                type="text"
                value={productForm.stockNote}
                onChange={(e) => setProductForm({ ...productForm, stockNote: e.target.value })}
                maxLength={240}
              />
            </div>
            {productFormError !== null && (
              <p className="field__error" role="alert">
                {productFormError}
              </p>
            )}
            <div className="btn-row">
              <button type="submit" className="btn btn--small" disabled={busyAction !== null}>
                {productForm.mode === 'create' ? 'Lưu mặt hàng' : 'Cập nhật mặt hàng'}
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--small"
                onClick={() => {
                  setProductForm(null);
                  setProductFormError(null);
                }}
              >
                Hủy
              </button>
            </div>
          </form>
        )}

        {products !== null && products.length > 0 && (
          <div className="field">
            <label className="field__label" htmlFor="catalog-search">
              Tìm mặt hàng
            </label>
            <div className="btn-row">
              <input
                id="catalog-search"
                type="search"
                value={productSearch}
                onChange={(event) => setProductSearch(event.target.value)}
                placeholder="Mã, tên cây, giống, cỡ hoặc phân loại…"
                maxLength={120}
              />
              {productSearch !== '' && (
                <button
                  type="button"
                  className="btn btn--ghost btn--small"
                  onClick={() => setProductSearch('')}
                >
                  Xóa tìm
                </button>
              )}
            </div>
          </div>
        )}
        {products === null || products.length === 0 ? (
          <EmptyState title="Chưa có mặt hàng nào" />
        ) : displayedProducts.length === 0 ? (
          <p className="field__hint" role="status">
            Không tìm thấy mặt hàng khớp từ khóa.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">
                Mặt hàng đang bán trong workspace này, kèm đơn giá theo đồng.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Mặt hàng</th>
                  <th scope="col">Cỡ</th>
                  <th scope="col">Loại</th>
                  <th scope="col" className="num">
                    Đơn giá
                  </th>
                  {canWriteProducts && <th scope="col">Thao tác</th>}
                </tr>
              </thead>
              <tbody>
                {displayedProducts.map((product) => (
                  <tr key={product.id}>
                    <td>
                      {product.name}
                      <div className="field__hint">
                        {product.id} · {product.unit}
                      </div>
                    </td>
                    <td>
                      {product.size_class === null ? (
                        <span className="field__hint">Chưa nhập</span>
                      ) : (
                        product.size_class
                      )}
                    </td>
                    <td>
                      {product.grade === null ? (
                        <span className="field__hint">Chưa nhập</span>
                      ) : (
                        product.grade
                      )}
                    </td>
                    <td className="num money">{formatVndWithUnit(product.price_vnd)}</td>
                    {canWriteProducts && (
                      <td>
                        <button
                          type="button"
                          className="btn btn--ghost btn--small"
                          onClick={() => {
                            setProductFormError(null);
                            setProductForm({
                              mode: 'edit',
                              productId: product.id,
                              expectedUpdatedAt: product.updated_at ?? '',
                              name: product.name,
                              species: product.species ?? '',
                              sizeClass: product.size_class ?? '',
                              grade: product.grade ?? '',
                              priceVnd: String(product.price_vnd),
                              unit: product.unit,
                              stockNote: product.stock_note ?? '',
                            });
                          }}
                        >
                          Sửa
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel" id="ops-customers" aria-labelledby="customers-heading">
        <div className="btn-row">
          <h2 className="panel__title" id="customers-heading">
            Danh bạ khách hàng
          </h2>
          {customerForm === null && (
            <button
              type="button"
              className="btn btn--secondary btn--small"
              onClick={() => {
                setCustomerFormError(null);
                setCustomerForm({
                  mode: 'create',
                  customerId: '',
                  expectedUpdatedAt: '',
                  name: '',
                  contactName: '',
                  phone: '',
                  address: '',
                  note: '',
                });
              }}
            >
              Thêm khách
            </button>
          )}
        </div>

        {customerForm !== null && (
          <form onSubmit={(event) => void handleCustomerFormSubmit(event)} noValidate>
            <h3 className="section-subhead">
              {customerForm.mode === 'create'
                ? 'Thêm khách hàng mới'
                : `Sửa khách hàng (${customerForm.customerId})`}
            </h3>
            <div className="field">
              <label className="field__label" htmlFor="customer-form-name">
                Tên khách / đơn vị
              </label>
              <input
                id="customer-form-name"
                type="text"
                value={customerForm.name}
                onChange={(e) => setCustomerForm({ ...customerForm, name: e.target.value })}
                maxLength={160}
                required
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="customer-form-contact">
                Người liên hệ
              </label>
              <input
                id="customer-form-contact"
                type="text"
                value={customerForm.contactName}
                onChange={(e) => setCustomerForm({ ...customerForm, contactName: e.target.value })}
                maxLength={120}
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="customer-form-phone">
                Số điện thoại
              </label>
              <input
                id="customer-form-phone"
                type="tel"
                value={customerForm.phone}
                onChange={(e) => setCustomerForm({ ...customerForm, phone: e.target.value })}
                maxLength={40}
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="customer-form-address">
                Địa chỉ giao nhận
              </label>
              <input
                id="customer-form-address"
                type="text"
                value={customerForm.address}
                onChange={(e) => setCustomerForm({ ...customerForm, address: e.target.value })}
                maxLength={240}
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="customer-form-note">
                Ghi chú khách hàng
              </label>
              <input
                id="customer-form-note"
                type="text"
                value={customerForm.note}
                onChange={(e) => setCustomerForm({ ...customerForm, note: e.target.value })}
                maxLength={500}
              />
            </div>
            {customerFormError !== null && (
              <p className="field__error" role="alert">
                {customerFormError}
              </p>
            )}
            <div className="btn-row">
              <button type="submit" className="btn btn--small" disabled={busyAction !== null}>
                {customerForm.mode === 'create' ? 'Lưu khách hàng' : 'Cập nhật khách hàng'}
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--small"
                onClick={() => {
                  setCustomerForm(null);
                  setCustomerFormError(null);
                }}
              >
                Hủy
              </button>
            </div>
          </form>
        )}

        {customers !== null && customers.length > 0 && (
          <div className="field">
            <label className="field__label" htmlFor="customer-search">
              Tìm khách hàng
            </label>
            <div className="btn-row">
              <input
                id="customer-search"
                type="search"
                value={customerSearch}
                onChange={(event) => setCustomerSearch(event.target.value)}
                placeholder="Tìm tên khách, người liên hệ, SĐT…"
                maxLength={120}
              />
              {customerSearch !== '' && (
                <button
                  type="button"
                  className="btn btn--ghost btn--small"
                  onClick={() => setCustomerSearch('')}
                >
                  Xóa tìm
                </button>
              )}
            </div>
          </div>
        )}

        {customers === null || customers.length === 0 ? (
          <EmptyState title="Chưa có khách hàng nào" />
        ) : displayedCustomers.length === 0 ? (
          <p className="field__hint" role="status">
            Không tìm thấy khách hàng khớp từ khóa.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Khách hàng</th>
                  <th scope="col">Liên hệ</th>
                  <th scope="col">Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {displayedCustomers.map((cust) => (
                  <tr key={cust.id}>
                    <td>
                      {cust.name}
                      <div className="field__hint">{cust.id}</div>
                    </td>
                    <td>
                      {cust.contact_name ?? '—'}
                      <div className="field__hint">{cust.phone ?? 'Chưa có SĐT'}</div>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn--ghost btn--small"
                        onClick={() => {
                          setCustomerFormError(null);
                          setCustomerForm({
                            mode: 'edit',
                            customerId: cust.id,
                            expectedUpdatedAt: cust.updated_at ?? '',
                            name: cust.name,
                            contactName: cust.contact_name ?? '',
                            phone: cust.phone ?? '',
                            address: cust.address ?? '',
                            note: cust.note ?? '',
                          });
                        }}
                      >
                        Sửa
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel" id="ops-draft" aria-labelledby="compose-heading">
        <h2 className="panel__title" id="compose-heading">
          Soạn báo giá
        </h2>

        <form onSubmit={(event) => void handleSubmit(event)} noValidate>
          <div className="field">
            <label className="field__label" htmlFor="customer">
              Khách hỏi hàng
            </label>
            <select
              id="customer"
              value={customerId}
              onChange={(event) => setCustomerId(event.target.value)}
            >
              <option value="">— Chọn khách —</option>
              {(customers ?? []).map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name}
                </option>
              ))}
            </select>
            {customers !== null && customers.length === 0 && (
              <p className="field__hint">Chưa có khách nào trong workspace này.</p>
            )}
          </div>

          <div className="field">
            <label className="field__label" htmlFor="reference">
              Mã báo giá
            </label>
            <input
              id="reference"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              maxLength={80}
              required
              placeholder="BG-0001"
            />
          </div>

          <fieldset className="fieldset-clean">
            <legend className="field__label">Mặt hàng trong báo giá</legend>
            {lines.map((line, index) => (
              <div key={index} className="line-composer-row">
                <div className="field field--grow">
                  <label className="field__label" htmlFor={`product-${index}`}>
                    Mặt hàng
                  </label>
                  <select
                    id={`product-${index}`}
                    value={line.productId}
                    onChange={(event) => updateLine(index, { productId: event.target.value })}
                  >
                    <option value="">— Chọn mặt hàng —</option>
                    {(products ?? []).map((product) => (
                      <option key={product.id} value={product.id}>
                        {product.name} ({product.unit})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field field--qty">
                  <label className="field__label" htmlFor={`quantity-${index}`}>
                    Số lượng
                  </label>
                  <input
                    id={`quantity-${index}`}
                    type="number"
                    min={1}
                    max={MAX_QUANTITY}
                    step={1}
                    // The draft is kept as text while the operator types and
                    // committed to a number only when it parses. A controlled
                    // numeric field stores 0 for an empty edit (`Number('')` is
                    // 0, which is finite), so the field snaps to "0" the moment
                    // it is cleared and a retyped "25" renders as "025".
                    value={quantityDrafts[index] ?? String(line.quantity)}
                    onChange={(event) => {
                      const typed = event.target.value;
                      setQuantityDrafts((current) => ({ ...current, [index]: typed }));
                      const parsed = Number(typed);
                      // Only a value the schema accepts is committed. The draft
                      // stays visible either way, so nothing is silently
                      // reverted: an edit the schema would refuse (a fraction, a
                      // zero, a partial `12e`) stays on screen and blocks the
                      // save until it is corrected. Committing the stale value
                      // while showing the typed one is the failure this avoids —
                      // the operator would save a quantity they never entered.
                      if (typed.trim() === '') {
                        updateLine(index, { quantity: 0 });
                        return;
                      }
                      if (Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_QUANTITY) {
                        updateLine(index, { quantity: parsed });
                      } else {
                        updateLine(index, { quantity: 0 });
                      }
                    }}
                    onBlur={() => {
                      // A partial quantity (`12e`, `-`) is not a value at all, so
                      // it is dropped on blur rather than left standing; a
                      // fraction is a real mistake, so it is kept on screen and
                      // named in the hint below rather than quietly reverted.
                      setQuantityDrafts((current) => {
                        const typed = current[index];
                        if (typed === undefined) return current;
                        const parsed = Number(typed);
                        const next = { ...current };
                        if (Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_QUANTITY) {
                          delete next[index];
                        }
                        return next;
                      });
                    }}
                  />
                </div>
                <button
                  type="button"
                  className="btn btn--secondary btn--small"
                  onClick={() => removeLine(index)}
                  aria-label={`Bỏ dòng ${index + 1}`}
                >
                  Bỏ
                </button>
              </div>
            ))}
            <button type="button" className="btn btn--secondary btn--small" onClick={addLine}>
              Thêm dòng
            </button>
          </fieldset>

          <div className="field">
            <label className="field__label" htmlFor="note">
              Ghi chú
            </label>
            <textarea
              id="note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={2000}
            />
          </div>

          {/*
            The preview total is labelled as prospective. §7's rule is that the
            stored subtotal is computed server-side from the catalog, so this
            number is a convenience and the saved value is authoritative.
          */}
          <p className="money money--total">
            Dự kiến: {formatVnd(previewTotal)}
            <span className="money__unit">đ</span>
          </p>

          {/*
            A disabled save button is the double-submit guard §5 asks for, and
            its label says why, so a greyed control is not the only signal.
          */}
          <button type="submit" className="btn" disabled={!canSave}>
            {saving ? 'Đang lưu…' : 'Lưu báo giá'}
          </button>
          {!canSave && !saving && (
            <p className="field__hint">
              {quantityHint ?? 'Chọn khách, nhập mã báo giá và ít nhất một mặt hàng để lưu.'}
            </p>
          )}

          {/*
            The form is never cleared on a refusal. §5 requires that, and it is
            why the error renders here while every field keeps what was typed.
          */}
          {saveError !== null && (
            <ErrorState title="Không lưu được báo giá">
              <p>{saveError}</p>
            </ErrorState>
          )}
        </form>
      </section>

      {saved !== null && (
        <section className="panel span-full" aria-labelledby="saved-heading">
          <h2 className="panel__title" id="saved-heading">
            Báo giá vừa lưu
          </h2>
          <SuccessState title={`Đã lưu báo giá ${saved.reference}`} />
          <div className="table-wrap">
            <table className="table table--spaced">
              <caption className="sr-only">
                Các dòng đã lưu, với đơn giá và thành tiền do máy chủ tính.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Mặt hàng</th>
                  <th scope="col" className="num">
                    Số lượng
                  </th>
                  <th scope="col" className="num">
                    Đơn giá
                  </th>
                  <th scope="col" className="num">
                    Thành tiền
                  </th>
                </tr>
              </thead>
              <tbody>
                {saved.lines.map((line, lineIndex) => (
                  <tr key={lineIndex}>
                    <td>{line.product_name}</td>
                    <td className="num">
                      {line.quantity} {line.unit}
                    </td>
                    <td className="num money">{formatVnd(line.unit_price_vnd)}</td>
                    <td className="num money">{formatVnd(line.line_total_vnd)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" colSpan={3}>
                    Tổng cộng
                  </th>
                  <td className="num money money--total">{formatVndWithUnit(saved.subtotal_vnd)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="field__hint">Cập nhật: {formatTimestamp(saved.updated_at)}</p>
        </section>
      )}

      <section className="panel span-full" aria-labelledby="drafts-heading">
        <h2 className="panel__title" id="drafts-heading">
          Báo giá đang soạn
        </h2>
        {drafts === null || drafts.length === 0 ? (
          <EmptyState title="Chưa có báo giá nào đang soạn" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <caption className="sr-only">Các báo giá nháp trong workspace này.</caption>
              <thead>
                <tr>
                  <th scope="col">Mã</th>
                  <th scope="col" className="num">
                    Tổng
                  </th>
                  <th scope="col">Cập nhật</th>
                </tr>
              </thead>
              <tbody>
                {drafts.map((draft) => (
                  <tr key={draft.id}>
                    <td>{draft.reference}</td>
                    <td className="num money">{formatVndWithUnit(draft.subtotal_vnd)}</td>
                    <td>{formatTimestamp(draft.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {opsNotice !== null && (
        <div className="span-full">
          <SuccessState title={opsNotice} />
        </div>
      )}
      {opsActionError !== null && (
        <div className="span-full">
          <ErrorState title="Không thực hiện được thao tác">
            <p>{opsActionError}</p>
          </ErrorState>
        </div>
      )}

      {/* Phase 2: Quote Chains & Immutable Revisions */}
      <section className="panel span-full" id="ops-chains" aria-labelledby="chains-heading">
        <h2 className="panel__title" id="chains-heading">
          Chuỗi Báo Giá &amp; Phiên Bản Bất Biến ({quoteChains.length})
        </h2>
        {quoteChains.length === 0 ? (
          <EmptyState title="Chưa có chuỗi báo giá nào" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
              <tr>
                <th scope="col">Mã báo giá / Khách</th>
                <th scope="col">Phiên bản</th>
                <th scope="col">Trạng thái</th>
                <th scope="col" className="num">Tổng cộng</th>
                <th scope="col">Thao tác</th>
              </tr>
            </thead>
            <tbody>
              {quoteChains.flatMap((chain) =>
                chain.revisions.map((rev) => (
                  <tr key={rev.id}>
                    <td>
                      <strong>{chain.reference}</strong> — {chain.customer_name}
                    </td>
                    <td>v{rev.revision_number}</td>
                    <td>
                      <span className={statusBadgeClass(rev.status)}>{rev.status}</span>
                    </td>
                    <td className="num money">{formatVndWithUnit(rev.total_vnd)}</td>
                    <td className="action-cluster">
                      {rev.status === 'draft' && (
                        <button
                          type="button"
                          className="btn btn--secondary btn--small"
                          disabled={busyAction !== null}
                          aria-busy={busyAction === `issue:${rev.id}`}
                          onClick={() =>
                            runAction(`issue:${rev.id}`, async (key) => {
                              await issueQuoteRevisionApi(workspaceId, rev.id, key);
                              return `Đã phát hành ${chain.reference} v${rev.revision_number}`;
                            })
                          }
                        >
                          {busyAction === `issue:${rev.id}` ? 'Đang phát hành…' : 'Phát hành'}
                        </button>
                      )}
                      {rev.status === 'issued' && (
                        <>
                          <button
                            type="button"
                            className="btn btn--small"
                            disabled={busyAction !== null}
                            aria-busy={busyAction === `accept:${rev.id}`}
                            onClick={() =>
                              runAction(`accept:${rev.id}`, async (key) => {
                                const res = await acceptQuoteRevisionApi(workspaceId, rev.id, key);
                                return `Khách đã chốt ${chain.reference} → Tạo đơn ${res.order.order_code}`;
                              })
                            }
                          >
                            {busyAction === `accept:${rev.id}` ? 'Đang chốt…' : 'Khách chốt → Tạo đơn'}
                          </button>
                          <button
                            type="button"
                            className="btn btn--secondary btn--small"
                            disabled={busyAction !== null}
                            aria-busy={busyAction === `revise:${rev.id}`}
                            onClick={() =>
                              runAction(`revise:${rev.id}`, async (key) => {
                                const res = await reviseIssuedQuoteApi(workspaceId, rev.id, key);
                                return `Đã tạo bản sửa v${res.revision.revision_number}`;
                              })
                            }
                          >
                            {busyAction === `revise:${rev.id}` ? 'Đang tạo…' : 'Sửa bản mới'}
                          </button>
                        </>
                      )}
                      <a
                        className="btn btn--secondary btn--small"
                        href={`/api/quote-revisions/print?workspace_id=${encodeURIComponent(workspaceId)}&revision_id=${encodeURIComponent(rev.id)}`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        In A4
                      </a>
                    </td>
                  </tr>
                )),
              )}
            </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Phase 2: Orders & Deposit Receipts */}
      <section className="panel" id="ops-orders" aria-labelledby="orders-heading">
        <h2 className="panel__title" id="orders-heading">
          Đơn Hàng &amp; Tiến Độ Đặt Cọc ({orders.length})
        </h2>
        {orders.length === 0 ? (
          <EmptyState title="Chưa có đơn hàng nào" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Mã đơn / Khách</th>
                  <th scope="col" className="num">Tổng đơn</th>
                  <th scope="col" className="num">Đã thu / Cọc yêu cầu</th>
                  <th scope="col">Trạng thái</th>
                </tr>
              </thead>
              <tbody>
                {orders.map((ord) => (
                  <tr key={ord.id}>
                    <td>
                      <strong>{ord.order_code}</strong>
                      <div className="field__hint">{ord.customer_name ?? ord.customer_id}</div>
                    </td>
                    <td className="num money">{formatVndWithUnit(ord.total_vnd)}</td>
                    <td className="num money">
                      {formatVndWithUnit(ord.collected_vnd)} / {formatVndWithUnit(ord.deposit_required_vnd)}
                    </td>
                    <td>
                      <span className={statusBadgeClass(ord.status)}>{ord.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="btn-row">
          <h3 className="section-subhead">
            Phiếu thu tiền ({receipts.length})
          </h3>
          {orders.length > 0 && !receiptFormOpen && (
            <button
              type="button"
              className="btn btn--secondary btn--small"
              onClick={() => {
                setReceiptFormError(null);
                setReceiptFormOrderId(orders[0]?.id ?? '');
                setReceiptFormOpen(true);
              }}
            >
              Ghi phiếu thu chờ
            </button>
          )}
        </div>

        {receiptFormOpen && (
          <form onSubmit={(event) => void handleReceiptFormSubmit(event)} noValidate>
            <div className="field">
              <label className="field__label" htmlFor="receipt-form-order">
                Đơn hàng
              </label>
              <select
                id="receipt-form-order"
                value={receiptFormOrderId}
                onChange={(e) => setReceiptFormOrderId(e.target.value)}
              >
                <option value="">Chọn đơn hàng…</option>
                {orders.map((ord) => (
                  <option key={ord.id} value={ord.id}>
                    {ord.order_code} — còn thu {formatVndWithUnit(ord.total_vnd - ord.collected_vnd)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label className="field__label" htmlFor="receipt-form-amount">
                Số tiền thu (đồng)
              </label>
              <input
                id="receipt-form-amount"
                type="text"
                inputMode="numeric"
                value={receiptFormAmount}
                onChange={(e) => setReceiptFormAmount(e.target.value)}
                placeholder="Ví dụ: 500000"
                maxLength={15}
                required
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="receipt-form-ref">
                Mã tham chiếu / sao kê
              </label>
              <input
                id="receipt-form-ref"
                type="text"
                value={receiptFormRef}
                onChange={(e) => setReceiptFormRef(e.target.value)}
                placeholder="Ví dụ: CK-VCB-001"
                maxLength={80}
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="receipt-form-note">
                Ghi chú phiếu thu
              </label>
              <input
                id="receipt-form-note"
                type="text"
                value={receiptFormNote}
                onChange={(e) => setReceiptFormNote(e.target.value)}
                maxLength={240}
              />
            </div>
            {receiptFormError !== null && (
              <p className="field__error" role="alert">
                {receiptFormError}
              </p>
            )}
            <div className="btn-row">
              <button type="submit" className="btn btn--small" disabled={busyAction !== null}>
                Lưu phiếu thu chờ
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--small"
                onClick={() => {
                  setReceiptFormOpen(false);
                  setReceiptFormError(null);
                }}
              >
                Hủy
              </button>
            </div>
          </form>
        )}

        {receipts.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Tham chiếu</th>
                  <th scope="col" className="num">Số tiền</th>
                  <th scope="col">Trạng thái</th>
                  <th scope="col">Thao tác</th>
                </tr>
              </thead>
              <tbody>
                {receipts.map((rc) => (
                  <tr key={rc.id}>
                    <td>
                      {rc.reference ?? rc.id}
                      {rc.void_reason && (
                        <div className="field__hint">Lý do hủy: {rc.void_reason}</div>
                      )}
                      {rc.reversal_reason && (
                        <div className="field__hint">Lý do đảo: {rc.reversal_reason}</div>
                      )}
                    </td>
                    <td className="num money">{formatVndWithUnit(rc.amount_vnd)}</td>
                    <td>
                      <span className={statusBadgeClass(rc.status)}>{rc.status}</span>
                    </td>
                    <td>
                      {rc.status === 'pending' && (
                        <div>
                          <div className="btn-row">
                            {canConfirmReceipts && (
                              <button
                                type="button"
                                className="btn btn--secondary btn--small"
                                disabled={busyAction !== null}
                                aria-busy={busyAction === `confirm-receipt:${rc.id}`}
                                onClick={() =>
                                  runAction(`confirm-receipt:${rc.id}`, async (key) => {
                                    await confirmReceiptApi(workspaceId, rc.id, key);
                                    return `Đã xác nhận phiếu thu ${rc.reference ?? rc.id}`;
                                  })
                                }
                              >
                                {busyAction === `confirm-receipt:${rc.id}`
                                  ? 'Đang xác nhận…'
                                  : 'Xác nhận thực thu'}
                              </button>
                            )}
                            {voidingReceiptId !== rc.id && (
                              <button
                                type="button"
                                className="btn btn--ghost btn--small"
                                disabled={busyAction !== null}
                                onClick={() => {
                                  setVoidingReceiptId(rc.id);
                                  setVoidReasonDraft('Hủy phiếu thu đang chờ xác nhận');
                                }}
                              >
                                Hủy phiếu chờ
                              </button>
                            )}
                          </div>
                          {voidingReceiptId === rc.id && (
                            <div className="field">
                              <input
                                type="text"
                                aria-label="Lý do hủy phiếu chờ"
                                value={voidReasonDraft}
                                onChange={(e) => setVoidReasonDraft(e.target.value)}
                                placeholder="Nhập lý do hủy phiếu chờ…"
                                maxLength={240}
                              />
                              <div className="btn-row">
                                <button
                                  type="button"
                                  className="btn btn--secondary btn--small"
                                  disabled={busyAction !== null || voidReasonDraft.trim() === ''}
                                  aria-busy={busyAction === `void-receipt:${rc.id}`}
                                  onClick={() =>
                                    runAction(`void-receipt:${rc.id}`, async (key) => {
                                      await voidReceiptApi(
                                        workspaceId,
                                        rc.id,
                                        voidReasonDraft.trim(),
                                        key,
                                      );
                                      setVoidingReceiptId(null);
                                      return `Đã hủy phiếu thu chờ ${rc.reference ?? rc.id}`;
                                    })
                                  }
                                >
                                  {busyAction === `void-receipt:${rc.id}`
                                    ? 'Đang hủy…'
                                    : 'Xác nhận hủy phiếu'}
                                </button>
                                <button
                                  type="button"
                                  className="btn btn--ghost btn--small"
                                  onClick={() => setVoidingReceiptId(null)}
                                >
                                  Đóng
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Phase 2: Deliveries & Follow-up Tasks */}
      <section className="panel" id="ops-deliveries" aria-labelledby="deliveries-heading">
        <h2 className="panel__title" id="deliveries-heading">
          Lịch Giao Hàng &amp; Nhắc Việc Chăm Sóc
        </h2>
        <h3 className="field__label">Lịch giao hàng ({deliveries.length})</h3>
        {deliveries.length === 0 ? (
          <p className="field__hint">Chưa có lịch giao hàng nào.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Đơn / Ngày giao</th>
                  <th scope="col">Phụ trách</th>
                  <th scope="col">Trạng thái</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((dlv) => (
                  <tr key={dlv.id}>
                    <td>
                      <strong>{dlv.order_code ?? dlv.order_id}</strong> ({dlv.scheduled_date})
                      {dlv.under_deposit_override === 1 && (
                        <div className="field__hint">Ngoại lệ chủ vườn duyệt: {dlv.override_reason}</div>
                      )}
                    </td>
                    <td>{dlv.assigned_to ?? 'Chưa gán'}</td>
                    <td>
                      <span className={statusBadgeClass(dlv.status)}>{dlv.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <h3 className="section-subhead">
          Nhắc việc chăm sóc ({tasks.length})
        </h3>
        {tasks.length === 0 ? (
          <p className="field__hint">Chưa có nhắc việc nào.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Nội dung</th>
                  <th scope="col">Hạn</th>
                  <th scope="col">Trạng thái</th>
                  <th scope="col">Xong</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((tsk) => (
                  <tr key={tsk.id}>
                    <td>
                      <strong>{tsk.customer_name ?? tsk.customer_id}</strong>: {tsk.note ?? tsk.task_kind}
                    </td>
                    <td>{tsk.due_date}</td>
                    <td>
                      <span className={statusBadgeClass(tsk.status)}>{tsk.status}</span>
                    </td>
                    <td>
                      {tsk.status === 'open' && (
                        <button
                          type="button"
                          className="btn btn--secondary btn--small"
                          disabled={busyAction !== null}
                          aria-busy={busyAction === `task-done:${tsk.id}`}
                          onClick={() =>
                            runAction(`task-done:${tsk.id}`, async (key) => {
                              await updateFollowUpTaskApi(workspaceId, tsk.id, 'completed', key);
                              return 'Đã hoàn thành nhắc việc.';
                            })
                          }
                        >
                          {busyAction === `task-done:${tsk.id}` ? 'Đang cập nhật…' : 'Hoàn tất'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
