import {
  memo, useEffect, useLayoutEffect, useRef, useState,
} from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type { GlobalState } from '../../global/types';

import { STRICTERDOM_ENABLED } from '../../config';
import { disableStrict, enableStrict } from '../../lib/fasterdom/stricterdom';
import { selectSharedSettings } from '../../global/selectors/sharedState';
import { animateEntrance } from '../../util/animations/gsapMotion';
import buildClassName from '../../util/buildClassName';
import { oldSetLanguage } from '../../util/oldLangProvider';
import { createStyledQrCode } from '../../util/qrCode/buildStyledQrCode';
import { LOCAL_TGS_URLS } from '../common/helpers/animatedAssets';
import { navigateBack } from './helpers/backNavigation';
import { getSuggestedLanguage } from './helpers/getSuggestedLanguage';

import useAsync from '../../hooks/useAsync';
import useFlag from '../../hooks/useFlag';
import useLang from '../../hooks/useLang';
import useLangString from '../../hooks/useLangString';
import useLastCallback from '../../hooks/useLastCallback';
import useMediaTransitionDeprecated from '../../hooks/useMediaTransitionDeprecated';
import useMultiaccountInfo from '../../hooks/useMultiaccountInfo';

import AnimatedIcon from '../common/AnimatedIcon';
import Button from '../ui/Button';
import Loading from '../ui/Loading';

type StateProps = {
  auth: GlobalState['auth'];
  connectionState: GlobalState['connectionState'];
  language?: string;
};

const QR_SIZE = 260;
const QR_PLANE_SIZE = 42;
const QR_IMAGE_SIZE_RATIO = 0.22;
const QR_CODE_MUTATION_DURATION = 150;
const DATA_PREFIX = 'tg://login?token=';

const AuthQrCode = ({
  auth,
  connectionState,
  language,
}: StateProps) => {
  const {
    returnToAuthPhoneNumber,
    setSharedSettingOption,
    loginWithPasskey,
  } = getActions();

  const { state, qrCode: authQrCode, passkeyOption } = auth;

  const suggestedLanguage = getSuggestedLanguage();
  const lang = useLang();
  const containerRef = useRef<HTMLDivElement>();
  const qrCodeRef = useRef<HTMLDivElement>();

  useEffect(() => animateEntrance(containerRef.current), []);

  const isConnected = connectionState === 'connectionStateReady';
  const continueText = useLangString('AuthContinueOnThisLanguage', suggestedLanguage);
  const [isLoading, markIsLoading, unmarkIsLoading] = useFlag();
  const [isQrMounted, markQrMounted, unmarkQrMounted] = useFlag();
  const [hasConnectionDelay, setHasConnectionDelay] = useState(false);

  useEffect(() => {
    setHasConnectionDelay(false);
    if (isConnected && isQrMounted) return undefined;
    const timeout = window.setTimeout(() => setHasConnectionDelay(true), 15000);
    return () => window.clearTimeout(timeout);
  }, [isConnected, isQrMounted]);

  const accountsInfo = useMultiaccountInfo();
  const hasActiveAccount = Object.values(accountsInfo).length > 0;

  const { result: qrCode } = useAsync(() => createStyledQrCode({
    size: QR_SIZE,
    imageSize: QR_IMAGE_SIZE_RATIO,
  }), []);

  const transitionClassNames = useMediaTransitionDeprecated(isQrMounted);

  useLayoutEffect(() => {
    if (!authQrCode || !qrCode) {
      return () => {
        unmarkQrMounted();
      };
    }

    if (!isConnected) {
      return undefined;
    }

    const container = qrCodeRef.current!;
    const data = `${DATA_PREFIX}${authQrCode.token}`;

    if (STRICTERDOM_ENABLED) {
      disableStrict();
    }

    qrCode.update({
      data,
    });

    if (!isQrMounted) {
      qrCode.append(container);
      markQrMounted();
    }

    if (STRICTERDOM_ENABLED) {
      window.setTimeout(() => {
        enableStrict();
      }, QR_CODE_MUTATION_DURATION);
    }

    return undefined;
  }, [isConnected, authQrCode, isQrMounted, qrCode]);

  const handleBackNavigation = useLastCallback(() => {
    navigateBack();
  });

  const handleLangChange = useLastCallback(() => {
    markIsLoading();

    void oldSetLanguage(suggestedLanguage, () => {
      unmarkIsLoading();

      setSharedSettingOption({ language: suggestedLanguage });
    });
  });

  const handleReturnToAuthPhoneNumber = useLastCallback(() => {
    returnToAuthPhoneNumber();
  });

  const handleLoginWithPasskey = useLastCallback(() => {
    loginWithPasskey();
  });

  const isAuthReady = state === 'authorizationStateWaitQrCode';

  return (
    <div id="auth-qr-form" ref={containerRef} className="custom-scroll">
      {hasActiveAccount && (
        <Button
          size="smaller"
          round
          color="translucent"
          className="auth-close"
          iconName="close"
          onClick={handleBackNavigation}
        />
      )}
      <div className="auth-form qr">
        <div className="qr-outer">
          <div
            className={buildClassName('qr-inner', transitionClassNames)}
            key="qr-inner"
          >
            <div
              key="qr-container"
              className="qr-container"
              ref={qrCodeRef}
            />
            <AnimatedIcon
              tgsUrl={LOCAL_TGS_URLS.QrPlane}
              size={QR_PLANE_SIZE}
              className="qr-plane"
              nonInteractive
              noLoop={false}
            />
          </div>
          {!isQrMounted && <div className="qr-loading"><Loading /></div>}
        </div>
        <h1>{lang('LoginQRTitle')}</h1>
        {!isQrMounted && (
          <p className="note" role="status" aria-live="polite">
            {lang(hasConnectionDelay ? 'RelayTgSlowConnection' : 'RelayTgConnecting')}
          </p>
        )}
        {hasConnectionDelay && !isQrMounted && (
          <Button className="auth-button" isText onClick={() => window.location.reload()}>
            {lang('RelayRetry')}
          </Button>
        )}
        <ol>
          <li><span>{lang('LoginQRHelp1')}</span></li>
          <li><span>{lang('LoginQRHelp2', undefined, { withNodes: true, withMarkdown: true })}</span></li>
          <li><span>{lang('LoginQRHelp3')}</span></li>
        </ol>
        {isAuthReady && (
          <Button className="auth-button" isText onClick={handleReturnToAuthPhoneNumber}>
            {lang('LoginQRCancel')}
          </Button>
        )}
        {passkeyOption && (
          <Button className="auth-button" isText onClick={handleLoginWithPasskey}>
            {lang('LoginPasskey')}
          </Button>
        )}
        {suggestedLanguage && suggestedLanguage !== language && continueText && (
          <Button className="auth-button" isText isLoading={isLoading} onClick={handleLangChange}>
            {continueText}
          </Button>
        )}
      </div>
    </div>
  );
};

export default memo(withGlobal(
  (global): Complete<StateProps> => {
    const {
      connectionState, auth,
    } = global;

    const { language } = selectSharedSettings(global);

    return {
      connectionState,
      auth,
      language,
    };
  },
)(AuthQrCode));
