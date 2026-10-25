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

import { useEffect, useState } from 'react';
import { fetchSession, type Session } from './api.ts';
import { DemoBanner, ErrorState, LoadingState, OfflineState } from './components/states.tsx';
import { OpsScreen } from './components/screens.tsx';
import { B2bMarketplace } from './components/b2b-marketplace.tsx';
import { HubDispatch } from './components/hub-dispatch.tsx';
import { InspectionSettlement } from './components/inspection-settlement.tsx';
import { PilotDashboard } from './components/pilot-dashboard.tsx';

/** The role as a Vietnamese phrase, so a session is labelled in words. */
const ROLE_LABELS: Readonly<Record<Session['role'], string>> = {
  founder_admin: 'Sáng lập',
  workspace_owner: 'Chủ vườn',
  workspace_operator: 'Nhân viên',
};

type AppTab =
  | 'b2b_marketplace'
  | 'hub_dispatch'
  | 'inspection_settlement'
  | 'pilot_dashboard'
  | 'nursery_ops';

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [activeTab, setActiveTab] = useState<AppTab>('nursery_ops');

  const load = async () => {
    setError(null);
    try {
      setSession(await fetchSession());
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
    void load();
  }, []);

  return (
    <div className="app">
      {/* The demo banner is rendered by the shell, not by a page, so a demo
          session cannot be drawn without it. */}
      {session?.demo === true && session.demoLabel !== null && (
        <DemoBanner label={session.demoLabel} />
      )}

      <header className="topbar">
        <h1 className="topbar__title">Sa Đéc Flow</h1>
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

      <main className="app__main">
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
            <nav aria-label="Điều hướng phân hệ" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
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
                Nghiệm Thu & Đối Soát
              </button>
              {session.role === 'founder_admin' && (
                <button
                  type="button"
                  className={`btn btn--small ${activeTab === 'pilot_dashboard' ? '' : 'btn--secondary'}`}
                  onClick={() => setActiveTab('pilot_dashboard')}
                >
                  Chỉ Số Pilot 3–6 Tháng
                </button>
              )}
              <button
                type="button"
                className={`btn btn--small ${activeTab === 'nursery_ops' ? '' : 'btn--secondary'}`}
                onClick={() => setActiveTab('nursery_ops')}
              >
                Báo Giá Nhà Vườn
              </button>
            </nav>

            {activeTab === 'b2b_marketplace' && (
              <B2bMarketplace workspaceId={session.workspaceId} role={session.role} />
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
          </>
        )}
      </main>
    </div>
  );
}
