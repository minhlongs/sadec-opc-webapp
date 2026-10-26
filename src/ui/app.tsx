/**
 * The app shell.
 *
 * Three things live here rather than in a screen. The DEMO banner is global
 * state rendered once, so §5's "continuous label" is a property of the shell
 * rather than something each page has to remember. The session is fetched once
 * and its workspace is what every screen scopes to, so no screen chooses one.
 * And the five failure states resolve here, because a session that cannot be
 * established is a session no screen can serve.
 */

import { useEffect, useMemo, useState } from 'react';
import { fetchSession, type Session } from './api.ts';
import {
  clearStagedProposal,
  getStagedProposal,
  initAgentBridge,
  subscribeProposals,
  type BookingProposal,
} from './agent-bridge.ts';
import { DemoBanner, ErrorState, LoadingState, OfflineState } from './components/states.tsx';
import { OpsScreen } from './components/screens.tsx';
import { FounderScreen } from './components/founder-screen.tsx';
import { AgentProposalHud, B2bMarketplace } from './components/b2b-marketplace.tsx';
import { HubDispatch } from './components/hub-dispatch.tsx';
import { InspectionSettlement } from './components/inspection-settlement.tsx';
import { PilotDashboard } from './components/pilot-dashboard.tsx';
import { MarketingLanding } from './components/marketing-landing.tsx';
import { MarketingGtmHub } from './components/marketing-gtm-hub.tsx';
import { CommandPalette, type CommandPaletteAction } from './components/command-palette.tsx';

/** The role as a Vietnamese phrase, so a session is labelled in words. */
const ROLE_LABELS: Readonly<Record<Session['role'], string>> = {
  founder_admin: 'Sáng lập',
  workspace_owner: 'Chủ vườn',
  workspace_operator: 'Nhân viên',
};

type AppTab =
  | 'marketing_landing'
  | 'b2b_marketplace'
  | 'hub_dispatch'
  | 'inspection_settlement'
  | 'pilot_dashboard'
  | 'nursery_ops'
  | 'founder_area'
  | 'cmo_gtm_hub';

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [activeTab, setActiveTab] = useState<AppTab>('nursery_ops');
  const [cmdOpen, setCmdOpen] = useState(false);
  const [globalAgentJsonLdView, setGlobalAgentJsonLdView] = useState(false);
  const [stagedProposal, setStagedProposal] = useState<BookingProposal | null>(() =>
    getStagedProposal(),
  );
  const [confirmedProposal, setConfirmedProposal] = useState<BookingProposal | null>(
    null,
  );

  const load = async () => {
    setError(null);
    try {
      const loaded = await fetchSession();
      setSession(loaded);
      initAgentBridge(loaded.workspaceId);
    } catch (thrown) {
      // A status of 0 is the client's own signal for a failed fetch, not a
      // server refusal. §5 asks for those to read differently: one means the
      // operator is out of range, the other means they are not signed in.
      if (thrown instanceof Error && 'status' in thrown && thrown.status === 0) {
        setOffline(true);
        return;
      }
      setError(thrown instanceof Error ? thrown.message : 'Không xác định được phiên làm việc.');
    }
  };

  useEffect(() => {
    initAgentBridge();
  }, []);

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    return subscribeProposals((proposal) => {
      setStagedProposal(proposal);
    });
  }, []);

  const runSampleAgentProposal = async () => {
    setActiveTab('b2b_marketplace');
    const bridge = initAgentBridge(session?.workspaceId);
    const lots = await bridge.listSupplyLots();
    const first = lots[0];
    if (!first) return;
    bridge.proposeBooking({
      lotId: first.id,
      quantity: first.moq_units,
      expectedRevision: first.revision,
    });
  };

  const commandActions = useMemo<readonly CommandPaletteAction[]>(() => {
    const items: CommandPaletteAction[] = [
      {
        id: 'tab-marketing-landing',
        label: 'Chuyển tới: Giới Thiệu & Máy Tính Giá Gốc Escrow',
        hint: 'Marketing & ROI',
        run: () => setActiveTab('marketing_landing'),
      },
      {
        id: 'tab-cmo-gtm-hub',
        label: 'Chuyển tới: CMO & Field SDR Hub (1-Click Copy)',
        hint: 'Vũ khí GTM',
        run: () => setActiveTab('cmo_gtm_hub'),
      },
      {
        id: 'tab-b2b-marketplace',
        label: 'Chuyển tới: Chợ Sỉ Hoa Kiểng B2B',
        hint: 'Phân hệ 1',
        run: () => setActiveTab('b2b_marketplace'),
      },
      {
        id: 'tab-hub-dispatch',
        label: 'Chuyển tới: Điều Phối Hub Sa Đéc',
        hint: 'Phân hệ 2',
        run: () => setActiveTab('hub_dispatch'),
      },
      {
        id: 'tab-inspection-settlement',
        label: 'Chuyển tới: Nghiệm Thu & Đối Soát',
        hint: 'Phân hệ 3',
        run: () => setActiveTab('inspection_settlement'),
      },
      {
        id: 'tab-pilot-dashboard',
        label: 'Chuyển tới: Chỉ Số Pilot 3–6 Tháng',
        hint: 'Phân hệ 4',
        run: () => setActiveTab('pilot_dashboard'),
      },
      {
        id: 'tab-nursery-ops',
        label: 'Chuyển tới: Báo Giá Nhà Vườn',
        hint: 'Phân hệ 5',
        run: () => setActiveTab('nursery_ops'),
      },
      {
        id: 'tab-founder-area',
        label: 'Chuyển tới: Sáng Lập (Phỏng vấn & OPC)',
        hint: 'Phân hệ 6',
        run: () => setActiveTab('founder_area'),
      },
      {
        id: 'toggle-agent-jsonld',
        label: globalAgentJsonLdView
          ? 'Tắt Agent JSON-LD View toàn cục'
          : 'Bật Agent JSON-LD View toàn cục',
        hint: 'Schema.org',
        run: () => {
          setGlobalAgentJsonLdView((prev) => !prev);
          setActiveTab('b2b_marketplace');
        },
      },
      {
        id: 'sample-agent-proposal',
        label: 'Thử đề xuất Agent mẫu',
        hint: 'WebMCP Co-Pilot',
        run: () => {
          void runSampleAgentProposal();
        },
      },
      {
        id: 'open-llms-txt',
        label: 'Mở /llms.txt (Tài liệu khám phá cho LLM)',
        hint: 'Tab mới',
        run: () => {
          window.open('/llms.txt', '_blank', 'noopener,noreferrer');
        },
      },
      {
        id: 'open-api-schema',
        label: 'Mở /api/schema (JSON-LD & WebMCP Schema)',
        hint: 'Tab mới',
        run: () => {
          window.open('/api/schema', '_blank', 'noopener,noreferrer');
        },
      },
    ];
    return items;
  }, [globalAgentJsonLdView, session?.workspaceId]);

  return (
    <div className="app">
      <a href="#main-content" className="skip-link">
        Chuyển đến nội dung chính
      </a>

      {/* The demo banner is rendered by the shell, not by a page, so a demo
          session cannot be drawn without it. */}
      {session?.demo === true && session.demoLabel !== null && (
        <DemoBanner label={session.demoLabel} />
      )}

      <header className="topbar">
        <h1 className="topbar__title">Sa Đéc Flow</h1>

        <button
          type="button"
          className="btn btn--secondary btn--small"
          onClick={() => setCmdOpen(true)}
        >
          ⌘ Lệnh nhanh
        </button>

        {session !== null && (
          <p className="topbar__session">
            {/* The identity is named, not just its role. §5 asks an operator to
                see which identity they are acting as, because someone who
                believes they are the owner while acting as an operator has
                tested the wrong thing. */}
            <span>{session.displayName ?? session.email ?? session.accessSubject}</span>
            {/* The workspace id is an identifier, not a phrase, so it is shown
                as stored — but the label naming it is Vietnamese-first. */}
            <span>Không gian: {session.workspaceId}</span>
            <span className="role">{ROLE_LABELS[session.role]}</span>
          </p>
        )}
      </header>

      <CommandPalette
        open={cmdOpen}
        onClose={() => setCmdOpen(false)}
        onToggle={() => setCmdOpen((prev) => !prev)}
        actions={commandActions}
      />

      <main className="app__main" id="main-content">
        {/* §5: an offline operator keeps what is on screen. The banner says the
            connection is gone without replacing the form underneath it. */}
        {offline && <OfflineState />}

        {session === null && error === null && !offline && (
          <LoadingState title="Đang xác định phiên làm việc…" />
        )}

        {error !== null && (
          <ErrorState title="Không vào được làm việc">
            <p>{error}</p>
            <button type="button" className="btn btn--secondary" onClick={() => void load()}>
              Thử lại
            </button>
          </ErrorState>
        )}

        {session !== null && (
          <>
            <nav aria-label="Điều hướng phân hệ" className="subnav">
              <div className="subnav__cluster">
                <span className="subnav__group-label">Nhà vườn</span>
                <button
                  type="button"
                  className={`btn btn--small ${activeTab === 'nursery_ops' ? '' : 'btn--secondary'}`}
                  onClick={() => setActiveTab('nursery_ops')}
                >
                  Báo Giá Nhà Vườn
                </button>
              </div>

              <div className="subnav__cluster">
                <span className="subnav__group-label">Tăng trưởng &amp; GTM</span>
                <button
                  type="button"
                  className={`btn btn--small ${activeTab === 'marketing_landing' ? '' : 'btn--secondary'}`}
                  onClick={() => setActiveTab('marketing_landing')}
                >
                  Giới Thiệu &amp; Máy Tính Giá Gốc
                </button>
                <button
                  type="button"
                  className={`btn btn--small ${activeTab === 'cmo_gtm_hub' ? '' : 'btn--secondary'}`}
                  onClick={() => setActiveTab('cmo_gtm_hub')}
                >
                  CMO &amp; GTM Hub
                </button>
              </div>

              <div className="subnav__cluster">
                <span className="subnav__group-label">Sàn B2B &amp; Hub</span>
                <button
                  type="button"
                  className={`btn btn--small ${activeTab === 'b2b_marketplace' ? '' : 'btn--secondary'}`}
                  onClick={() => setActiveTab('b2b_marketplace')}
                >
                  Chợ Sỉ Hoa Kiểng B2B
                </button>
                <button
                  type="button"
                  className={`btn btn--small ${activeTab === 'hub_dispatch' ? '' : 'btn--secondary'}`}
                  onClick={() => setActiveTab('hub_dispatch')}
                >
                  Điều Phối Hub Sa Đéc
                </button>
                <button
                  type="button"
                  className={`btn btn--small ${activeTab === 'inspection_settlement' ? '' : 'btn--secondary'}`}
                  onClick={() => setActiveTab('inspection_settlement')}
                >
                  Nghiệm Thu &amp; Đối Soát
                </button>
              </div>

              {session.role === 'founder_admin' && (
                <div className="subnav__cluster">
                  <span className="subnav__group-label">Quản trị OPC</span>
                  <button
                    type="button"
                    className={`btn btn--small ${activeTab === 'pilot_dashboard' ? '' : 'btn--secondary'}`}
                    onClick={() => setActiveTab('pilot_dashboard')}
                  >
                    Chỉ Số Pilot 3–6 Tháng
                  </button>
                  <button
                    type="button"
                    className={`btn btn--small ${activeTab === 'founder_area' ? '' : 'btn--secondary'}`}
                    onClick={() => setActiveTab('founder_area')}
                  >
                    Sáng Lập (Phỏng vấn &amp; OPC)
                  </button>
                </div>
              )}
            </nav>

            {activeTab === 'marketing_landing' && (
              <MarketingLanding
                onOpenMarketplace={() => setActiveTab('b2b_marketplace')}
                onOpenGtmHub={() => setActiveTab('cmo_gtm_hub')}
              />
            )}
            {activeTab === 'cmo_gtm_hub' && <MarketingGtmHub />}
            {activeTab === 'b2b_marketplace' && (
              <>
                <AgentProposalHud
                  proposal={stagedProposal}
                  onConfirm={(proposal) => setConfirmedProposal(proposal)}
                  onDismiss={() => clearStagedProposal()}
                />
                <B2bMarketplace
                  workspaceId={session.workspaceId}
                  role={session.role}
                  globalAgentJsonLdView={globalAgentJsonLdView}
                  externalHudRendered={true}
                  confirmedProposal={confirmedProposal}
                  onConsumeConfirmedProposal={() => setConfirmedProposal(null)}
                  onOpenRoiCalculator={() => setActiveTab('marketing_landing')}
                />
              </>
            )}
            {activeTab === 'hub_dispatch' && (
              <HubDispatch workspaceId={session.workspaceId} role={session.role} />
            )}
            {activeTab === 'inspection_settlement' && (
              <InspectionSettlement workspaceId={session.workspaceId} role={session.role} />
            )}
            {activeTab === 'pilot_dashboard' && session.role === 'founder_admin' && (
              <PilotDashboard workspaceId={session.workspaceId} />
            )}
            {activeTab === 'nursery_ops' && <OpsScreen workspaceId={session.workspaceId} />}
            {activeTab === 'founder_area' && session.role === 'founder_admin' && (
              <FounderScreen workspaceId={session.workspaceId} />
            )}
          </>
        )}
      </main>
    </div>
  );
}
