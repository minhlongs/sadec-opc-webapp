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

import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, fetchSession, type Session } from './api.ts';
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

const PREFERRED_WORKSPACE_STORAGE_KEY = 'sadec_preferred_workspace_id';

function readPreferredWorkspace(): string | null {
  try {
    return window.localStorage.getItem(PREFERRED_WORKSPACE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writePreferredWorkspace(workspaceId: string): void {
  try {
    window.localStorage.setItem(PREFERRED_WORKSPACE_STORAGE_KEY, workspaceId);
  } catch {
    // localStorage may be unavailable in restricted contexts; ignore safely.
  }
}

/** The display name of a workspace from the session's own list, else its id. */
function workspaceLabel(session: Session, workspaceId: string): string {
  const match = session.workspaces?.find((w) => w.workspaceId === workspaceId);
  return match && match.name.trim() !== '' ? match.name : workspaceId;
}

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
  // Switching: which workspace is being confirmed, and what the last switch said.
  const [switchingTo, setSwitchingTo] = useState<string | null>(null);
  const [switchNotice, setSwitchNotice] = useState<string | null>(null);
  // Why an agent action did nothing. A read that failed, a stale catalogue and
  // an empty one are three different answers; silently doing nothing would be a
  // fourth, and the least honest of them.
  const [agentNotice, setAgentNotice] = useState<string | null>(null);
  // Every session request carries a sequence number; a response that arrives
  // after a newer request was sent is dropped, so a slow answer for Vườn A
  // cannot land on a screen that has since switched to Vườn B.
  const requestSeq = useRef(0);

  /**
   * Adopts a session the server confirmed. This is the only place the active
   * workspace changes, and it runs only after the answer is in hand: nothing
   * about the UI moves on the click itself. Anything the previous workspace
   * left behind — a staged agent proposal, a confirmed one waiting to be
   * applied, the bridge's lot cache — is cleared here, because a proposal is
   * bound to the workspace and revision it was made against.
   */
  const adoptSession = (loaded: Session, requested: string | null) => {
    const previous = session?.workspaceId ?? null;
    if (previous !== null && previous !== loaded.workspaceId) {
      clearStagedProposal();
      setConfirmedProposal(null);
    }
    setSession(loaded);
    writePreferredWorkspace(loaded.workspaceId);
    initAgentBridge(loaded.workspaceId);
    if (requested !== null && requested !== loaded.workspaceId) {
      // The workspace asked for was not granted: the stored preference is
      // stale (membership revoked, or never held). Say so, and stay where the
      // server put us rather than pretend.
      setSwitchNotice(
        `Không còn quyền vào không gian ${workspaceLabel(loaded, requested)}; đang làm việc tại ${workspaceLabel(loaded, loaded.workspaceId)}.`,
      );
    } else {
      setSwitchNotice(null);
    }
  };

  const load = async (requestedWorkspaceId?: string | null) => {
    setError(null);
    const preferred =
      requestedWorkspaceId !== undefined ? requestedWorkspaceId : readPreferredWorkspace();
    const seq = ++requestSeq.current;
    try {
      const loaded = await fetchSession(preferred);
      if (seq !== requestSeq.current) return; // a newer request superseded this one
      adoptSession(loaded, preferred ?? null);
    } catch (thrown) {
      if (seq !== requestSeq.current) return;
      // A status of 0 is the client's own signal for a failed fetch, not a
      // server refusal. §5 asks for those to read differently: one means the
      // operator is out of range, the other means they are not signed in.
      if (thrown instanceof ApiError && thrown.status === 0) {
        setOffline(true);
        return;
      }
      setError(thrown instanceof Error ? thrown.message : 'Không xác định được phiên làm việc.');
    }
  };

  /**
   * Switches to a workspace from the session's own list. The selection is a
   * request; the server's answer is the switch. Until it arrives the current
   * workspace stays active and the control is disabled. If the server answers
   * with a different workspace, nothing is switched and the person is told.
   */
  const switchWorkspace = async (targetWorkspaceId: string) => {
    if (!session || targetWorkspaceId === session.workspaceId || switchingTo !== null) return;
    if (!session.workspaces?.some((w) => w.workspaceId === targetWorkspaceId)) return;
    setSwitchingTo(targetWorkspaceId);
    setSwitchNotice(null);
    const seq = ++requestSeq.current;
    try {
      const loaded = await fetchSession(targetWorkspaceId);
      if (seq !== requestSeq.current) return;
      if (loaded.workspaceId !== targetWorkspaceId) {
        // Refused or remapped: keep the current session; report; refresh the
        // list from the answer so a revoked workspace disappears from it.
        setSession((current) =>
          current ? { ...current, workspaces: loaded.workspaces ?? current.workspaces } : current,
        );
        setSwitchNotice(
          `Máy chủ không xác nhận quyền vào ${workspaceLabel(session, targetWorkspaceId)}; vẫn ở ${workspaceLabel(session, session.workspaceId)}.`,
        );
        return;
      }
      adoptSession(loaded, targetWorkspaceId);
    } catch (thrown) {
      if (seq !== requestSeq.current) return;
      if (thrown instanceof ApiError && thrown.status === 0) {
        setSwitchNotice('Mất kết nối khi đổi không gian; vẫn ở không gian hiện tại.');
        return;
      }
      setSwitchNotice(
        thrown instanceof Error ? `Không đổi được không gian: ${thrown.message}` : 'Không đổi được không gian.',
      );
    } finally {
      if (seq === requestSeq.current) setSwitchingTo(null);
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
    setAgentNotice(null);
    const bridge = initAgentBridge(session?.workspaceId);
    const result = await bridge.listSupplyLots();
    // Three outcomes, three behaviours. No lots published or an unavailable
    // catalogue both leave nothing to propose, and acting on a stale list would
    // stage an offer against a revision the server may already have refused.
    if (result.status === 'UNAVAILABLE') {
      setAgentNotice(result.message ?? 'Không tải được danh mục để đề xuất.');
      return;
    }
    if (result.status === 'STALE') {
      setAgentNotice(result.message ?? 'Danh mục đang là bản cũ; hãy tải lại trước khi đề xuất.');
      return;
    }
    const first = result.lots[0];
    if (!first) {
      setAgentNotice('Chưa có lô hoa nào được niêm yết để đề xuất.');
      return;
    }
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
    // Only workspaces the server listed for this caller appear; the palette
    // never offers an action the server would refuse.
    for (const ws of session?.workspaces ?? []) {
      if (ws.workspaceId === session?.workspaceId) continue;
      items.push({
        id: `switch-workspace-${ws.workspaceId}`,
        label: `Chuyển sang không gian: ${ws.name} (${ws.workspaceId})`,
        hint: 'Multi-Workspace',
        run: () => {
          void switchWorkspace(ws.workspaceId);
        },
      });
    }
    return items;
  }, [globalAgentJsonLdView, session?.workspaceId, session?.workspaces, switchingTo]);

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
            {(session.workspaces?.length ?? 0) > 1 && (
              <label className="topbar__switch">
                <span className="sr-only">Đổi vườn</span>
                <select
                  aria-label="Đổi vườn"
                  className="topbar__select"
                  value={switchingTo ?? session.workspaceId}
                  disabled={switchingTo !== null}
                  aria-busy={switchingTo !== null}
                  onChange={(e) => {
                    void switchWorkspace(e.target.value);
                  }}
                >
                  {session.workspaces?.map((ws) => (
                    <option key={ws.workspaceId} value={ws.workspaceId}>
                      {ws.name} ({ws.workspaceId}) — {ROLE_LABELS[ws.role]}
                    </option>
                  ))}
                </select>
                {switchingTo !== null && <span className="field__hint">Đang xác nhận…</span>}
              </label>
            )}
            <span className="role">{ROLE_LABELS[session.role]}</span>
          </p>
        )}
      </header>

      {agentNotice !== null && (
        <div className="notice notice--warning" role="status">
          <span>{agentNotice}</span>
          <button
            type="button"
            className="btn btn--secondary btn--small"
            onClick={() => setAgentNotice(null)}
          >
            Đã hiểu
          </button>
        </div>
      )}

      {switchNotice !== null && (
        <div className="notice notice--warning" role="status">
          <span>{switchNotice}</span>
          <button
            type="button"
            className="btn btn--secondary btn--small"
            onClick={() => setSwitchNotice(null)}
          >
            Đã hiểu
          </button>
        </div>
      )}

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

            {/* Keyed by workspace: a switch unmounts every screen's state —
                forms, caches, half-typed bookings — rather than carrying it
                into a workspace it was not made in. */}
            <div key={session.workspaceId} className="app__screens">
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
              <FounderScreen workspaceId={session.workspaceId} workspaces={session.workspaces ?? []} />
            )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
