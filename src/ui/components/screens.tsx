/**
 * The one flow phase 1 ships: read the catalog, compose a quote draft against
 * it, save it, and see it come back priced by the server.
 *
 * The line total shown while composing is a preview and is labelled as one. The
 * subtotal that counts is the one the save returns, because the server prices
 * every line from the catalog rather than from this form — a client total is
 * never trusted, even a correct-looking one.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  fetchCustomers,
  fetchProducts,
  fetchQuoteDrafts,
  saveQuoteDraft,
  type Customer,
  type Product,
  type QuoteDraft,
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

export interface OpsScreenProps {
  workspaceId: string;
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

  return { products, customers, drafts, error, loading, reload };
}

export function OpsScreen({ workspaceId }: OpsScreenProps) {
  const { products, customers, drafts, error, loading, reload } =
    useWorkspaceData(workspaceId);

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

  const completeLines = lines.filter((line) => line.productId !== '' && line.quantity > 0);
  const canSave =
    customerId !== '' && reference.trim() !== '' && completeLines.length > 0 && !saving;

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
      <section className="panel" aria-labelledby="catalog-heading">
        <h2 className="panel__title" id="catalog-heading">
          Danh mục hàng
        </h2>
        {products === null || products.length === 0 ? (
          <EmptyState title="Chưa có mặt hàng nào" />
        ) : (
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
              </tr>
            </thead>
            <tbody>
              {products.map((product) => (
                <tr key={product.id}>
                  <td>
                    {product.name}
                    <div className="field__hint">{product.unit}</div>
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
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="panel" aria-labelledby="compose-heading">
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

          <fieldset style={{ border: 'none', padding: 0, margin: '0 0 12px' }}>
            <legend className="field__label">Mặt hàng trong báo giá</legend>
            {lines.map((line, index) => (
              <div key={index} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 8 }}>
                <div className="field" style={{ flex: 1, marginBottom: 0 }}>
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
                <div className="field" style={{ width: 92, marginBottom: 0 }}>
                  <label className="field__label" htmlFor={`quantity-${index}`}>
                    Số lượng
                  </label>
                  <input
                    id={`quantity-${index}`}
                    type="number"
                    min={1}
                    max={100000}
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
                      if (typed.trim() === '') {
                        // Keep the committed value out of the field's way so the
                        // operator can retype; the save stays blocked until a
                        // real quantity is present.
                        updateLine(index, { quantity: 0 });
                        return;
                      }
                      const parsed = Number(typed);
                      if (Number.isFinite(parsed) && Number.isInteger(parsed) && parsed > 0) {
                        updateLine(index, { quantity: parsed });
                      }
                    }}
                    onBlur={() => {
                      // A half-typed quantity ("2", "02", "-3") is not a value
                      // the schema accepts, so it is dropped on blur rather than
                      // carried into a save that the server would refuse.
                      setQuantityDrafts((current) => {
                        const next = { ...current };
                        delete next[index];
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
              Chọn khách, nhập mã báo giá và ít nhất một mặt hàng để lưu.
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
        <section className="panel" style={{ gridColumn: '1 / -1' }} aria-labelledby="saved-heading">
          <h2 className="panel__title" id="saved-heading">
            Báo giá vừa lưu
          </h2>
          <SuccessState title={`Đã lưu báo giá ${saved.reference}`} />
          <table className="table" style={{ marginTop: 12 }}>
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
                // Keyed on position, not on the product: the schema allows the
                // same product on two lines, so a product key collides and React
                // may drop or duplicate a row in the table the operator reads.
                // Position is stable here because a saved response is never
                // reordered or filtered.
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
          <p className="field__hint">Cập nhật: {formatTimestamp(saved.updated_at)}</p>
        </section>
      )}

      <section className="panel" style={{ gridColumn: '1 / -1' }} aria-labelledby="drafts-heading">
        <h2 className="panel__title" id="drafts-heading">
          Báo giá đang soạn
        </h2>
        {drafts === null || drafts.length === 0 ? (
          <EmptyState title="Chưa có báo giá nào đang soạn" />
        ) : (
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
        )}
      </section>
    </div>
  );
}
