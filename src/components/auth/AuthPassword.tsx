import { memo, useCallback, useEffect, useRef, useState } from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type { GlobalState } from '../../global/types';

import { animateEntrance } from '../../util/animations/gsapMotion';
import { pick } from '../../util/iteratees';

import useLang from '../../hooks/useLang';

import PasswordForm from '../common/PasswordForm';
import MonkeyPassword from '../common/PasswordMonkey';
import Button from '../ui/Button';

type StateProps = {
  auth: GlobalState['auth'];
};

const AuthPassword = ({
  auth,
}: StateProps) => {
  const { setAuthPassword, clearAuthErrorKey, returnToAuthPhoneNumber } = getActions();
  const { isLoading, errorKey, hint } = auth;

  const containerRef = useRef<HTMLDivElement>();
  const lang = useLang();
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => animateEntrance(containerRef.current), []);

  const handleChangePasswordVisibility = useCallback((isVisible) => {
    setShowPassword(isVisible);
  }, []);

  const handleSubmit = useCallback((password: string) => {
    setAuthPassword({ password });
  }, [setAuthPassword]);

  return (
    <div id="auth-password-form" className="custom-scroll">
      <div className="auth-form" ref={containerRef}>
        <MonkeyPassword isPasswordVisible={showPassword} />
        <h1>{lang('LoginHeaderPassword')}</h1>
        <p className="note">{lang('LoginEnterPasswordDescription')}</p>
        <PasswordForm
          onClearError={clearAuthErrorKey}
          error={errorKey && lang.withRegular(errorKey)}
          hint={hint}
          isLoading={isLoading}
          isPasswordVisible={showPassword}
          shouldShowSubmit
          submitLabel={lang('Next')}
          onChangePasswordVisibility={handleChangePasswordVisibility}
          onSubmit={handleSubmit}
        />
        {returnToAuthPhoneNumber && (
          <Button
            type="button"
            className="auth-button text"
            isText
            onClick={() => returnToAuthPhoneNumber()}
          >
            {lang('Back')}
          </Button>
        )}
      </div>
    </div>
  );
};

export default memo(withGlobal(
  (global): Complete<StateProps> => (
    pick(global, ['auth'])
  ),
)(AuthPassword));
