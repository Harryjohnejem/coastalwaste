import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { PAGE_SWITCH_MS, usePageSwitchStore } from '../../stores/usePageSwitchStore';
import { useNavStore } from '../../stores/useNavStore';
import { useTodayReportStore } from '../../stores/useTodayReportStore';

/** Full-screen loading screen shown for a moment before switching pages. */
export default function PageSwitchOverlay() {
  const pending = usePageSwitchStore((s) => s.pending);
  const clear = usePageSwitchStore((s) => s.clear);
  const setModule = useNavStore((s) => s.setModule);
  const navigate = useNavigate();

  useEffect(() => {
    if (!pending) return undefined;
    // Load the report while this screen shows, so the page opens with numbers.
    if (pending.to === '/today') useTodayReportStore.getState().prefetch();
    const id = setTimeout(() => {
      if (pending.module) setModule(pending.module);
      navigate(pending.to);
      clear();
    }, PAGE_SWITCH_MS);
    return () => clearTimeout(id);
  }, [pending, navigate, setModule, clear]);

  if (!pending) return null;

  return (
    <div className="page-switch" role="status" aria-live="polite">
      <div className="page-switch-box">
        <span className="page-switch-spinner" aria-hidden="true" />
        <span>{pending.label}</span>
      </div>
    </div>
  );
}
