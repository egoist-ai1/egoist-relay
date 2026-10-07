# UI evidence for Egoist Relay 1.4.7

The real app and existing UI fixtures ran in a fresh headless Edge process. Native calls used the existing mock transport; all external network requests were blocked. No live account or foreground application was controlled. Vite was restarted for final verification; source hashes remained unchanged during the final edge run.

Existing scenarios passed 7/7 before and 7/7 after: compact 800, small 640, FullHD 200% text, RTL, outside-focus containment, nested focus restoration, and disabled-first focus fallback. See existing-scenarios-before.json and existing-scenarios-after.json. Final screenshots are in ui-visuals/.

Confirmed defects and results:

- Long modal titles wrapped into several individually truncated lines and consumed the dialog header at 400 px / 200% text. Titles now stay on one line and plain text titles expose a tooltip. The final compact screenshot was inspected after this correction.

- Closing the child dialog cleared body.has-open-dialog while its parent remained open. Both modal implementations now use one idempotent shared ownership counter. The final probe keeps bodyFlag=true with one open parent.
- Modals still moved with prefers-reduced-motion enabled, and their closing lifecycle lasted 350 ms while visual transitions lasted at most 200 ms. Reduced-motion transitions now report 0 s; the normal lifecycle matches 200 ms. At 230 ms no closing modal remains in either mode.
- At viewport 400 × 448 and text size 200%, the 560 px minimum width placed the modal from x=-80 to x=480. The minimum width now respects the viewport; final bounds are x=48 to x=352. See small-scaled-baseline.png and small-scaled-final.png.
- Legacy dialog roots had no aria-modal or relation to their visible title. Titled modals now expose both; custom headers can provide ariaLabel.

edge-final.json records seven explicit passing checks and SHA-256 of the verified production sources, including the parent-owned useShowTransition cancellation fix. Targeted ESLint passed; targeted Stylelint reported zero errors and four existing type-selector warnings.

This evidence verifies synthetic layout and lifecycle behavior. It does not prove native Windows DPI behavior, live service DOM compatibility, GPU frame rate, or every application route.

The social enhancer harness initially passed 4/7: all three Instagram photo cases failed because an ordinary caption cross-link caused the share button to disappear. The parent corrected permalink selection to prefer a unique validated timestamp link. A fresh run passes 7/7, with unchanged source hashes throughout; see enhancer-before.json, enhancer-after.json and enhancer-source-hashes.json. Lifecycle intent uses mocked play/pause state and does not verify a real decoder.

The main release review board should include the UI changes above and the parent-owned Instagram permalink correction; no user response has been assumed or recorded.

A full cold-cache rerun passes 63 of 64 existing scenarios with zero failures; settings-ActiveWebsites is gated because the existing synthetic state resets that route. This verifies 37 rendered components from a source inventory of 774 and does not imply that every source component ran. See full-scenarios-after.json, full-coverage-manifest.json and full-ui-visuals/.

The initial mock-chat-hydration failure was caused by a cold Vite optimizer reload after useHistoryBack removed the fixture hash. The first document requested relay-ui.json, but the reloaded document captured an empty hash and loaded default.json. The mock scenario loader did not reject the fixture. The isolated audit HTML now restores its fixed relay-ui marker when missing. No production loader or routing behavior changed. See hydration-cold-baseline-trace.json and hydration-cold-after.json; the targeted cold run passes 1/1.

The existing performance harness passes 3/3: 48 sequential service switches (2314 ms), 24 modal lifecycle cycles with zero remaining open dialogs and restored outside focus, and reduced-motion after stress. No page errors, unhandled exceptions or recorded long tasks occurred. See performance-after.json, performance-source-hashes.json and fullhd-stress-final.png. Timings are observations on a shared headless host while the native release build was concurrent or recently active; they do not establish physical GPU performance or a 60 fps guarantee. The verified production hashes stayed unchanged during that run.