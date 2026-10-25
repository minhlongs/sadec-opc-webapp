import { useEffect, useMemo, useRef, useState } from 'react';

export interface CommandPaletteAction {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onToggle?: () => void;
  actions: readonly CommandPaletteAction[];
}

export function CommandPalette({
  open,
  onClose,
  onToggle,
  actions,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const filteredActions = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (normalized === '') return actions;
    return actions.filter(
      (action) =>
        action.label.toLowerCase().includes(normalized) ||
        (action.hint?.toLowerCase().includes(normalized) ?? false),
    );
  }, [actions, query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setSelectedIndex(0);
      const timer = window.setTimeout(() => {
        inputRef.current?.focus();
      }, 0);
      return () => window.clearTimeout(timer);
    }
    return undefined;
  }, [open]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        if (onToggle) {
          onToggle();
        } else if (open) {
          onClose();
        }
        return;
      }

      if (!open) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (filteredActions.length > 0) {
          setSelectedIndex((prev) => (prev + 1) % filteredActions.length);
        }
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (filteredActions.length > 0) {
          setSelectedIndex(
            (prev) => (prev - 1 + filteredActions.length) % filteredActions.length,
          );
        }
        return;
      }

      if (event.key === 'Enter' && filteredActions.length > 0) {
        const chosen = filteredActions[selectedIndex] ?? filteredActions[0];
        if (chosen !== undefined) {
          event.preventDefault();
          chosen.run();
          onClose();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose, onToggle, filteredActions, selectedIndex]);

  if (!open) {
    return null;
  }

  return (
    <div
      className="cmd-palette__backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="cmd-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Bảng lệnh nhanh Sa Đéc Flow"
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: 8,
          }}
        >
          <strong style={{ fontSize: 14, color: 'var(--primary-strong)' }}>
            ⌘ Bảng lệnh nhanh (Command Palette)
          </strong>
          <button
            type="button"
            className="btn btn--secondary btn--small"
            onClick={onClose}
          >
            Esc Đóng
          </button>
        </div>

        <input
          ref={inputRef}
          type="search"
          className="cmd-palette__input"
          placeholder="Nhập lệnh hoặc tên phân hệ (VD: Chợ sỉ, Hub, JSON-LD, Agent)..."
          aria-label="Tìm kiếm lệnh nhanh"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelectedIndex(0);
          }}
        />

        <ul className="cmd-palette__list" role="listbox" aria-label="Danh sách lệnh">
          {filteredActions.length === 0 ? (
            <li style={{ padding: '12px', color: 'var(--ink-muted)', fontSize: 14 }}>
              Không tìm thấy lệnh phù hợp.
            </li>
          ) : (
            filteredActions.map((action, index) => {
              const selected = index === selectedIndex;
              return (
                <li key={action.id} role="option" aria-selected={selected}>
                  <button
                    type="button"
                    className="cmd-palette__item"
                    aria-selected={selected}
                    onMouseEnter={() => setSelectedIndex(index)}
                    onClick={() => {
                      action.run();
                      onClose();
                    }}
                  >
                    <span>{action.label}</span>
                    {action.hint && (
                      <span className="field__hint" style={{ fontWeight: 500 }}>
                        {action.hint}
                      </span>
                    )}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
}
