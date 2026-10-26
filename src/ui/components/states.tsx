/**
 * The five states §5 requires, in one place.
 *
 * They exist as components rather than as inline conditionals in each screen
 * because the failure mode §5 is worried about is not a missing state — it is a
 * screen that renders a bare spinner, or nothing at all, while data loads. Every
 * state below states in words what is happening, so colour is a second signal
 * and never the only one.
 */

import type { ReactNode } from 'react';

interface StateProps {
  title: string;
  children?: ReactNode;
}

/** A state whose heading is optional, because a generic one reads fine. */
interface OptionalTitleProps {
  title?: string;
  children?: ReactNode;
}

export function LoadingState({ title = 'Đang tải…' }: OptionalTitleProps) {
  return (
    <div className="state" role="status" aria-live="polite">
      <p className="state__title">{title}</p>
      <p>Dữ liệu đang được tải từ máy chủ.</p>
    </div>
  );
}

/**
 * The empty state. Written as "no data yet" rather than "0", because §5 requires
 * a workspace with nothing in it to read differently from one holding a zero.
 */
export function EmptyState({ title, children }: StateProps) {
  return (
    <div className="state">
      <p className="state__title">{title}</p>
      <p>Chưa có dữ liệu trong workspace này.</p>
      {children}
    </div>
  );
}

export function ErrorState({ title, children }: StateProps) {
  // role="alert" so a refusal is announced rather than sitting silently on a
  // screen someone has already moved on from.
  return (
    <div className="state state--error" role="alert">
      <p className="state__title">{title}</p>
      {children}
    </div>
  );
}

export function SuccessState({ title, children }: StateProps) {
  return (
    <div className="state state--success" role="status">
      <p className="state__title">
        ✓ {title}
      </p>
      {children}
    </div>
  );
}

export function OfflineState({ title = 'Mất kết nối', children }: OptionalTitleProps) {
  return (
    <div className="state state--offline" role="status" aria-live="polite">
      <p className="state__title">⚠ {title}</p>
      <p>
        Không kết nối được với máy chủ. Nội dung bạn đã nhập vẫn còn nguyên —
        thử lại khi có mạng.
      </p>
      {children}
    </div>
  );
}

/** A banner announcing the demo environment, rendered once at the shell. */
export function DemoBanner({ label }: { label: string }) {
  return (
    <div className="banner" role="status">
      <span className="banner__icon" aria-hidden="true">
        ⚠
      </span>
      <span>
        <strong>MÔI TRƯỜNG DEMO</strong> — {label}
      </span>
    </div>
  );
}
