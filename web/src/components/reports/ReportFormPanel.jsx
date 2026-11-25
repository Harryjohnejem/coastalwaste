import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthStore } from '../../stores/useAuthStore';
import { notice } from '../../stores/useNoticeStore';
import usePageVisible from '../../hooks/usePageVisible';
import { loadReportData, openTodayReportForm } from '../../lib/openTodayReportForm';
import { nextReportNumber } from '../../lib/reportForm';
import ReportFormTables from './ReportFormTables';

/** Every record is read, so this refreshes less often than the KPI cards. */
const REFRESH_MS = 20000;

/**
 * The monitoring report on the Main Dashboard as tables: the same numbers as
 * Reports & Analytics → Export PDF (All Dates, All Cameras). "Print / Save as
 * PDF" opens the official printable form with the same Report No.
 */
export default function ReportFormPanel() {
  const user = useAuthStore((s) => s.user);
  const who = user?.name || user?.email || 'Administrator';
  const visible = usePageVisible();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [reportNumber] = useState(() => nextReportNumber());
  const busy = useRef(false);

  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      setData(await loadReportData(who));
      setError('');
    } catch {
      setError('Could not refresh the report. Showing the last numbers.');
    } finally {
      busy.current = false;
    }
  }, [who]);

  useEffect(() => {
    if (!visible) return undefined;
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [visible, load]);

  const print = () => {
    openTodayReportForm(who, reportNumber).catch((err) => notice.error('Report form not opened', err?.message || 'Please try again.'));
  };

  return (
    <section className="tr-card rf-panel">
      <header className="tr-card-head">
        <div>
          <h3>Monitoring report</h3>
          <p>All dates · all cameras · same as Reports &amp; Analytics. Updates every 20 s.</p>
        </div>
        <button type="button" className="tr-btn is-ghost tr-btn-icon" disabled={!data} onClick={print}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
            <path d="M6 14h12v7H6z" />
          </svg>
          Print / Save as PDF
        </button>
      </header>
      {error && data ? <p className="rf-msg is-error">{error}</p> : null}
      {!data ? (
        <p className="rf-msg">
          {error || (
            <>
              <span className="tr-spinner" aria-hidden="true" /> Loading the report…
            </>
          )}
        </p>
      ) : (
        <ReportFormTables data={data} reportNumber={reportNumber} />
      )}
    </section>
  );
}
