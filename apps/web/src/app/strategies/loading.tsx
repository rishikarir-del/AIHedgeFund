import type { ReactElement } from 'react';

/** Section 18.4 requires an explicit loading state rather than a blank screen. */
export default function Loading(): ReactElement {
  return (
    <div className="state-machine" aria-busy="true" aria-live="polite">
      Loading strategies…
    </div>
  );
}
