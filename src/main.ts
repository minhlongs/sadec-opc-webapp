/*
 * Phase 0 scaffold only. The shell, the two areas and the Vietnamese typography
 * from §5 all land in phase 1; this exists so the build pipeline is provable
 * before any screen is drawn on top of it.
 */
const root = document.querySelector('#root');
if (root === null) {
  throw new Error('The app root element is missing from the document.');
}
root.textContent = 'Sa Đéc Flow';
