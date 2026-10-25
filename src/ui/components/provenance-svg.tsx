export interface ProvenanceSvgProps {
  variant?: 'clean' | 'sketch';
}

/**
 * Inline SVG Provenance & Escrow Flow diagram (3 QR checkpoints + Zero-Outlay Escrow).
 * Supports Clean and Sketch rendering modes.
 */
export function ProvenanceSvg({ variant = 'clean' }: ProvenanceSvgProps) {
  const isSketch = variant === 'sketch';
  const strokeDash = isSketch ? '6 4' : undefined;
  const fontFamily = isSketch
    ? 'ui-rounded, "Comic Sans MS", cursive'
    : 'var(--font)';

  return (
    <svg
      viewBox="0 0 1000 320"
      role="img"
      aria-label="Sơ đồ truy xuất QR và dòng tiền Escrow"
      className={`svg-flow ${isSketch ? 'svg-flow--sketch' : ''}`}
      style={{ fontFamily }}
    >
      <defs>
        <marker
          id="escrow-arrow"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M 0 1 L 9 5 L 0 9 z" fill="#0f4a38" />
        </marker>
        <filter id="sketchy" x="-2%" y="-2%" width="104%" height="104%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.02"
            numOctaves={2}
            result="noise"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="noise"
            scale={isSketch ? 1.6 : 0}
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
      </defs>

      {/* Background canvas */}
      <rect
        x="4"
        y="4"
        width="992"
        height="312"
        rx="12"
        fill="#f6f5f0"
        stroke="#b4b2a4"
        strokeWidth="1.5"
        strokeDasharray={strokeDash}
      />

      {/* Invariant Banner */}
      <g transform="translate(180, 16)">
        <rect
          x="0"
          y="0"
          width="640"
          height="38"
          rx="19"
          fill="#e6efea"
          stroke="#0f4a38"
          strokeWidth="2"
          strokeDasharray={strokeDash}
        />
        <text
          x="320"
          y="24"
          textAnchor="middle"
          fill="#0f4a38"
          fontSize="14"
          fontWeight="700"
        >
          Sàn ứng vốn 0đ — Vườn chịu 100% rủi ro chất lượng
        </text>
      </g>

      {/* Station 1 — Vườn Sa Đéc (LOT) */}
      <g transform="translate(28, 74)">
        <rect
          x="0"
          y="0"
          width="280"
          height="186"
          rx="10"
          fill="#ffffff"
          stroke="#0f4a38"
          strokeWidth="2"
          strokeDasharray={strokeDash}
        />
        <rect
          x="14"
          y="14"
          width="96"
          height="24"
          rx="12"
          fill="#e6efea"
        />
        <text x="62" y="30" textAnchor="middle" fill="#0f4a38" fontSize="11" fontWeight="700">
          CHỐT 1 • LOT
        </text>
        <text x="14" y="60" fill="#1a1a1a" fontSize="15" fontWeight="700">
          Station 1 — Vườn Sa Đéc (LOT)
        </text>
        <text x="14" y="88" fill="#1a1a1a" fontSize="12.5">
          Nhà vườn Sa Đéc đăng ký lô hoa
        </text>
        <text x="14" y="110" fill="#1a1a1a" fontSize="12.5">
          Cấp mã QR HMAC-SHA256 SDECQR
        </text>
        <text x="14" y="136" fill="#4a504c" fontSize="11.5">
          • Cam kết quy cách nụ, chiều cao, tán
        </text>
        <text x="14" y="156" fill="#4a504c" fontSize="11.5">
          • Niêm yết công khai 0% PII
        </text>
      </g>

      {/* Connector 1 -> 2 */}
      <line
        x1="312"
        y1="167"
        x2="354"
        y2="167"
        stroke="#0f4a38"
        strokeWidth="2.5"
        strokeDasharray={strokeDash}
        markerEnd="url(#escrow-arrow)"
      />

      {/* Station 2 — Hub Cross-docking (PKG) */}
      <g transform="translate(360, 74)">
        <rect
          x="0"
          y="0"
          width="280"
          height="186"
          rx="10"
          fill="#ffffff"
          stroke="#0f4a38"
          strokeWidth="2"
          strokeDasharray={strokeDash}
        />
        <rect
          x="14"
          y="14"
          width="96"
          height="24"
          rx="12"
          fill="#e6efea"
        />
        <text x="62" y="30" textAnchor="middle" fill="#0f4a38" fontSize="11" fontWeight="700">
          CHỐT 2 • PKG
        </text>
        <text x="14" y="60" fill="#1a1a1a" fontSize="15" fontWeight="700">
          Station 2 — Hub Cross-docking
        </text>
        <text x="14" y="88" fill="#1a1a1a" fontSize="12.5">
          Chốt chặn 1: Kiểm định quy cách tại Hub
        </text>
        <text x="14" y="110" fill="#1a1a1a" fontSize="12.5">
          Niêm phong mã QR kiện hàng (PKG)
        </text>
        <text x="14" y="136" fill="#4a504c" fontSize="11.5">
          • Cọc VietQR 30–50% khóa trong Escrow
        </text>
        <text x="14" y="156" fill="#4a504c" fontSize="11.5">
          • Ghép chuyến xe tải đêm đi TP.HCM
        </text>
      </g>

      {/* Connector 2 -> 3 */}
      <line
        x1="644"
        y1="167"
        x2="686"
        y2="167"
        stroke="#0f4a38"
        strokeWidth="2.5"
        strokeDasharray={strokeDash}
        markerEnd="url(#escrow-arrow)"
      />

      {/* Station 3 — TP.HCM (BUYER_INSPECTED) */}
      <g transform="translate(692, 74)">
        <rect
          x="0"
          y="0"
          width="280"
          height="186"
          rx="10"
          fill="#ffffff"
          stroke="#0f4a38"
          strokeWidth="2"
          strokeDasharray={strokeDash}
        />
        <rect
          x="14"
          y="14"
          width="156"
          height="24"
          rx="12"
          fill="#e6efea"
        />
        <text x="92" y="30" textAnchor="middle" fill="#0f4a38" fontSize="11" fontWeight="700">
          CHỐT 3 • BUYER_INSPECTED
        </text>
        <text x="14" y="60" fill="#1a1a1a" fontSize="15" fontWeight="700">
          Station 3 — TP.HCM
        </text>
        <text x="14" y="88" fill="#1a1a1a" fontSize="12.5">
          Chốt chặn 2: Nghiệm thu • Giải ngân Escrow
        </text>
        <text x="14" y="110" fill="#0f4a38" fontSize="12.5" fontWeight="700">
          Phí sàn 2-5% • Nhà vườn nhận tiền
        </text>
        <text x="14" y="136" fill="#4a504c" fontSize="11.5">
          • Khấu trừ minh bạch nếu lỗi từ vườn
        </text>
        <text x="14" y="156" fill="#4a504c" fontSize="11.5">
          • Cân bằng sổ cái tuyệt đối (0đ Outlay)
        </text>
      </g>

      {/* Footer flow line */}
      <text
        x="500"
        y="292"
        textAnchor="middle"
        fill="#4a504c"
        fontSize="12"
        fontWeight="600"
      >
        VietQR EMVCo CRC16 • Truy xuất 3 trạm SDECQR • Bất biến dòng tiền: Thu Shop = Trả Vườn + Hoàn Shop + Phí Sàn
      </text>
    </svg>
  );
}
