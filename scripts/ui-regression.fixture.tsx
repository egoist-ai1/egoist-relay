/** @jsxImportSource @teact */
import { useState } from '../src/lib/teact/teact';
import TeactDOM from '../src/lib/teact/teact-dom';

import type { AppId, InstagramAppState, XAppState } from '../src/components/multi/AppSidebar';

import AppSidebar from '../src/components/multi/AppSidebar';
import Titlebar from '../src/components/common/Titlebar';
import useLang from '../src/hooks/useLang';
import { requestMutation } from '../src/lib/fasterdom/fasterdom';
import buildClassName from '../src/util/buildClassName';

import '../src/styles/index.scss';
import styles from '../src/components/App.module.scss';

type Model = {
  activeApp: AppId;
  xAppState: XAppState;
  instagramAppState: InstagramAppState;
  isNavigating?: boolean;
  notice?: string;
};

const initialModel: Model = {
  activeApp: 'telegram',
  xAppState: 'idle',
  instagramAppState: 'idle',
};

const harness = (window as any).__relayUiHarness = {
  actions: [] as string[],
  setModel: undefined as ((patch: Partial<Model>) => void) | undefined,
  reset: undefined as (() => void) | undefined,
  unmount: () => requestMutation(() => TeactDOM.render(undefined, document.getElementById('root')!)),
};

const Fixture = () => {
  const [model, setModel] = useState(initialModel);
  const lang = useLang();
  harness.setModel = (patch: Partial<Model>) => setModel((previous) => ({ ...previous, ...patch }));
  harness.reset = () => setModel(initialModel);

  function selectApp(app: AppId) {
    harness.actions.push(`select:${app}`);
    setModel((previous) => ({ ...previous, activeApp: app }));
  }

  function renderStatus(app: 'x' | 'instagram') {
    const state = app === 'x' ? model.xAppState : model.instagramAppState;
    if (state === 'ready') return undefined;
    const isAuthRequired = state === 'auth-required';
    const isError = state === 'error';
    const titleKey = isAuthRequired ? 'RelayXDirectLoginTitle'
      : app === 'x' ? isError ? 'RelayXErrorTitle' : 'RelayXLoadingTitle'
        : isError ? 'RelayInstagramErrorTitle' : 'RelayInstagramLoadingTitle';
    const textKey = isAuthRequired ? 'RelayXDirectLoginHelp'
      : app === 'x' ? isError ? 'RelayXErrorText' : 'RelayXLoadingText'
        : isError ? 'RelayInstagramErrorText' : 'RelayInstagramLoadingText';
    return (
      <div className={styles.xContentArea}>
        <div className={styles.xStatus} role={isError ? 'alert' : 'status'}>
          {!isAuthRequired && (
            <div className={buildClassName(styles.xStatusMark, isError && styles.xStatusMarkError)} aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                className={styles.xStatusIcon}
                fill={app === 'x' ? 'currentColor' : 'none'}
                stroke={app === 'instagram' ? 'currentColor' : undefined}
                strokeWidth={app === 'instagram' ? '2' : undefined}
                strokeLinecap={app === 'instagram' ? 'round' : undefined}
                strokeLinejoin={app === 'instagram' ? 'round' : undefined}
              >
                {app === 'x' ? (
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                ) : (
                  <>
                    <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
                    <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
                    <line x1="17.5" y1="6.5" x2="17.51" y2="6.5" strokeWidth="2.5" />
                  </>
                )}
              </svg>
              {!isError && <span className={styles.xSpinner} />}
            </div>
          )}
          <h1 className={styles.xStatusTitle}>{lang(titleKey)}</h1>
          <p className={styles.xStatusText}>{lang(textKey)}</p>
          {isAuthRequired && <p className={styles.xStatusText}>{lang('RelayXPasswordHelp')}</p>}
          {(isError || isAuthRequired) && (
            <button type="button" className={styles.xRetryButton} onClick={() => harness.actions.push(`retry:${app}`)}>
              {lang(isAuthRequired ? 'RelayXDirectLogin' : 'RelayRetry')}
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={styles.multiRoot}>
      <AppSidebar
        activeApp={model.activeApp}
        xAppState={model.xAppState}
        instagramAppState={model.instagramAppState}
        onSelectApp={selectApp}
      />
      <div className={styles.mainWorkspace}>
        <Titlebar
          activeApp={model.activeApp}
          isXAuthRequired={model.xAppState === 'auth-required'}
          canNavigate={model.activeApp === 'x' ? model.xAppState === 'ready' : model.instagramAppState === 'ready'}
          isNavigating={model.isNavigating}
          notice={model.notice}
          onLoginX={() => harness.actions.push('login:x')}
          onNavigate={(action) => harness.actions.push(`navigate:${action}`)}
        />
        {(['telegram', 'x', 'instagram'] as const).map((app) => (
          <div
            key={app}
            id={`relay-${app}-pane`}
            className={buildClassName(
              app === 'telegram' ? styles.telegramPane : app === 'x' ? styles.xPane : styles.instagramPane,
              styles.withTitlebar,
              model.activeApp !== app && styles.hidden,
            )}
            aria-hidden={model.activeApp !== app}
          >
            {app === 'telegram' ? <button type="button" id="telegram-test-control">Synthetic Telegram control</button>
              : renderStatus(app)}
          </div>
        ))}
      </div>
    </div>
  );
};

requestMutation(() => TeactDOM.render(<Fixture />, document.getElementById('root')!));
